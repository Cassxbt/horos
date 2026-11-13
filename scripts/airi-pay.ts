import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as awx from '../src/airwallex.ts';
import { LostOwnership, openLedger, type Ledger } from '../src/ledger.ts';
import { payableFor, recordImport, type Payable } from '../src/payable.ts';
import { approvalTerms, cardControls, toCents, type ApprovalBasis, type ApprovalTerms } from '../src/policy.ts';
import { settle } from '../src/settle.ts';
import { sourceBills } from '../src/t0.ts';
import { checkMandate, finalizeVic, type AiriMandate } from '../src/vic.ts';
import { policy } from '../src/demo-data.ts';

const USAGE = `usage (run from horos/ with --env-file=.env). --bill <t0-bill-id> selects an imported T:0 bill; without it the
built-in demo invoice is used.
  scripts/airi-pay.ts approve [--bill <id>] [--approve-as <name>]
      Shows exactly what would be approved. For a T:0 bill it records the approval only with --approve-as, and only if
      the queue says the bill is ready (its vendor and destination verified). Prints the mandate to create with airi-cli.
  scripts/airi-pay.ts pay <mandate-id> [--bill <id>]
      Reads the bill from T:0 again and checks it is still open, ready and unchanged since approval, checks the mandate
      against the approval, asks Airi for that mandate's one-time credential (the passkey approval happens here), then
      reads T:0 again before reserving and before confirming, and pays once.
  scripts/airi-pay.ts reconcile [--bill <id>]
      Settles an unknown or interrupted payment from Airwallex and delivers every result Airi is owed.`;

const DB_FILE = process.env.HOROS_DB ?? 'data/horos.db';
const CREDENTIAL_WAIT_MS = 330_000;
// What must remain of the mandate and the approval when the final check passes: the confirm call after it can take a
// login and the request itself, each bounded by Airwallex's 20-second request timeout.
const CONFIRM_MARGIN_MS = 60_000;

type AiriCredential = { number: string; cvv: string; expiryMonth: string; expiryYear: string; cardHolderName: string; protocolType: string; tokenType: string };

const airi = (args: string[], timeout?: number) => execFileSync('airi-cli', args, { encoding: 'utf8', timeout }).trim();

// Mandates are listed newest first, a page at a time.
function findMandate(mandateId: string) {
  for (let page = 0; page < 20; page++) {
    const r = JSON.parse(airi(['mandate', 'list', '--size', '100', '--page', String(page), '-o', 'json'])) as { items: AiriMandate[]; hasMore: boolean };
    const found = r.items.find((m) => m.mandateId === mandateId);
    if (found || !r.hasMore) return found;
  }
  return undefined;
}

