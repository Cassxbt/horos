import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { approvalFor, createApprovalStore, nonceIsFresh, verifySignature, type AuthRequest } from '../src/authorize.ts';
import { approvalDigest, approvalTerms, cardControls, type Invoice, type Vendor } from '../src/policy.ts';
import { invoice, policy, vendor } from '../src/demo-data.ts';

const cardId = 'c7ee132a-2ed9-4b95-95e5-96e19cbd576b';
const before = new Date('2026-11-10T12:00:00Z');
let eventSeq = 0;

function request(overrides: Partial<AuthRequest> & { merchantName?: string; mcc?: string } = {}): AuthRequest {
  const { merchantName, mcc, ...rest } = overrides;
  return {
    card_id: cardId,
    card_transaction_event_id: `evt-${++eventSeq}`,
    transaction_type: 'AUTHORIZATION',
    transaction_amount: 186.4,
    transaction_currency: 'USD',
    merchant: { name: merchantName ?? 'TESSALINE SYSTEMS INC____', category_code: mcc ?? '5045' },
    ...rest,
  };
}

const approvedAt = new Date('2026-11-10T00:00:00Z');

function termsFor(v: Vendor = vendor, inv: Invoice = invoice) {
  return approvalTerms(inv, v, cardControls(inv, v, policy, approvedAt), policy);
}

function approval(card = cardId, v: Vendor = vendor, inv: Invoice = invoice) {
  const terms = termsFor(v, inv);
  return approvalFor(card, terms, approvalDigest(terms));
}

function armedStore() {
  const store = createApprovalStore();
  store.arm(approval());
  return store;
}

const reason = (store: ReturnType<typeof createApprovalStore>, req: AuthRequest, now = before) =>
  store.authorize(req, now).status_reason;

test('authorizes the approved supplier, amount, currency and category', () => {
  const decision = armedStore().authorize(request(), before);
  assert.deepEqual(decision, { response_status: 'AUTHORIZED', status_reason: 'MATCHES_APPROVAL' });
});

test('matches the descriptor through the network padding and case', () => {
  assert.equal(reason(armedStore(), request({ merchantName: 'tessaline  systems inc' })), 'MATCHES_APPROVAL');
});

test('refuses a lookalike merchant at the invoice amount', () => {
  assert.equal(reason(armedStore(), request({ merchantName: 'TESSALLNE SYSTEMS________' })), 'MERCHANT_MISMATCH');
  assert.equal(reason(armedStore(), request({ merchantName: 'TESSALINE SYSTЕMS INC' })), 'MERCHANT_MISMATCH');
  assert.equal(reason(armedStore(), request({ merchantName: 'TESSALINE SYSTEMS INC LTD' })), 'MERCHANT_MISMATCH');
});

test('refuses lookalike characters that case folding would turn into the real name', () => {
  for (const merchantName of [
    'TESSAL\u0131NE SYSTEMS INC',
    'TE\u00dfALINE SYSTEMS INC',
    'TESSALINE \u017fY\u017fTEMS INC',
    'TESSALINE SY\ufb06EMS INC',
    'TESSALINE\u00a0SYSTEMS INC',
    'TESSALINE\ufeffSYSTEMS INC',
    'TESSALINE\u200bSYSTEMS INC',
    'TESSALINE_SYSTEMS_INC',
  ]) {
    assert.equal(reason(armedStore(), request({ merchantName })), 'MERCHANT_MISMATCH', JSON.stringify(merchantName));
  }
});

test('matches a long vendor name as the network truncates it to 25 characters', () => {
  const store = createApprovalStore();
  store.arm(approval(cardId, { ...vendor, merchantDescriptor: 'TESSALINE SYSTEMS INTERNATIONAL' }));
  assert.equal(reason(store, request({ merchantName: 'TESSALINE SYSTEMS INTERNA' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ merchantName: 'TESSALINE SYSTEMS INTERNB' })), 'MERCHANT_MISMATCH');
});

test('authorizes only the approved amount, to the cent', () => {
  assert.equal(reason(armedStore(), request({ transaction_amount: 186.41 })), 'AMOUNT_EXCEEDS_APPROVAL');
  assert.equal(reason(armedStore(), request({ transaction_amount: 186.404 })), 'MALFORMED_REQUEST');
  assert.equal(reason(armedStore(), request({ transaction_amount: 120 })), 'AMOUNT_BELOW_APPROVAL');
});

test('a zero, negative or tiny authorization is refused and does not spend the approval', () => {
  const store = armedStore();
  for (const transaction_amount of [0, -5, -0.01, 1e-9]) {
    assert.notEqual(store.authorize(request({ transaction_amount }), before).response_status, 'AUTHORIZED');
  }
  assert.equal(reason(store, request()), 'MATCHES_APPROVAL');
});

