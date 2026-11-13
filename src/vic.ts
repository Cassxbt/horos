import * as awx from './airwallex.ts';
import type { Ledger, ObligationState } from './ledger.ts';
import { checkPortal, normalizeName, toCents, validMoney, type ApprovalTerms } from './policy.ts';

export type AiriMandate = {
  mandateId: string;
  status: string;
  protocolType: string;
  expiresAt: string;
  merchantInfo: { name: string; url: string; country?: string };
  orderInfo: { currency: string; totalAmount: string; description: string };
};

// The passkey approved what the mandate says; pay only if that is exactly what the AP approval says.
export function checkMandate(mandate: AiriMandate | undefined, terms: ApprovalTerms, digest: string, now = new Date()) {
  if (!mandate) return { ok: false, findings: ['MANDATE_NOT_FOUND'] };
  const findings: string[] = [];
  if (!['AUTHENTICATED', 'READY'].includes(mandate.status)) findings.push(`MANDATE_STATUS_${mandate.status}`);
  if (mandate.protocolType !== 'VIC') findings.push('NOT_VIC');
  if (!(Date.parse(mandate.expiresAt) > now.getTime())) findings.push('MANDATE_EXPIRED');
  if (!(Date.parse(terms.expiresAt) > now.getTime())) findings.push('APPROVAL_EXPIRED');
  if (!checkPortal(mandate.merchantInfo?.url ?? '', terms).allowed) findings.push('MERCHANT_URL_NOT_APPROVED_PORTAL');
  // Where a person verified a full checkout address, the mandate must name exactly that address, path included.
  if (terms.destination && mandate.merchantInfo?.url !== terms.destination) findings.push('MERCHANT_URL_NOT_VERIFIED_DESTINATION');
  // A shared checkout host can serve several merchants, so the named merchant must be the approved supplier too.
  if (normalizeName(mandate.merchantInfo?.name ?? '') !== normalizeName(terms.vendorName)) findings.push('MERCHANT_NAME_NOT_APPROVED_SUPPLIER');
  if (mandate.orderInfo?.currency !== terms.currency) findings.push('CURRENCY_MISMATCH');
  // A plain decimal with at most two places: no rounding of "186.404", no exponents, no padding.
  const total = mandate.orderInfo?.totalAmount;
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(total ?? '') || toCents(Number(total)) !== toCents(terms.amount)) findings.push('AMOUNT_MISMATCH');
  if (!mandate.orderInfo?.description?.includes(digest.slice(0, 12))) findings.push('APPROVAL_DIGEST_NOT_IN_MANDATE');
  return { ok: findings.length === 0, findings };
}

const IN_PROGRESS = new Set(['PENDING', 'REQUIRES_CAPTURE', 'REQUIRES_CUSTOMER_ACTION']);

const REMEDIATION = {
  CHARGED_OTHER_AMOUNT: 'The checkout charged a different amount or currency: refund or dispute the difference; the invoice stays under review.',
  RESPONSES_DISAGREE: 'Airwallex returned conflicting results for this charge: confirm it in the Airwallex dashboard before closing the invoice.',
  MALFORMED_AMOUNT: 'Airwallex reported an amount that is not a whole-cent number: confirm the charge in the Airwallex dashboard before closing the invoice.',
};

type Seen = { id: string; status: string; amount: unknown; currency: unknown };

