import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Crash recovery against the in-process fake: what `horos.ts cleanup` and `reconcile` do after a process died.
process.env.AWX_CLIENT_ID = 'fake';
process.env.AWX_API_KEY = 'fake';
process.env.FAKE_PA_STORE = join(mkdtempSync(join(tmpdir(), 'horos-recovery-')), 'pa.jsonl');
// One transaction per page, so every reconciliation here walks the paging loop.
process.env.FAKE_PAGE_SIZE = '1';
await import('./fixtures/fake-airwallex.mjs');
const awx = await import('../src/airwallex.ts');
const { closeAllCards, rememberRemoteAuth, restoreRemoteAuth } = await import('../src/cards.ts');
const { openLedger } = await import('../src/ledger.ts');
const { provenUnpaid, settle } = await import('../src/settle.ts');
const { finalizeVic } = await import('../src/vic.ts');
const { approvalTerms, cardControls, toCents } = await import('../src/policy.ts');
const { invoice, policy, vendor } = await import('../src/demo-data.ts');

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'horos-recovery-')), 'horos.db');
const controls = cardControls(invoice, vendor, policy);
// Past the 2-minute staleness window, inside the 10-minute window for a lost card create to appear.
const stale = () => Date.now() + 3 * 60_000;
const card = { number: '4111', expiry_month: '12', expiry_year: '2030', cvc: '000', name: 'x' };

function reserved(rail: 'VIC_CHECKOUT' | 'ISSUED_CARD', file = dbFile()) {
  const l = openLedger(file);
  const terms = approvalTerms(invoice, vendor, controls, policy);
  l.open(terms.obligation, toCents(invoice.amount), invoice.currency);
  const saved = l.saveApproval(terms, 'tester');
  const attempt = l.reserve(terms.obligation, rail, saved.digest)!;
  const journal = (kind: string, externalId: string | null, status: string, requestId = randomUUID()) =>
    l.record(attempt, { request_id: requestId, obligation: terms.obligation, rail, kind, external_id: externalId, status, detail: null });
  return { l, key: terms.obligation, attempt, journal, file };
}

test('a freshly reserved obligation survives reconciliation before its first journal entry, on both rails', async () => {
  for (const rail of ['VIC_CHECKOUT', 'ISSUED_CARD'] as const) {
    const { l, key } = reserved(rail);
    const s = await settle(l, key);
    assert.deepEqual([s.to, s.evidence], ['RESERVED', 'IN_FLIGHT'], rail);
  }
});

test('a paused owner keeps the obligation: reconcile and the other rail are refused until it finishes', async () => {
  const file = dbFile();
  const { l, key } = (() => {
    const x = openLedger(file);
    const terms = approvalTerms(invoice, vendor, controls, policy);
    x.open(terms.obligation, toCents(invoice.amount), invoice.currency);
    x.saveApproval(terms, 'tester');
    return { l: x, key: terms.obligation };
  })();
  const ledgerUrl = new URL('../src/ledger.ts', import.meta.url).href;
  // The owner reserves, pauses, then makes its first journal write as if nothing happened.
  const owner = `import { openLedger } from ${JSON.stringify(ledgerUrl)};
    const l = openLedger(${JSON.stringify(file)});
    const attempt = l.reserve(${JSON.stringify(key)}, 'ISSUED_CARD', 'd');
    console.log('reserved');
    await new Promise((r) => setTimeout(r, 1500));
    l.record(attempt, { request_id: 'first', obligation: ${JSON.stringify(key)}, rail: 'ISSUED_CARD', kind: 'CARD_CREATE', external_id: null, status: 'SENT', detail: null });
    console.log('still owner');`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', owner]);
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', r));
  while (!out.includes('reserved')) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await settle(l, key)).to, 'RESERVED');
  assert.equal(l.reserve(key, 'VIC_CHECKOUT', 'd'), undefined);
  await exited;
  assert.match(out, /still owner/);
  assert.equal(l.get(key)?.state, 'RESERVED');
});