test('refuses another currency or merchant category', () => {
  assert.equal(reason(armedStore(), request({ transaction_currency: 'EUR' })), 'CURRENCY_MISMATCH');
  assert.equal(reason(armedStore(), request({ mcc: '5999' })), 'MCC_MISMATCH');
});

test('refuses a card it never armed', () => {
  assert.equal(reason(createApprovalStore(), request()), 'UNKNOWN_CARD');
});

test('refuses after the approval expires', () => {
  assert.equal(reason(armedStore(), request(), new Date('2026-11-21T00:00:00Z')), 'APPROVAL_EXPIRED');
});

test('an approval with an unreadable expiry, amount or currency cannot be armed', () => {
  const store = createApprovalStore();
  for (const change of [{ expiresAt: 'not-a-date' }, { amount: Number.NaN }, { amount: 0 }, { amount: 186.404 }, { currency: 'JPY' }, { currency: 'usd' }, { obligation: '' }]) {
    assert.throws(() => store.arm({ ...approval(), ...change }), /INVALID_APPROVAL/, JSON.stringify(change));
  }
  assert.equal(reason(store, request()), 'UNKNOWN_CARD');
});

test('authorizes once: a second charge on the same approval is refused', () => {
  const store = armedStore();
  assert.equal(reason(store, request()), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request()), 'APPROVAL_ALREADY_USED');
});

test('a redelivered event gets the same answer without spending the approval twice', () => {
  const store = armedStore();
  const first = request();
  assert.equal(reason(store, first), 'MATCHES_APPROVAL');
  assert.equal(reason(store, { ...first }), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request()), 'APPROVAL_ALREADY_USED');
});

test('a declined attempt does not spend the approval', () => {
  const store = armedStore();
  assert.equal(reason(store, request({ merchantName: 'TESSALLNE SYSTEMS' })), 'MERCHANT_MISMATCH');
  assert.equal(reason(store, request()), 'MATCHES_APPROVAL');
});

test('refuses after the card is disarmed', () => {
  const store = armedStore();
  store.disarm(cardId);
  assert.equal(reason(store, request()), 'UNKNOWN_CARD');
});

test('refuses anything that is not an authorization, and malformed requests', () => {
  assert.equal(reason(armedStore(), request({ transaction_type: 'VERIFICATION' })), 'UNSUPPORTED_TRANSACTION_TYPE');
  assert.equal(reason(armedStore(), request({ card_transaction_event_id: '' })), 'MALFORMED_REQUEST');
  assert.equal(reason(armedStore(), request({ transaction_amount: Number.NaN })), 'MALFORMED_REQUEST');
});

test('wrong field types are refused instead of throwing', () => {
  const bad = [
    { ...request(), merchant: { name: null, category_code: '5045' } },
    { ...request(), merchant: { name: 'TESSALINE SYSTEMS INC', category_code: 5045 } },
    { ...request(), merchant: null },
    { ...request(), transaction_currency: 840 },
    { ...request(), transaction_amount: '186.40' },
    { ...request(), card_id: 42 },
  ] as unknown as AuthRequest[];
  for (const req of bad) assert.equal(reason(armedStore(), req), 'MALFORMED_REQUEST', JSON.stringify(req));
});

test('verifies the Airwallex signature over the nonce', () => {
  const secret = 'test-secret';
  const nonce = '1794158251033-3f1c';
  const signature = createHmac('sha256', secret).update(nonce).digest('base64');
  const tampered = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal(verifySignature(secret, nonce, signature), true);
  assert.equal(verifySignature(secret, nonce, tampered), false);
  assert.equal(verifySignature(secret, `${nonce}0`, signature), false);
  assert.equal(verifySignature('', nonce, signature), false);
  assert.equal(verifySignature(secret, nonce, ''), false);
});

test('a single-message clearing on the approved lifecycle is accepted once; another lifecycle is a second spend', () => {
  const store = armedStore();
  assert.equal(reason(store, request({ card_transaction_lifecycle_id: 'life-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-2' })), 'APPROVAL_ALREADY_USED');
});

test('a single-message clearing is judged by the same rules', () => {
  assert.equal(reason(armedStore(), request({ transaction_type: 'CLEARING' })), 'MATCHES_APPROVAL');
  assert.equal(reason(armedStore(), request({ transaction_type: 'CLEARING', merchantName: 'TESSALLNE SYSTEMS' })), 'MERCHANT_MISMATCH');
});

test('a nonce is fresh only within five minutes of its timestamp', () => {
  const now = 1_794_300_000_000;
  assert.equal(nonceIsFresh(`${now - 60_000}.abc`, now), true);
  assert.equal(nonceIsFresh(`${now - 6 * 60_000}.abc`, now), false);
  assert.equal(nonceIsFresh(`${now + 6 * 60_000}.abc`, now), false);
  assert.equal(nonceIsFresh('not-a-time.abc', now), false);
  assert.equal(nonceIsFresh('', now), false);
});

