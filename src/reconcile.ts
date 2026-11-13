import { sameMerchant } from './authorize.ts';
import { toCents } from './policy.ts';

export type LedgerTransaction = {
  transaction_id: string;
  transaction_type: string;
  status: string;
  transaction_amount: number;
  transaction_currency: string;
  failure_reason?: string;
  card_transaction_data?: { card_transaction_id?: string; card_transaction_lifecycle_id?: string };
  merchant?: { name: string; category_code: string; identifier?: string };
  remote_auth?: { response_status: string; status_reason: string; default_action_used: boolean; timed_out: boolean; duration: number };
};

export type Expected = { lifecycleId: string; amount: number; currency: string; merchantDescriptor: string };

export type CardPaymentState =
  | { state: 'PAID'; clearedCents: number; transactionId: string; notes: string[] }
  | { state: 'EXCEPTION'; reason: string; clearedCents: number; remediation: string; notes: string[] }
  | { state: 'NOT_PAID'; reason: string; notes: string[] }
  | { state: 'PAYMENT_UNKNOWN'; reason: string; notes: string[] };

// What a person does next. Money has already moved in every case, so none of them is a retry.
const REMEDIATION: Record<string, string> = {
  CLEARING_OUTSIDE_APPROVED_LIFECYCLE: 'Freeze the card and dispute the unapproved clearing with the issuer.',
  CLEARED_IN_OTHER_CURRENCY: 'Hold the invoice; confirm the FX amount with the supplier before accepting it.',
  CLEARED_TO_OTHER_MERCHANT: 'Dispute the clearing: it was booked to a payee other than the approved supplier.',
  MULTIPLE_CLEARINGS: 'Hold the invoice; compare the clearings with the supplier statement and dispute any excess.',
  CLEARED_ABOVE_APPROVAL: 'Dispute the excess over the approved amount; the invoice stays open for review.',
  CLEARED_BELOW_APPROVAL: 'Record a partial payment; the balance needs a new approval, never a retry on this card.',
};

// Airwallex books a clearing as a negative amount in whole cents. A row that is missing, positive, or finer than a
// cent is not evidence of anything, so it can never support PAID.
const validDebit = (t: LedgerTransaction) =>
  typeof t.transaction_amount === 'number' &&
  Number.isFinite(t.transaction_amount) &&
  t.transaction_amount < 0 &&
  Math.abs(toCents(t.transaction_amount) - t.transaction_amount * 100) < 1e-6;

const exception = (reason: string, clearedCents: number, notes: string[]): CardPaymentState => ({
  state: 'EXCEPTION',
  reason,
  clearedCents,
  remediation: REMEDIATION[reason],
  notes,
});

// Dual-message clearing never passes through remote authorization, so the provider's ledger is the only proof of
// what actually settled. Paid means: exactly the approved lifecycle cleared, to the approved payee, for exactly the
// approved amount.
export function reconcileCardPayment(items: LedgerTransaction[], expected: Expected): CardPaymentState {
  const notes: string[] = [];
  const mine = items.filter((t) => t.card_transaction_data?.card_transaction_lifecycle_id === expected.lifecycleId);
  const clearings = items.filter((t) => t.transaction_type === 'CLEARING' && t.status === 'APPROVED');
  const cleared = clearings.filter((t) => mine.includes(t));
  const clearedCents = clearings.reduce((sum, t) => sum + Math.abs(toCents(t.transaction_amount)), 0);
  const want = toCents(expected.amount);

  if (clearings.some((t) => !validDebit(t))) {
    return { state: 'PAYMENT_UNKNOWN', reason: 'INVALID_SETTLEMENT_EVIDENCE', notes: clearings.filter((t) => !validDebit(t)).map((t) => `${t.transaction_id}: amount ${t.transaction_amount}`) };
  }

  if (clearings.length > cleared.length) return exception('CLEARING_OUTSIDE_APPROVED_LIFECYCLE', clearedCents, notes);
  if (cleared.some((t) => t.transaction_currency !== expected.currency)) return exception('CLEARED_IN_OTHER_CURRENCY', clearedCents, notes);
  if (cleared.some((t) => !sameMerchant(t.merchant?.name ?? '', expected.merchantDescriptor))) {
    return exception('CLEARED_TO_OTHER_MERCHANT', clearedCents, notes);
  }
  if (cleared.length > 1) return exception('MULTIPLE_CLEARINGS', clearedCents, notes);
  if (cleared.length === 1) {
    if (clearedCents > want) return exception('CLEARED_ABOVE_APPROVAL', clearedCents, notes);
    if (clearedCents < want) return exception('CLEARED_BELOW_APPROVAL', clearedCents, notes);
    // The sandbox books dual-message clearings under its own MCC; recorded for review, not treated as a payee change.
    const mcc = cleared[0].merchant?.category_code;
    if (mcc) notes.push(`clearing booked under MCC ${mcc}`);
    return { state: 'PAID', clearedCents, transactionId: cleared[0].transaction_id, notes };
  }
  if (mine.length && mine.every((t) => ['FAILED', 'REVERSED', 'DECLINED', 'EXPIRED'].includes(t.status))) {
    return { state: 'NOT_PAID', reason: mine.map((t) => t.status).join(','), notes };
  }
  return { state: 'PAYMENT_UNKNOWN', reason: mine.length ? `pending: ${mine.map((t) => t.status).join(',')}` : 'NO_LEDGER_RECORD', notes };
}