test('cleanup closes a card whose create response was lost, found by its request id, and resolves the inventory', async () => {
  const l = openLedger(dbFile());
  const requestId = randomUUID();
  l.card(requestId, 'lost-create', null, 'REQUESTED');
  const created = await awx.issueCard('holder-1', controls, 'horos:lost', requestId);
  const result = await closeAllCards(l);
  assert.equal(result.allClosed, true);
  assert.deepEqual(result.cards, [{ requestId, id: created.card_id, status: 'CLOSED' }]);
  assert.deepEqual(l.openCards(), []);
});

test('cleanup never touches a card it did not create, even on the same cardholder', async () => {
  const l = openLedger(dbFile());
  const other = await awx.issueCard('holder-1', controls, 'other-workflow', randomUUID());
  await closeAllCards(l);
  assert.equal((await awx.getCard(other.card_id)).card_status, 'ACTIVE');
});

test('a create the provider has no record of yet stays unresolved; only after it has settled is it resolved', async () => {
  const l = openLedger(dbFile());
  l.card(randomUUID(), 'in-flight', null, 'REQUESTED');
  const fresh = await closeAllCards(l);
  assert.deepEqual([fresh.allClosed, fresh.cards[0].status], [false, 'CREATE_PENDING']);
  assert.equal(l.openCards().length, 1);
});

test('restore writes nothing when nothing was saved', async () => {
  const l = openLedger(dbFile());
  await awx.updateRemoteAuth({ enabled: true, url: 'https://someone-else.example/remote-auth', default_action: 'DECLINED' });
  const r = await restoreRemoteAuth(l, 'https://fallback.example/remote-auth');
  assert.equal(r.readBack, 'NO_SAVED_SETTING');
  assert.deepEqual((await awx.issuingConfig()).remote_auth_settings?.url, 'https://someone-else.example/remote-auth');
  await awx.updateRemoteAuth({ enabled: false, url: 'https://x.example', default_action: 'DECLINED' });
});

test('the original remote auth setting survives a crashed run and is restored field for field', async () => {
  const l = openLedger(dbFile());
  await awx.updateRemoteAuth({ enabled: true, url: 'https://original.example/remote-auth', default_action: 'DECLINED' });
  await rememberRemoteAuth(l);
  await awx.updateRemoteAuth({ enabled: true, url: 'https://crashed-run.example/remote-auth', default_action: 'DECLINED' });
  assert.equal((await rememberRemoteAuth(l)).url, 'https://original.example/remote-auth');
  const r = await restoreRemoteAuth(l, 'https://fallback.example');
  assert.equal(r.restored, true);
  assert.equal((await awx.issuingConfig()).remote_auth_settings?.url, 'https://original.example/remote-auth');
  await awx.updateRemoteAuth({ enabled: false, url: 'https://x.example', default_action: 'DECLINED' });
});

test('a failed restore write keeps the saved original and reports not restored', async () => {
  const l = openLedger(dbFile());
  await awx.updateRemoteAuth({ enabled: true, url: 'https://original.example/remote-auth', default_action: 'DECLINED' });
  await rememberRemoteAuth(l);
  await awx.updateRemoteAuth({ enabled: true, url: 'https://temporary.example/remote-auth', default_action: 'DECLINED' });
  const fake = globalThis.fetch;
  globalThis.fetch = async (url, opts) => (String(url).endsWith('/issuing/config/update') ? new Response('{}', { status: 503 }) : fake(url, opts));
  try {
    const r = await restoreRemoteAuth(l, 'https://temporary.example/remote-auth');
    assert.equal(r.restored, false);
  } finally {
    globalThis.fetch = fake;
  }
  assert.equal((await rememberRemoteAuth(l)).url, 'https://original.example/remote-auth');
  await awx.updateRemoteAuth({ enabled: false, url: 'https://x.example', default_action: 'DECLINED' });
});

test('VIC: a crash before confirm cancels the intent and reopens; a late confirm can no longer charge', async () => {
  const { l, key, journal } = reserved('VIC_CHECKOUT');
  const intent = await awx.createPaymentIntent(186.4, 'USD', 'INV-4417-a', randomUUID());
  journal('INTENT_CREATE', intent.id, 'CREATED');
  assert.equal((await settle(l, key, stale())).to, 'OPEN');
  await assert.rejects(awx.confirmPaymentIntent(intent.id, card, randomUUID()));
});

