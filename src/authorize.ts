import { createHmac, timingSafeEqual } from 'node:crypto';
import { approvalDigest, toCents, validMoney, type ApprovalTerms } from './policy.ts';

export type AuthRequest = {
  card_id: string;
  card_transaction_event_id: string;
  card_transaction_lifecycle_id?: string;
  transaction_type: string;
  transaction_amount: number;
  transaction_currency: string;
  merchant: { id?: string; name: string; category_code: string };
};

export type Decision = { response_status: 'AUTHORIZED' | 'DECLINED'; status_reason: string };

export type Approval = Readonly<{
  cardId: string;
  obligation: string;
  invoiceId: string;
  vendorId: string;
  merchantDescriptor: string;
  acceptorId: string | null;
  mcc: string;
  currency: string;
  amount: number;
  expiresAt: string;
  digest: string;
  // The ledger attempt this card pays for; null only where no durable ledger is involved.
  attempt: string | null;
}>;

// Card networks carry merchant names as at most 25 printable ASCII characters, padded with trailing underscores.
const NETWORK_NAME_LENGTH = 25;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const normalizeDescriptor = (name: string) =>
  name.replace(/_+$/, '').replace(/ +/g, ' ').trim().toUpperCase().slice(0, NETWORK_NAME_LENGTH).trimEnd();

// Anything outside printable ASCII is refused rather than folded, so lookalike glyphs can never become the real name.
export const sameMerchant = (received: string, approved: string) =>
  PRINTABLE_ASCII.test(received) && normalizeDescriptor(received) === normalizeDescriptor(approved);

function validApproval(a: Approval) {
  return (
    typeof a?.cardId === 'string' &&
    a.cardId.length > 0 &&
    typeof a.obligation === 'string' &&
    a.obligation.length > 0 &&
    validMoney(a.amount, a.currency) &&
    Number.isFinite(Date.parse(a.expiresAt)) &&
    typeof a.mcc === 'string' &&
    (a.acceptorId === null || (typeof a.acceptorId === 'string' && a.acceptorId.length > 0)) &&
    (a.attempt === null || (typeof a.attempt === 'string' && a.attempt.length > 0)) &&
    typeof a.merchantDescriptor === 'string' &&
    PRINTABLE_ASCII.test(a.merchantDescriptor) &&
    normalizeDescriptor(a.merchantDescriptor).length > 0
  );
}

// The gate enforces only what the approver signed: the digest is recomputed here, not trusted as a label.
export function approvalFor(cardId: string, terms: ApprovalTerms, digest: string, attempt: string | null = null): Approval {
  if (approvalDigest(terms) !== digest) throw new Error('APPROVAL_DIGEST_MISMATCH');
  const desc = terms.merchantDescriptor;
  if (typeof desc !== 'string' || !PRINTABLE_ASCII.test(desc) || !normalizeDescriptor(desc)) {
    throw new Error('INVALID_MERCHANT_DESCRIPTOR');
  }
  return Object.freeze({
    cardId,
    obligation: terms.obligation,
    invoiceId: terms.invoiceId,
    vendorId: terms.vendorId,
    merchantDescriptor: desc,
    acceptorId: terms.acceptorId,
    mcc: terms.mcc,
    currency: terms.currency,
    amount: terms.amount,
    expiresAt: terms.expiresAt,
    digest,
    attempt,
  });
}

const fingerprintOf = (req: AuthRequest) =>
  JSON.stringify([
    req?.card_id,
    req?.card_transaction_lifecycle_id,
    req?.transaction_type,
    req?.transaction_amount,
    req?.transaction_currency,
    req?.merchant?.id,
    req?.merchant?.name,
    req?.merchant?.category_code,
  ]);

const declined = (status_reason: string): Decision => ({ response_status: 'DECLINED', status_reason });

function isWellFormed(req: AuthRequest) {
  return (
    typeof req === 'object' &&
    req !== null &&
    typeof req.card_id === 'string' &&
    typeof req.card_transaction_event_id === 'string' &&
    req.card_transaction_event_id.length > 0 &&
    typeof req.transaction_type === 'string' &&
    typeof req.transaction_amount === 'number' &&
    Number.isFinite(req.transaction_amount) &&
    toCents(req.transaction_amount) > 0 &&
    // A sub-cent amount is not something a card network sends; rounding it could approve a different number.
    Math.abs(toCents(req.transaction_amount) - req.transaction_amount * 100) < 1e-6 &&
    typeof req.transaction_currency === 'string' &&
    typeof req.merchant === 'object' &&
    req.merchant !== null &&
    (req.merchant.id === undefined || typeof req.merchant.id === 'string') &&
    typeof req.merchant.name === 'string' &&
    typeof req.merchant.category_code === 'string'
  );
}