test('a repeated single-message clearing on the approved lifecycle is refused', () => {
  const store = armedStore();
  assert.equal(reason(store, request({ card_transaction_lifecycle_id: 'life-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-1' })), 'APPROVAL_ALREADY_USED');
});

test('a single-message clearing spends the approval completely', () => {
  const store = armedStore();
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ transaction_type: 'CLEARING', card_transaction_lifecycle_id: 'life-1' })), 'APPROVAL_ALREADY_USED');
  assert.equal(reason(store, request({ card_transaction_lifecycle_id: 'life-1' })), 'APPROVAL_ALREADY_USED');
});

test('a replayed event id with a different body is refused, not answered from cache', () => {
  const store = armedStore();
  const first = request();
  assert.equal(reason(store, first), 'MATCHES_APPROVAL');
  assert.equal(reason(store, { ...first, merchant: { name: 'EVIL', category_code: '5045' } }), 'EVENT_REPLAY_MISMATCH');
  assert.equal(reason(store, { ...first }), 'MATCHES_APPROVAL');
});

test('an approval cannot be armed for a descriptor the network could never send', () => {
  for (const merchantDescriptor of ['CAFÉ DU MARCHÉ SARL', '', '   ']) {
    assert.throws(() => approval(cardId, { ...vendor, merchantDescriptor }), /INVALID_MERCHANT_DESCRIPTOR/);
  }
});

test('the gate enforces only signed terms: edited terms under the old digest are refused', () => {
  const terms = termsFor();
  const digest = approvalDigest(terms);
  for (const change of [{ merchantDescriptor: 'ATTACKER SHOP' }, { amount: 999 }, { mcc: '5999' }, { acceptorId: 'attacker-mid' }, { expiresAt: '2030-01-01T00:00:00+0000' }]) {
    assert.throws(() => approvalFor(cardId, { ...terms, ...change }, digest), /APPROVAL_DIGEST_MISMATCH/, JSON.stringify(change));
  }
});

test('an armed approval cannot be mutated through the store', () => {
  const store = armedStore();
  const armed = store.get(cardId)!;
  assert.ok(Object.isFrozen(armed));
  assert.throws(() => {
    (armed as { amount: number }).amount = 9999;
  });
  assert.equal(reason(store, request({ transaction_amount: 9999 })), 'AMOUNT_EXCEEDS_APPROVAL');
});

test('one obligation pays once, even across two cards armed for it', () => {
  const store = createApprovalStore();
  store.arm(approval('card-1'));
  store.arm(approval('card-2'));
  assert.equal(reason(store, request({ card_id: 'card-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ card_id: 'card-2' })), 'APPROVAL_ALREADY_USED');
});

test('two different invoices on two cards each pay once', () => {
  const store = createApprovalStore();
  store.arm(approval('card-1'));
  store.arm(approval('card-2', vendor, { ...invoice, id: 'INV-4418' }));
  assert.equal(reason(store, request({ card_id: 'card-1' })), 'MATCHES_APPROVAL');
  assert.equal(reason(store, request({ card_id: 'card-2' })), 'MATCHES_APPROVAL');
});

test('with a verified acceptor id, the same name from another merchant id is refused', () => {
  const store = createApprovalStore();
  store.arm(approval(cardId, { ...vendor, acceptorId: 'MID-717799' }));
  const named = (id?: string) => request({ merchant: { id, name: 'TESSALINE SYSTEMS INC____', category_code: '5045' } });
  assert.equal(reason(store, named('attacker-mid')), 'MERCHANT_ID_MISMATCH');
  assert.equal(reason(store, named(undefined)), 'MERCHANT_ID_MISMATCH');
  assert.equal(reason(store, named('MID-717799')), 'MATCHES_APPROVAL');
});

test('without a verified acceptor id the match is descriptor-only, and the merchant id still binds replays', () => {
  const store = armedStore();
  const first = request({ merchant: { id: 'mid-a', name: 'TESSALINE SYSTEMS INC', category_code: '5045' } });
  assert.equal(reason(store, first), 'MATCHES_APPROVAL');
  assert.equal(reason(store, { ...first, merchant: { ...first.merchant, id: 'mid-b' } }), 'EVENT_REPLAY_MISMATCH');
});

test('a card whose ledger attempt no longer holds the obligation is refused at network time', () => {
  let held = true;
  const store = createApprovalStore(() => held);
  const terms = termsFor();
  store.arm(approvalFor(cardId, terms, approvalDigest(terms), 'attempt-1'));
  held = false;
  assert.equal(reason(store, request()), 'RESERVATION_NOT_HELD');
  held = true;
  assert.equal(reason(store, request()), 'MATCHES_APPROVAL');
});

test('with a ledger attached, an approval armed without an attempt is refused', () => {
  const store = createApprovalStore(() => true);
  store.arm(approval());
  assert.equal(reason(store, request()), 'RESERVATION_NOT_HELD');
});