test('VIC: a confirmed intent settles PAID once stale; while fresh it is left alone', async () => {
  const { l, key, journal } = reserved('VIC_CHECKOUT');
  const intent = await awx.createPaymentIntent(186.4, 'USD', 'INV-4417-b', randomUUID());
  journal('INTENT_CREATE', intent.id, 'CREATED');
  await awx.confirmPaymentIntent(intent.id, card, randomUUID());
  assert.equal((await settle(l, key)).evidence, 'IN_FLIGHT');
  assert.equal((await settle(l, key, stale())).to, 'PAID');
});

test('VIC: an intent that charged a different amount is an exception with a remediation', async () => {
  const { l, key, journal } = reserved('VIC_CHECKOUT');
  const intent = await awx.createPaymentIntent(190, 'USD', 'INV-4417-c', randomUUID());
  journal('INTENT_CREATE', intent.id, 'CREATED');
  await awx.confirmPaymentIntent(intent.id, card, randomUUID());
  const s = await settle(l, key, stale());
  assert.equal(s.to, 'EXCEPTION');
  assert.match((s.evidence as { remediation: string }).remediation, /refund or dispute/);
});

test('card: a crash after the clearing settles PAID from the provider ledger', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  const auth = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  journal('AUTHORIZATION', auth.card_transaction_lifecycle_id, 'APPROVED');
  await awx.simulateCapture(auth.card_transaction_lifecycle_id, 'TESSALINE SYSTEMS INC');
  assert.equal((await settle(l, key, stale())).to, 'PAID');
});

test('card: a lost create is found by its request id and closed before anything reopens', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  journal('CARD_CREATE', null, 'SENT', requestId);
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  assert.equal((await settle(l, key, stale())).to, 'OPEN');
  assert.equal((await awx.getCard(c.card_id)).card_status, 'CLOSED');
});

test('card: a create the provider has not shown yet keeps the obligation blocked', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  journal('CARD_CREATE', null, 'SENT');
  const s = await settle(l, key, stale());
  assert.deepEqual([s.to, s.evidence], ['PAYMENT_UNKNOWN', 'CARD_CREATE_PENDING']);
});

test('card: an authorization still pending stays PAYMENT_UNKNOWN; nothing reopens while money is held', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  assert.equal((await settle(l, key, stale())).to, 'PAYMENT_UNKNOWN');
});

test('card: a failed charge plus a live hold on the same card stays blocked; NOT_PAID alone is not enough', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  const failed = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5999', merchantInfo: 'TESSALINE SYSTEMS INC' });
  journal('AUTHORIZATION', failed.card_transaction_lifecycle_id, 'DECLINED');
  await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  assert.equal((await settle(l, key, stale())).to, 'PAYMENT_UNKNOWN');
});

test('card: a lifecycle id lost before its journal entry is recovered from the card, so the exact clearing is PAID', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  journal('AUTHORIZATION', null, 'SENT');
  const auth = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  await awx.simulateCapture(auth.card_transaction_lifecycle_id, 'TESSALINE SYSTEMS INC');
  assert.equal((await settle(l, key, stale())).to, 'PAID');
});

test('provider API errors arrive as HTTP errors, not as network failures', async () => {
  await assert.rejects(awx.getCard('no-such-card'), (e: Error & { status?: number }) => e.name === 'Error' && (e as { status?: number }).status === 404);
});

test('card: a charge that was sent but never acknowledged stays blocked, even on an empty history and a closed card', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  journal('AUTHORIZATION', null, 'SENT');
  const first = await settle(l, key, stale());
  assert.equal(first.to, 'PAYMENT_UNKNOWN');
  // The charge appears later: still blocked, never reopened in between.
  await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  assert.equal((await settle(l, key, stale())).to, 'PAYMENT_UNKNOWN');
});

test('card: a charge the provider itself declined reopens once the card is closed and quiet', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  const declined = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5999', merchantInfo: 'TESSALINE SYSTEMS INC' });
  journal('AUTHORIZATION', declined.card_transaction_lifecycle_id, 'DECLINED');
  assert.equal((await settle(l, key, stale())).to, 'OPEN');
});

