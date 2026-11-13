import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCardPayment, type LedgerTransaction } from '../src/reconcile.ts';

const expected = { lifecycleId: 'life-1', amount: 186.4, currency: 'USD', merchantDescriptor: 'TESSALINE SYSTEMS INC' };

// Shaped like the live sandbox record: the approved authorization is replaced by a CLEARING on the same lifecycle.
const tx = (over: Partial<LedgerTransaction> = {}, lifecycle = 'life-1'): LedgerTransaction => ({
  transaction_id: `tx-${Math.random()}`,
  transaction_type: 'CLEARING',
  status: 'APPROVED',
  transaction_amount: -186.4,
  transaction_currency: 'USD',
  card_transaction_data: { card_transaction_lifecycle_id: lifecycle },
  merchant: { name: 'TESSALINE SYSTEMS INC____', category_code: '7531', identifier: '717799611184370' },
  ...over,
});

test('paid only when the approved lifecycle cleared for exactly the approved amount', () => {
  const r = reconcileCardPayment([tx()], expected);
  assert.equal(r.state, 'PAID');
  assert.deepEqual(r.notes, ['clearing booked under MCC 7531']);
});

test('a clearing above the approval is an exception, never paid', () => {
  const r = reconcileCardPayment([tx({ transaction_amount: -190 })], expected);
  assert.deepEqual([r.state, 'reason' in r && r.reason], ['EXCEPTION', 'CLEARED_ABOVE_APPROVAL']);
});

test('a clearing booked to another payee is an exception, even on the approved lifecycle and amount', () => {
  const r = reconcileCardPayment([tx({ merchant: { name: 'EVIL CORP LLC', category_code: '7995', identifier: 'x' } })], expected);
  assert.deepEqual([r.state, 'reason' in r && r.reason], ['EXCEPTION', 'CLEARED_TO_OTHER_MERCHANT']);
});

test('every exception names a remediation, and none of them is a retry', () => {
  for (const items of [[tx({ transaction_amount: -190 })], [tx({ transaction_amount: -100 })], [tx(), tx({}, 'life-2')], [tx({ transaction_currency: 'EUR' })]]) {
    const r = reconcileCardPayment(items, expected);
    assert.equal(r.state, 'EXCEPTION');
    assert.ok(r.state === 'EXCEPTION' && r.remediation && !/retry/i.test(r.remediation.replace('never a retry', '')), JSON.stringify(r));
  }
});

test('a partial clearing is an exception, never paid', () => {
  const r = reconcileCardPayment([tx({ transaction_amount: -100 })], expected);
  assert.deepEqual([r.state, 'reason' in r && r.reason], ['EXCEPTION', 'CLEARED_BELOW_APPROVAL']);
});

test('a clearing on another lifecycle of the same card is an exception', () => {
  const r = reconcileCardPayment([tx(), tx({}, 'life-2')], expected);
  assert.deepEqual([r.state, 'reason' in r && r.reason], ['EXCEPTION', 'CLEARING_OUTSIDE_APPROVED_LIFECYCLE']);
});

test('two clearings on the approved lifecycle are an exception', () => {
  const r = reconcileCardPayment([tx({ transaction_amount: -93.2 }), tx({ transaction_amount: -93.2 })], expected);
  assert.deepEqual([r.state, 'reason' in r && r.reason], ['EXCEPTION', 'MULTIPLE_CLEARINGS']);
});

test('a clearing in another currency is an exception', () => {
  const r = reconcileCardPayment([tx({ transaction_currency: 'EUR' })], expected);
  assert.equal(r.state, 'EXCEPTION');
});

test('no ledger record, or an authorization still pending, is unknown: not paid and not free to retry', () => {
  assert.equal(reconcileCardPayment([], expected).state, 'PAYMENT_UNKNOWN');
  assert.equal(reconcileCardPayment([tx({ transaction_type: 'AUTHORIZATION', status: 'PENDING' })], expected).state, 'PAYMENT_UNKNOWN');
});

test('a failed or reversed authorization moved no money', () => {
  assert.equal(reconcileCardPayment([tx({ transaction_type: 'AUTHORIZATION', status: 'REVERSED' })], expected).state, 'NOT_PAID');
  assert.equal(reconcileCardPayment([tx({ transaction_type: 'AUTHORIZATION', status: 'FAILED' })], expected).state, 'NOT_PAID');
});

test('declined authorizations elsewhere on the card do not block a clean payment', () => {
  const r = reconcileCardPayment([tx({ transaction_type: 'AUTHORIZATION', status: 'FAILED' }, 'life-0'), tx()], expected);
  assert.equal(r.state, 'PAID');
});

test('settlement evidence that is missing, credit-signed or finer than a cent keeps the payment unknown', () => {
  for (const transaction_amount of [undefined, null, Number.NaN, 186.4, -186.404, 0]) {
    const r = reconcileCardPayment([tx({ transaction_amount: transaction_amount as number })], expected);
    assert.deepEqual([r.state, 'reason' in r && r.reason], ['PAYMENT_UNKNOWN', 'INVALID_SETTLEMENT_EVIDENCE'], String(transaction_amount));
  }
});