// The credential comes from Airi for the mandate just validated, never from a file the caller hands in. It is read
// once, its file deleted whatever happens, and never printed.
function credentialFor(mandateId: string): AiriCredential {
  const dir = mkdtempSync(join(tmpdir(), 'horos-credential-'));
  try {
    const file = join(dir, 'credential.json');
    airi(['mandate', 'get-credential', '--mandate-id', mandateId, '--file', file], CREDENTIAL_WAIT_MS);
    return JSON.parse(readFileSync(file, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function save(record: Record<string, unknown>) {
  mkdirSync('runs', { recursive: true });
  const file = `runs/airi-payment-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  console.log(`saved ${file}`);
}

// Sends every result Airi is still owed, each on its own: one mandate's failure never blocks or erases another's.
// Results are queued by the ledger together with the outcome they report, so nothing here decides an outcome.
function flushReports(ledger: Ledger) {
  const sent: Record<string, string> = {};
  for (const r of ledger.pendingReports()) {
    const args = ['mandate', 'result', '--mandate-id', r.mandate_id, '--result', r.result];
    if (r.reason) args.push('--reason', r.reason);
    try {
      airi(args);
      ledger.markReport(r.mandate_id, 'REPORTED');
      sent[r.mandate_id] = 'REPORTED';
    } catch {
      ledger.markReport(r.mandate_id, 'REPORT_FAILED');
      sent[r.mandate_id] = 'REPORT_FAILED';
    }
  }
  return sent;
}

const PROPOSAL_TTL_MS = 30 * 60_000;

// Everything an approval for this payable must still match at the moment of payment.
// For a T:0 bill this includes the Airwallex account the credentials act for, read from Airwallex, not configuration.
let receivingAccount: { id: string; name: string } | null = null;
const basisOf = (p: Payable): ApprovalBasis => ({
  sourceVersion: p.sourceVersion,
  verificationId: p.verification?.id ?? null,
  destination: p.verification?.destination ?? null,
  paymentAccount: p.source === 'T0_BILL' ? (receivingAccount?.id ?? null) : null,
});

// Why this payable may not be paid on its saved approval right now, or undefined if it may.
// Once this attempt holds the reservation, the payable is busy by design; what still matters is the bill itself.
function blocker(p: Payable, terms: ApprovalTerms, reservedByUs = false) {
  const verdict = reservedByUs ? p.eligibility : p.action;
  if (verdict !== 'READY_FOR_APPROVAL') return `BILL_${verdict}`;
  if (p.source === 'T0_BILL' && !p.verification) return 'NO_VERIFIED_DESTINATION';
  const now = basisOf(p);
  const changed = (Object.keys(now) as (keyof ApprovalBasis)[]).filter((k) => terms[k] !== now[k]);
  return changed.length ? `APPROVAL_STALE:${changed.join(',')}` : undefined;
}

// Two steps, so the approver approves exactly what they read: a preview stores the proposed terms under a token, and
// --approve-as records that proposal only, if nothing it rests on changed meanwhile.
function approve(ledger: Ledger, p: Payable, approver?: string, token?: string) {
  const { invoice, vendor } = p;
  if (p.action !== 'READY_FOR_APPROVAL') {
    console.error(`not approvable: the queue says ${p.action} (${p.flags.map((f) => f.kind).join(', ') || 'no flags'})`);
    process.exit(1);
  }
  if (p.source === 'T0_BILL' && !p.verification) {
    console.error('not approvable: no person has verified a checkout destination for this bill (scripts/queue.ts verify)');
    process.exit(1);
  }
  if (p.source === 'DEMO_FIXTURE') {
    const terms = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy), policy);
    return record(ledger, p, terms, 'operator (simulated)');
  }
  if (approver) {
    const proposal = token && ledger.setting(`approval_proposal:${token}`);
    if (!proposal) {
      console.error('not recorded: --approve-as needs the --token printed by the preview you read');
      process.exit(1);
    }
    const { terms, at } = JSON.parse(proposal) as { terms: ApprovalTerms; at: number };
    const problem = Date.now() - at > PROPOSAL_TTL_MS ? 'PREVIEW_EXPIRED' : blocker(p, terms);
    if (problem) {
      console.error(`not recorded: ${problem}; run the preview again`);
      process.exit(1);
    }
    ledger.setSetting(`approval_proposal:${token}`, null);
    return record(ledger, p, terms, approver);
  }
  const terms = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy), policy, basisOf(p));
  const v = p.verification!;
  const preview = {
    entity: invoice.entityId,
    invoice: `${p.invoiceNumber} (T:0 bill ${invoice.id}, version ${p.sourceVersion})`,
    vendorRecord: `${vendor.id} (${vendor.name})`,
    destination: v.destination,
    destinationNote: 'team-controlled sandbox checkout standing in for the supplier; not the supplier itself',
    verifiedBy: `${v.by} at ${v.at}, on bill version ${v.billVersion}: ${v.evidence}`,
    receivedBy: `Airwallex account ${receivingAccount!.id} (${receivingAccount!.name}), read from the credentials that create the checkout`,
    amount: `${invoice.currency} ${invoice.amount.toFixed(2)}`,
    dueDate: invoice.dueDate,
    approvalExpires: terms.expiresAt,
    action: `One Visa Intelligent Commerce checkout of ${invoice.currency} ${invoice.amount.toFixed(2)} at ${v.destination} for invoice ${p.invoiceNumber}, once; no other rail may pay it.`,
  };
  const previewToken = randomUUID().slice(0, 8);
  ledger.setSetting(`approval_proposal:${previewToken}`, JSON.stringify({ terms, at: Date.now() }));
  console.log(JSON.stringify({ preview }, null, 2));
  console.log(`\npreview only: nothing approved. To approve exactly this: --approve-as <name> --token ${previewToken}`);
}

function record(ledger: Ledger, p: Payable, terms: ApprovalTerms, approver: string) {
  const { invoice, vendor, key } = p;
  ledger.open(key, toCents(invoice.amount), invoice.currency);
  const saved = ledger.saveApproval(terms, approver);
  const short = saved.digest.slice(0, 12);
  const url = terms.destination ?? `https://${vendor.portalDomain}`;
  console.log(JSON.stringify({ obligation: key, state: ledger.get(key)?.state, digest: saved.digest, approvedBy: saved.approvedBy, approvedAt: saved.approvedAt }, null, 2));
  console.log(`\nairi-cli mandate create --source Horos --payment-method-id <id> --merchant-name "${vendor.name}" \\
  --merchant-url "${url}" --merchant-country US --total-amount "${invoice.amount.toFixed(2)}" \\
  --currency ${invoice.currency} --item "name:Invoice ${p.invoiceNumber},unit_price:${invoice.amount.toFixed(2)},quantity:1" \\
  --description "Pay invoice ${p.invoiceNumber} to vendor ${vendor.id} ${vendor.name}, at the team-controlled sandbox checkout standing in for it. Approval digest ${short}"`);
}

async function pay(ledger: Ledger, mandateId: string, p: Payable) {
  const { key } = p;
  const approval = ledger.latestApproval(key);
  if (!approval) throw new Error('NO_APPROVAL: run `airi-pay.ts approve` first');
  // Everything charged below comes from the saved approval, never from the invoice record as it reads now.
  const { amount, currency, invoiceId } = approval.terms;
  const obligation = ledger.get(key);
  if (obligation?.amount_cents !== toCents(amount) || obligation.currency !== currency) throw new Error('APPROVAL_DOES_NOT_MATCH_OBLIGATION');
  const refuse = (refused: string, extra: Record<string, unknown> = {}) => {
    save({ at: new Date().toISOString(), obligation: key, mandateId, refused, ...extra });
    process.exit(1);
  };
  if (obligation.state !== 'OPEN') refuse(`OBLIGATION_${obligation.state}`, { hint: obligation.state === 'PAYMENT_UNKNOWN' ? 'run reconcile' : undefined });
  // The executor asks the queue itself, after reading the bill from T:0 again: the local queue is only as fresh as its
  // last import, and the bill may have been paid, withdrawn or changed there meanwhile, including during a passkey
  // wait of minutes. An approval made on an older version of the bill no longer counts. A source that cannot be read
  // stops the payment. This narrows the race with another payer to the moment of confirmation; closing it would need
  // a reservation the source system itself honours.
  const stillPayable = async (attempt?: string) => {
    if (p.source === 'T0_BILL') {
      try {
        recordImport(ledger, p.invoice.entityId, await sourceBills(p.invoice.entityId));
      } catch {
        return 'SOURCE_UNREADABLE';
      }
    }
    const now = payableFor(ledger, p.source === 'T0_BILL' ? p.invoice.id : undefined);
    const latest = ledger.latestApproval(key);
    if (!now) return 'BILL_GONE';
    if (latest?.digest !== approval.digest) return 'APPROVAL_REPLACED';
    return blocker(now, approval.terms, attempt !== undefined && ledger.owns(key, attempt));
  };
  const initial = await stillPayable();
  if (initial) refuse(initial, { flags: payableFor(ledger, p.source === 'T0_BILL' ? p.invoice.id : undefined)?.flags, hint: initial.startsWith('APPROVAL_STALE') ? 'approve the current version again' : undefined });
  if (ledger.mandateUsed(mandateId)) refuse('MANDATE_ALREADY_USED', { hint: 'create a new mandate for a new attempt' });

  const mandate = findMandate(mandateId);
  const mandateCheck = checkMandate(mandate, approval.terms, approval.digest);
  if (!mandateCheck.ok) refuse('MANDATE_DOES_NOT_MATCH_APPROVAL', { findings: mandateCheck.findings });
  let credential: AiriCredential;
  try {
    credential = credentialFor(mandateId);
  } catch (e) {
    return refuse('CREDENTIAL_NOT_ISSUED', { detail: (e as Error).message.split('\n')[0], hint: 'approve the passkey, then run pay again' });
  }

  const beforeReserve = await stillPayable();
  if (beforeReserve) return refuse(`ELIGIBILITY_CHANGED:${beforeReserve}`, { hint: 'the credential was not used; nothing was charged' });
  const attempt = ledger.reserve(key, 'VIC_CHECKOUT', approval.digest);
  if (!attempt) return refuse(`OBLIGATION_${ledger.get(key)?.state}`);
  // Each journal write needs the reservation, so an attempt reconciled away stops before its next side effect.
  const journal = (requestId: string, kind: string, externalId: string | null, status: string, detail: string | null = null) =>
    ledger.record(attempt, { request_id: requestId, obligation: key, rail: 'VIC_CHECKOUT', kind, external_id: externalId, status, detail });
  journal(`mandate:${attempt}`, 'MANDATE', mandateId, 'MATCHES_APPROVAL', approval.digest);

  const createId = randomUUID();
  const orderId = `${invoiceId}-${createId.slice(0, 8)}`;
  journal(createId, 'INTENT_CREATE', null, 'SENT', orderId);
  let intent: awx.PaymentIntent;
  try {
    intent = await awx.createPaymentIntent(amount, currency, orderId, createId);
  } catch (e) {
    // No intent id means nothing was charged: a card is only charged at confirm.
    ledger.transition(key, attempt, 'RESERVED', 'OPEN', `intent create failed: ${(e as Error).message}`);
    throw e;
  }
  journal(createId, 'INTENT_CREATE', intent.id, 'CREATED', orderId);

  // The last reversible point: the bill's eligibility may have changed while the intent was being created, and the
  // approval or the mandate may have expired, including during that last source read. Expiry is therefore checked
  // after the read returns, immediately before confirming, and must hold for as long as the confirm call can take. If
  // anything fails the intent is never confirmed; the finalizer cancels it below.
  const eligibilityNow = await stillPayable(attempt);
  const mandateNow = checkMandate(mandate, approval.terms, approval.digest, new Date(Date.now() + CONFIRM_MARGIN_MS));
  const stillValid = { ok: mandateNow.ok && !eligibilityNow, findings: [...mandateNow.findings, ...(eligibilityNow ? [`ELIGIBILITY_CHANGED:${eligibilityNow}`] : [])] };
  let confirmed: awx.PaymentIntent | undefined;
  let error: string | undefined;
  if (stillValid.ok) {
    const confirmId = randomUUID();
    journal(confirmId, 'CONFIRM', intent.id, 'SENT');
    try {
      confirmed = await awx.confirmPaymentIntent(
        intent.id,
        { number: credential.number, expiry_month: credential.expiryMonth, expiry_year: credential.expiryYear, cvc: credential.cvv, name: credential.cardHolderName },
        confirmId,
      );
    } catch (e) {
      error = (e as Error).message;
    }
    try {
      // The response itself is journaled, so recovery after a crash decides from the same evidence as this process.
      const response = confirmed && { id: confirmed.id, status: confirmed.status, amount: confirmed.amount, currency: confirmed.currency };
      journal(confirmId, 'CONFIRM', intent.id, confirmed?.status ?? 'NO_RESPONSE', JSON.stringify({ response, error }));
    } catch (e) {
      // The charge may already have happened; the outcome is decided below from the provider, not lost here.
      if (!(e instanceof LostOwnership)) throw e;
    }
  } else {
    error = `not confirmed: ${stillValid.findings.join(', ')}`;
  }
  let decided: { state: string; evidence: Record<string, unknown> & { remediation?: string } };
  try {
    decided = await finalizeVic(ledger, key, attempt, 'RESERVED', intent.id, confirmed);
  } catch (e) {
    if (!(e instanceof LostOwnership)) throw e;
    // Reconcile settled this attempt while it was confirming. Its outcome is this attempt's last history entry, never
    // whatever the obligation says now, which may already belong to a later attempt.
    const mine = ledger.history(key).filter((h) => h.attempt_id === attempt).at(-1);
    decided = { state: mine?.to_state ?? 'PAYMENT_UNKNOWN', evidence: { intentId: intent.id, note: 'settled by a concurrent reconcile', detail: mine?.detail } };
  }

  const record: Record<string, unknown> = {
    at: new Date().toISOString(),
    obligation: key,
    state: decided.state,
    approvalDigest: approval.digest,
    approvedBy: approval.approvedBy,
    mandate: { mandateId, checks: 'merchant portal and name, amount, currency, both expiries, VIC protocol and approval digest match the saved approval' },
    airi: { protocolType: credential.protocolType, tokenType: credential.tokenType },
    airwallex: { paymentIntentId: intent.id, merchantOrderId: intent.merchant_order_id, ...decided.evidence },
    error,
  };
  save(record);
  if (decided.state === 'PAYMENT_UNKNOWN') {
    console.error('payment outcome unknown: run `airi-pay.ts reconcile` before any other attempt');
    process.exit(3);
  }
  if (decided.state === 'EXCEPTION') {
    console.error(`payment exception: ${decided.evidence.remediation}`);
    process.exit(1);
  }
  const reports = flushReports(ledger);
  const reported = reports[mandateId] ?? ledger.report(mandateId)?.status ?? 'NOT_OWED';
  save({ ...record, airiReport: reported });
  process.exit(reported === 'REPORT_FAILED' ? 2 : decided.state === 'PAID' ? 0 : 1);
}

// Exit codes shared with `horos.ts reconcile`: 0 settled, 2 a report to Airi still failing, 3 still unresolved (no
// rail may pay), 4 a person must decide (an exception).
async function reconcile(ledger: Ledger, p: Payable) {
  const { key } = p;
  const settlement = await settle(ledger, key);
  const reports = flushReports(ledger);
  const state = ledger.get(key)?.state;
  save({ at: new Date().toISOString(), obligation: key, reconciledFrom: settlement.from, state, evidence: settlement.evidence, airiReports: reports });
  const failed = Object.values(reports).includes('REPORT_FAILED');
  process.exit(failed ? 2 : state === 'PAYMENT_UNKNOWN' || state === 'RESERVED' ? 3 : state === 'EXCEPTION' ? 4 : 0);
}

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
mkdirSync('data', { recursive: true });
const ledger = openLedger(DB_FILE);
const payable = payableFor(ledger, option('--bill'));
if (!payable) {
  console.error(`unknown bill ${option('--bill')}: import it with scripts/queue.ts import`);
  process.exit(1);
}
if (payable.source === 'T0_BILL' && (command === 'approve' || command === 'pay')) {
  receivingAccount = await awx.currentAccount().catch((e) => {
    console.error(`not previewed, approved or paid: ${(e as Error).message}`);
    return process.exit(1);
  });
}
if (command === 'approve') approve(ledger, payable, option('--approve-as'), option('--token'));
else if (command === 'pay' && args[0]?.startsWith('mdt_')) {
  await pay(ledger, args[0], payable).catch((e) => {
    if (!(e instanceof LostOwnership)) throw e;
    // Lost before confirm: no charge was attempted on this credential.
    save({ at: new Date().toISOString(), obligation: payable.key, mandateId: args[0], refused: 'RESERVATION_RELEASED_BEFORE_CONFIRM', state: ledger.get(payable.key)?.state });
    process.exit(1);
  });
} else if (command === 'reconcile') await reconcile(ledger, payable);
else {
  console.error(USAGE);
  process.exit(1);
}