async function vicIntent(amount: unknown, confirm: boolean) {
  const v = reserved('VIC_CHECKOUT');
  const intent = await awx.createPaymentIntent(amount as number, 'USD', `INV-4417-${randomUUID().slice(0, 6)}`, randomUUID());
  v.journal('INTENT_CREATE', intent.id, 'CREATED');
  if (confirm) await awx.confirmPaymentIntent(intent.id, card, randomUUID());
  return { ...v, intent };
}

test('VIC: contradictory terminal evidence is an exception in both directions; a clean cancel still reopens', async () => {
  const cancelled = await vicIntent(186.4, false);
  await awx.cancelPaymentIntent(cancelled.intent.id, 'test');
  const successClaim = { ...cancelled.intent, status: 'SUCCEEDED', amount: 186.4, currency: 'USD' };
  const a = await finalizeVic(cancelled.l, cancelled.key, cancelled.attempt, 'RESERVED', cancelled.intent.id, successClaim);
  assert.deepEqual([a.state, Boolean(a.evidence.remediation)], ['EXCEPTION', true]);

  const paid = await vicIntent(186.4, true);
  const failClaim = { ...paid.intent, status: 'CANCELLED', amount: 186.4, currency: 'USD' };
  const b = await finalizeVic(paid.l, paid.key, paid.attempt, 'RESERVED', paid.intent.id, failClaim);
  assert.deepEqual([b.state, Boolean(b.evidence.remediation)], ['EXCEPTION', true]);

  const clean = await vicIntent(186.4, false);
  await awx.cancelPaymentIntent(clean.intent.id, 'test');
  assert.equal((await finalizeVic(clean.l, clean.key, clean.attempt, 'RESERVED', clean.intent.id)).state, 'OPEN');
});

test('VIC: provider money that is not a whole-cent number is never PAID', async () => {
  for (const amount of [186.404, '186.40']) {
    const v = await vicIntent(amount, true);
    const r = await finalizeVic(v.l, v.key, v.attempt, 'RESERVED', v.intent.id);
    assert.equal(r.state, 'EXCEPTION', String(amount));
    assert.match(r.evidence.remediation ?? '', /whole-cent/);
  }
});

test('history keeps every move, including a person\'s decision, after the obligation reopens', () => {
  const { l, key, attempt } = reserved('ISSUED_CARD');
  l.transition(key, attempt, 'RESERVED', 'EXCEPTION', 'overcapture');
  l.transition(key, attempt, 'EXCEPTION', 'OPEN', 'resolved by operator: refunded by supplier');
  l.reserve(key, 'VIC_CHECKOUT', 'd');
  assert.deepEqual(
    l.history(key).map((h) => [h.from_state, h.to_state, h.detail]),
    [
      ['OPEN', 'RESERVED', 'ISSUED_CARD'],
      ['RESERVED', 'EXCEPTION', 'overcapture'],
      ['EXCEPTION', 'OPEN', 'resolved by operator: refunded by supplier'],
      ['OPEN', 'RESERVED', 'VIC_CHECKOUT'],
    ],
  );
});

test('VIC: recovery after a restart reaches the same decision as the original process, from the journaled confirmation', async () => {
  // A success claim, then a cancelled read-back.
  const a = await vicIntent(186.4, false);
  await awx.cancelPaymentIntent(a.intent.id, 'test');
  a.journal('CONFIRM', a.intent.id, 'SUCCEEDED');
  a.l.record(a.attempt, { request_id: 'confirm-a', obligation: a.key, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: a.intent.id, status: 'SUCCEEDED', detail: JSON.stringify({ response: { id: a.intent.id, status: 'SUCCEEDED', amount: 186.4, currency: 'USD' } }) });
  const reopened = openLedger(a.file);
  const ra = await settle(reopened, a.key, stale());
  assert.equal(ra.to, 'EXCEPTION');
  assert.deepEqual(reopened.pendingReports(), [], 'no terminal result is owed for a contradiction');

  // A failure claim, then a successful read-back.
  const b = await vicIntent(186.4, true);
  b.l.record(b.attempt, { request_id: 'confirm-b', obligation: b.key, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: b.intent.id, status: 'CANCELLED', detail: JSON.stringify({ response: { id: b.intent.id, status: 'CANCELLED', amount: 186.4, currency: 'USD' } }) });
  const rb = await settle(openLedger(b.file), b.key, stale());
  assert.equal(rb.to, 'EXCEPTION');
});

