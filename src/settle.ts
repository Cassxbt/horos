import * as awx from './airwallex.ts';
import type { Ledger, Obligation, ObligationState, Operation } from './ledger.ts';
import { reconcileCardPayment } from './reconcile.ts';
import { decideVic, finalizeVic } from './vic.ts';

// An attempt with activity younger than this may still be running; reconciliation leaves it alone.
const STALE_MS = Number(process.env.HOROS_STALE_MS ?? 120_000);
// An empty nick-name lookup proves a lost card create never happened only after this long.
const CREATE_SETTLE_MS = Number(process.env.HOROS_CREATE_SETTLE_MS ?? 600_000);

export type Settlement = { obligation: string; from: ObligationState; to: ObligationState; evidence: unknown };

// Moves an obligation stuck in RESERVED or PAYMENT_UNKNOWN to what the provider says its current attempt did. It
// reopens only when the provider proves no money moved and nothing can still move it; anything less stays blocked.
export async function settle(ledger: Ledger, key: string, now = Date.now()): Promise<Settlement> {
  const obligation = ledger.get(key);
  if (!obligation) throw new Error(`UNKNOWN_OBLIGATION ${key}`);
  const from = obligation.state;
  const attempt = obligation.attempt_id;
  const result = (to: ObligationState, evidence: unknown): Settlement => {
    if (to !== from) ledger.transition(key, attempt!, from, to, JSON.stringify(evidence));
    return { obligation: key, from, to, evidence };
  };
  if ((from !== 'RESERVED' && from !== 'PAYMENT_UNKNOWN') || !attempt) return { obligation: key, from, to: from, evidence: 'NOTHING_TO_SETTLE' };
  const ops = ledger.operations(key, attempt);
  // Live from the moment of reservation, not from its first journal entry.
  const lastActivity = Math.max(Date.parse(obligation.reserved_at ?? obligation.updated_at), ...ops.map((o) => Date.parse(o.at)));
  if (from === 'RESERVED' && now - lastActivity < STALE_MS) return { obligation: key, from, to: from, evidence: 'IN_FLIGHT' };
  const latest = (kind: string) => ops.filter((o) => o.kind === kind).at(-1);

  if (obligation.rail === 'VIC_CHECKOUT') {
    const intentId = latest('INTENT_CREATE')?.external_id;
    // The card is charged only at confirm; confirm needs an intent id and a journal write this attempt can no
    // longer make once the obligation is reopened.
    if (!intentId) return result('OPEN', 'NO_INTENT_CREATED');
    const decided = await finalizeVic(ledger, key, attempt, from, intentId, journaledConfirm(ops, intentId));
    return { obligation: key, from, to: decided.state, evidence: decided.evidence };
  }

  if (obligation.rail === 'ISSUED_CARD') {
    const decided = await cardOutcome(ledger, obligation, ops, now);
    return result(decided.to, decided.evidence);
  }

  return { obligation: key, from, to: from, evidence: 'UNKNOWN_RAIL' };
}

// The confirmation an attempt already received, if any, is evidence too: a restart must not forget it. Without the
// full response, the journaled status alone still says what the provider answered.
function journaledConfirm(ops: Operation[], intentId: string) {
  const confirm = ops.filter((o) => o.kind === 'CONFIRM').at(-1);
  try {
    const response = confirm?.detail ? (JSON.parse(confirm.detail) as { response?: awx.PaymentIntent }).response : undefined;
    if (response) return response;
  } catch {
    // An unreadable journal entry falls back to its status.
  }
  return confirm && ['SUCCEEDED', 'CANCELLED', 'REQUIRES_PAYMENT_METHOD'].includes(confirm.status) ? ({ id: confirm.external_id ?? intentId, status: confirm.status } as awx.PaymentIntent) : undefined;
}