function decide(req: AuthRequest, approval: Approval | undefined, now: Date): Decision {
  if (!isWellFormed(req)) return declined('MALFORMED_REQUEST');
  if (req.transaction_type !== 'AUTHORIZATION' && req.transaction_type !== 'CLEARING') {
    return declined('UNSUPPORTED_TRANSACTION_TYPE');
  }
  if (!approval) return declined('UNKNOWN_CARD');
  if (now.getTime() > Date.parse(approval.expiresAt)) return declined('APPROVAL_EXPIRED');
  if (req.transaction_currency !== approval.currency) return declined('CURRENCY_MISMATCH');
  if (req.merchant.category_code !== approval.mcc) return declined('MCC_MISMATCH');
  if (approval.acceptorId !== null && req.merchant.id !== approval.acceptorId) return declined('MERCHANT_ID_MISMATCH');
  if (!sameMerchant(req.merchant.name, approval.merchantDescriptor)) return declined('MERCHANT_MISMATCH');
  if (toCents(req.transaction_amount) > toCents(approval.amount)) return declined('AMOUNT_EXCEEDS_APPROVAL');
  if (toCents(req.transaction_amount) < toCents(approval.amount)) return declined('AMOUNT_BELOW_APPROVAL');
  return { response_status: 'AUTHORIZED', status_reason: 'MATCHES_APPROVAL' };
}

// owns() asks the durable ledger at network time whether the card's attempt still holds its obligation, so a card
// whose attempt was reconciled away cannot be charged even by a process that is still running.
export function createApprovalStore(owns?: (obligation: string, attempt: string) => boolean) {
  const approvals = new Map<string, Approval>();
  // obligation -> the one charge it paid for, and whether that charge has settled; shared by every card armed for it
  const spent = new Map<string, { lifecycle: string; cleared: boolean }>();
  const answered = new Map<string, { decision: Decision; fingerprint: string }>();

  return {
    arm(approval: Approval) {
      if (!validApproval(approval)) throw new Error('INVALID_APPROVAL');
      approvals.set(approval.cardId, Object.freeze({ ...approval }));
    },
    disarm: (cardId: string) => void approvals.delete(cardId),
    get: (cardId: string) => approvals.get(cardId),
    authorize(req: AuthRequest, now = new Date()): Decision {
      // Duplicate deliveries are not documented by Airwallex; if one arrives it gets the same answer and spends nothing.
      const eventId = typeof req?.card_transaction_event_id === 'string' ? req.card_transaction_event_id : '';
      const fingerprint = fingerprintOf(req);
      const prior = answered.get(eventId);
      if (prior) return prior.fingerprint === fingerprint ? prior.decision : declined('EVENT_REPLAY_MISMATCH');
      const approval = approvals.get(req?.card_id);
      let decision = decide(req, approval, now);
      if (decision.response_status === 'AUTHORIZED' && approval && owns && !(approval.attempt && owns(approval.obligation, approval.attempt))) {
        decision = declined('RESERVATION_NOT_HELD');
      }
      if (decision.response_status === 'AUTHORIZED' && approval) {
        const lifecycle = req.card_transaction_lifecycle_id ?? eventId;
        const clearing = req.transaction_type === 'CLEARING';
        const paid = spent.get(approval.obligation);
        if (!paid) spent.set(approval.obligation, { lifecycle, cleared: clearing });
        // A single-message clearing for the approved charge is accepted once; anything else is a second spend.
        else if (clearing && !paid.cleared && paid.lifecycle === lifecycle) paid.cleared = true;
        else decision = declined('APPROVAL_ALREADY_USED');
      }
      if (eventId) answered.set(eventId, { decision, fingerprint });
      return decision;
    },
  };
}

export function verifySignature(secret: string, nonce: string, signature: string) {
  if (!secret || !nonce || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(nonce).digest('base64'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// x-nonce is "<epoch ms>.<random>"; Airwallex recommends checking the timestamp is recent.
export function nonceIsFresh(nonce: string, now = Date.now(), toleranceMs = 5 * 60_000) {
  const sentAt = Number(nonce.split('.')[0]);
  return Number.isInteger(sentAt) && Math.abs(now - sentAt) <= toleranceMs;
}