test('VIC: a confirmation journaled by status alone is still evidence after a restart', async () => {
  const a = await vicIntent(186.4, false);
  await awx.cancelPaymentIntent(a.intent.id, 'test');
  a.l.record(a.attempt, { request_id: 'confirm-s', obligation: a.key, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: a.intent.id, status: 'SUCCEEDED', detail: null });
  assert.equal((await settle(openLedger(a.file), a.key, stale())).to, 'EXCEPTION');
  const b = await vicIntent(186.4, true);
  b.l.record(b.attempt, { request_id: 'confirm-t', obligation: b.key, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: b.intent.id, status: 'SUCCEEDED', detail: null });
  assert.equal((await settle(openLedger(b.file), b.key, stale())).to, 'PAID', 'agreeing status and read-back still pay');
});

test('card: a cleared charge is never proven unpaid, so a person cannot reopen it', async () => {
  const { l, key, journal } = reserved('ISSUED_CARD');
  const requestId = randomUUID();
  const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
  journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
  const auth = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5045', merchantInfo: 'TESSALINE SYSTEMS INC' });
  journal('AUTHORIZATION', auth.card_transaction_lifecycle_id, 'APPROVED');
  await awx.simulateCapture(auth.card_transaction_lifecycle_id, 'TESSALINE SYSTEMS INC');
  assert.equal((await provenUnpaid(l, key)).unpaid, false);
});

test('card: a declined charge is proven unpaid only once the card reads CLOSED', async () => {
  // The same attempt in a process whose provider will not close the card, and in one where it will.
  const urls = { fake: new URL('./fixtures/fake-airwallex.mjs', import.meta.url).href, awx: new URL('../src/airwallex.ts', import.meta.url).href, ledger: new URL('../src/ledger.ts', import.meta.url).href, settle: new URL('../src/settle.ts', import.meta.url).href, policy: new URL('../src/policy.ts', import.meta.url).href, demo: new URL('../src/demo-data.ts', import.meta.url).href };
  const script = `await import(${JSON.stringify(urls.fake)});
    const awx = await import(${JSON.stringify(urls.awx)});
    const { openLedger } = await import(${JSON.stringify(urls.ledger)});
    const { provenUnpaid } = await import(${JSON.stringify(urls.settle)});
    const { approvalTerms, cardControls, toCents } = await import(${JSON.stringify(urls.policy)});
    const { invoice, policy, vendor } = await import(${JSON.stringify(urls.demo)});
    const l = openLedger(process.env.DB);
    const controls = cardControls(invoice, vendor, policy);
    const terms = approvalTerms(invoice, vendor, controls, policy);
    l.open(terms.obligation, toCents(invoice.amount), invoice.currency);
    const attempt = l.reserve(terms.obligation, 'ISSUED_CARD', l.saveApproval(terms, 'tester').digest);
    const journal = (kind, id, status, requestId = crypto.randomUUID()) => l.record(attempt, { request_id: requestId, obligation: terms.obligation, rail: 'ISSUED_CARD', kind, external_id: id, status, detail: null });
    const requestId = crypto.randomUUID();
    const c = await awx.issueCard('holder-1', controls, 'horos:pay', requestId);
    journal('CARD_CREATE', c.card_id, 'CREATED', requestId);
    const declined = await awx.simulateAuthorization(c.card_id, { amount: 186.4, currency: 'USD', mcc: '5999', merchantInfo: 'TESSALINE SYSTEMS INC' });
    journal('AUTHORIZATION', declined.card_transaction_lifecycle_id, 'DECLINED');
    console.log(JSON.stringify(await provenUnpaid(l, terms.obligation)));`;
  const run = (mode: string) =>
    new Promise<{ unpaid: boolean }>((done, fail) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, DB: dbFile(), FAKE_AWX_MODE: mode } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', () => {
        try {
          done(JSON.parse(out.trim().split('\n').at(-1)!));
        } catch {
          fail(new Error(out));
        }
      });
    });
  assert.equal((await run('close-fails')).unpaid, false, 'the card still reads ACTIVE');
  assert.equal((await run('ok')).unpaid, true, 'the same attempt once the card is closed');
});