// What an issued card's attempt did, from the provider: PAID, EXCEPTION, OPEN only on positive evidence that nothing
// moved and nothing still can, PAYMENT_UNKNOWN otherwise.
async function cardOutcome(ledger: Ledger, obligation: Obligation, ops: Operation[], now: number): Promise<{ to: ObligationState; evidence: unknown }> {
  const latest = (kind: string) => ops.filter((o) => o.kind === kind).at(-1);
  const create = latest('CARD_CREATE');
  let cardId = create?.external_id ?? undefined;
  if (!cardId && create) {
    const found = await awx.cardsByNickName(awx.nickNameFor(create.request_id)).catch(() => undefined);
    if (!found) return { to: 'PAYMENT_UNKNOWN', evidence: 'CARD_LOOKUP_FAILED' };
    if (found.length === 0 && now - Date.parse(create.at) <= CREATE_SETTLE_MS) return { to: 'PAYMENT_UNKNOWN', evidence: 'CARD_CREATE_PENDING' };
    cardId = found[0]?.card_id;
  }
  if (!cardId) return { to: 'OPEN', evidence: 'NO_CARD_ISSUED' };
  await awx.closeCard(cardId).catch(() => undefined);
  const card = await awx.getCard(cardId).catch(() => undefined);
  const approval = obligation.approval_digest ? ledger.approval(obligation.approval_digest) : undefined;
  const items = await awx.cardTransactions(cardId).then((r) => r.items, () => undefined);
  if (!approval || !card || !items) return { to: 'PAYMENT_UNKNOWN', evidence: { cardId, missing: !approval ? 'APPROVAL' : !card ? 'CARD' : 'TRANSACTIONS' } };
  const auth = latest('AUTHORIZATION');
  // A crash between the approval and its journal entry loses the lifecycle id; the card's one live lifecycle is it.
  const live = [...new Set(items.filter((t) => t.status === 'PENDING' || (t.transaction_type === 'CLEARING' && t.status === 'APPROVED')).map((t) => t.card_transaction_data?.card_transaction_lifecycle_id))];
  const lifecycleId = auth?.external_id ?? (live.length === 1 ? live[0] ?? '' : '');
  const state = reconcileCardPayment(items, {
    lifecycleId,
    amount: obligation.amount_cents / 100,
    currency: obligation.currency,
    merchantDescriptor: approval.terms.merchantDescriptor,
  });
  const evidence = { cardId, cardStatus: card.card_status, reconciliation: state };
  if (state.state === 'PAID' || state.state === 'EXCEPTION') return { to: state.state, evidence };
  // Reopen only on positive evidence: the card reads CLOSED, its complete history shows nothing held or cleared, and
  // either no charge was ever sent or the provider itself recorded how it ended. A charge that was sent but never
  // acknowledged may still appear later, so an empty history is not proof of anything.
  const quiet = items.every((t) => t.status !== 'PENDING' && !(t.transaction_type === 'CLEARING' && t.status === 'APPROVED'));
  const chargeSent = Boolean(auth);
  const providerEnded = state.state === 'NOT_PAID' || auth?.status === 'DECLINED';
  const nothingMoved = quiet && (!chargeSent || providerEnded);
  return { to: nothingMoved && card.card_status === 'CLOSED' ? 'OPEN' : 'PAYMENT_UNKNOWN', evidence };
}

// Whether the provider proves an attempt moved no money and nothing can still move it: the only basis on which a
// person may reopen an invoice for another attempt. A charge that succeeded, may still succeed, or cannot be read
// keeps the invoice closed to retry. Anything still confirmable is cancelled on the way.
export async function provenUnpaid(ledger: Ledger, key: string, now = Date.now()) {
  const obligation = ledger.get(key);
  if (!obligation?.attempt_id) return { unpaid: false, evidence: 'NO_ATTEMPT' as unknown };
  const ops = ledger.operations(key, obligation.attempt_id);
  if (obligation.rail === 'VIC_CHECKOUT') {
    const intentId = ops.filter((o) => o.kind === 'INTENT_CREATE').at(-1)?.external_id;
    // As in recovery: a confirm is journaled only after the intent id is, so without one no charge was ever sent.
    if (!intentId) return { unpaid: true, evidence: 'NO_INTENT_CREATED' as unknown };
    const decided = await decideVic(ledger, key, intentId, journaledConfirm(ops, intentId));
    return { unpaid: decided.to === 'OPEN', evidence: decided.evidence as unknown };
  }
  if (obligation.rail === 'ISSUED_CARD') {
    const decided = await cardOutcome(ledger, obligation, ops, now);
    return { unpaid: decided.to === 'OPEN', evidence: decided.evidence };
  }
  return { unpaid: false, evidence: 'UNKNOWN_RAIL' as unknown };
}