// The one place a VIC payment attempt is decided, for a fresh confirmation, for recovery and for a person's decision
// alike. The provider's read-back is the truth; a confirm response is only compared with it, and a contradiction either
// way is for a person. Anything not final is cancelled first, because Airwallex allows another confirmation on an
// intent that needs a payment method: OPEN means the provider shows this intent cancelled and nothing claimed it paid.
export async function decideVic(ledger: Ledger, key: string, intentId: string, confirmResponse?: awx.PaymentIntent) {
  const obligation = ledger.get(key)!;
  const expected = { amount: obligation.amount_cents / 100, currency: obligation.currency };
  const read = () => awx.getPaymentIntent(intentId).catch(() => undefined);
  let intent = await read();
  if (intent && intent.status !== 'SUCCEEDED' && intent.status !== 'CANCELLED') {
    await awx.cancelPaymentIntent(intentId, 'horos: payment attempt not completed').catch(() => undefined);
    intent = await read();
  }
  const pick = (i: awx.PaymentIntent): Seen => ({ id: i.id, status: i.status, amount: i.amount, currency: i.currency });
  const observed = intent && pick(intent);
  const reported = confirmResponse && pick(confirmResponse);
  // Provider money must be a number in whole cents before it can be compared at all.
  const wellFormed = (i: Seen) => typeof i.amount === 'number' && validMoney(i.amount, String(i.currency));
  const exact = (i: Seen) => i.id === intentId && wellFormed(i) && toCents(i.amount as number) === obligation.amount_cents && i.currency === obligation.currency;
  const reportedSucceeded = reported?.id === intentId && reported.status === 'SUCCEEDED';
  const reportedFailed = reported?.id === intentId && (reported.status === 'CANCELLED' || reported.status === 'REQUIRES_PAYMENT_METHOD');

  let to: ObligationState = 'PAYMENT_UNKNOWN';
  let remediation: string | undefined;
  if (observed?.id === intentId && observed.status === 'CANCELLED') {
    // A cancelled read-back reopens only if nothing claimed this attempt succeeded.
    if (reportedSucceeded) [to, remediation] = ['EXCEPTION', REMEDIATION.RESPONSES_DISAGREE];
    else to = 'OPEN';
  } else if (observed?.id === intentId && observed.status === 'SUCCEEDED') {
    // A confirmation known only by its status (no amount recorded) is compared on status alone.
    const sameCharge = (r: Seen) => (r.amount === undefined ? r.id === intentId : exact(r));
    const agree = !reported || (!reportedFailed && sameCharge(reported) && (reported.status === 'SUCCEEDED' || IN_PROGRESS.has(reported.status)));
    if (!wellFormed(observed)) [to, remediation] = ['EXCEPTION', REMEDIATION.MALFORMED_AMOUNT];
    else if (!exact(observed)) [to, remediation] = ['EXCEPTION', REMEDIATION.CHARGED_OTHER_AMOUNT];
    else if (!agree) [to, remediation] = ['EXCEPTION', REMEDIATION.RESPONSES_DISAGREE];
    else to = 'PAID';
  }
  return { to, observed, evidence: { intentId, expected, observed: observed ?? 'UNREADABLE', confirmResponse: reported, remediation } };
}

// Records the decision for an attempt the caller holds, with the Airi result its mandate is owed: SUCCEEDED when
// paid, DECLINED when the attempt was confirmed and then closed. An exception waits for a person's decision.
export async function finalizeVic(ledger: Ledger, key: string, attempt: string, from: ObligationState, intentId: string, confirmResponse?: awx.PaymentIntent) {
  const { to, observed, evidence } = await decideVic(ledger, key, intentId, confirmResponse);
  const ops = ledger.operations(key, attempt);
  const mandateId = ops.filter((o) => o.kind === 'MANDATE').at(-1)?.external_id;
  const confirmAttempted = ops.some((o) => o.kind === 'CONFIRM');
  const result = to === 'PAID' ? 'SUCCEEDED' : to === 'OPEN' && confirmAttempted ? 'DECLINED' : undefined;
  const report = mandateId && result ? { mandate_id: mandateId, result, reason: result === 'DECLINED' ? `payment intent ${observed?.status ?? 'not completed'}` : null } as const : undefined;
  if (to !== from) ledger.transition(key, attempt, from, to, JSON.stringify(evidence), report, { ref: intentId, observed });
  return { state: to, evidence };
}
