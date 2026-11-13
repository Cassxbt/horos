import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ACCOUNTING, AIRI, billSandbox, HOROS, KEY, SLACK100, SLACK_VENDOR, STAND_IN, stateOf, succeededIntents, T0_PAGE } from './harness.ts';

// The selected-bill workflow on the real T:0 bill id, with fake providers.
test('bill: an unverified bill cannot be approved; a verified one shows exactly what is authorized and records nothing without an approver', () => {
  const b = billSandbox();
  assert.equal(b.queue(['import']).code, 0);
  assert.equal(b.approve().code, 1, 'NEEDS_VENDOR_VERIFICATION blocks even the preview');
  assert.equal(b.verify().code, 0);
  const preview = b.approve();
  assert.equal(preview.code, 0, preview.stderr);
  const shown = JSON.parse(preview.stdout.slice(0, preview.stdout.indexOf('\npreview only'))).preview;
  assert.match(shown.invoice, /^INV-20250201-1234 /);
  assert.equal(shown.destination, STAND_IN, 'the full verified address, path included');
  assert.match(shown.destinationNote, /not the supplier itself/);
  assert.match(shown.verifiedBy, /^cass at .*Slack AP confirmed/);
  assert.match(shown.receivedBy, /acct_sandbox_A \(Fake Sandbox Business\), read from the credentials/);
  assert.match(shown.invoice, new RegExp(SLACK100));
  assert.match(shown.vendorRecord, new RegExp(SLACK_VENDOR));
  assert.equal(shown.amount, 'USD 100.00');
  assert.match(preview.stdout, /preview only: nothing approved/);
  const untokened = b.approve(['--approve-as', 'cass']);
  assert.equal(untokened.code, 1);
  assert.match(untokened.stderr, /needs the --token printed by the preview you read/);
  const forged = b.approve(['--approve-as', 'cass', '--token', 'deadbeef']);
  assert.match(forged.stderr, /needs the --token printed by the preview you read/);
  assert.equal(b.files('airi-payment-').length, 0);
});

test('bill: an approved bill is paid once, under its own bill id, and a change after approval needs a new approval', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const approved = b.approveAs('cass');
  assert.equal(approved.code, 0, approved.stderr);
  b.mandateFor('mdt_bill1', b.digestOf(approved.stdout));

  // The bill's due date moves in T:0 after approval: the verification and the approval both lapse.
  const moved = structuredClone(T0_PAGE);
  moved.data.find((r: any) => r.id.externalId === SLACK100).data.dueDate = '2026-12-01';
  b.setPage(moved);
  b.queue(['import']);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_NEEDS_VENDOR_VERIFICATION');
  b.verify();
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.match(b.last().refused, /^APPROVAL_STALE:.*sourceVersion/);

  const reapproved = b.approveAs('cass');
  b.mandateFor('mdt_bill2', b.digestOf(reapproved.stdout));
  const paid = b.pay('mdt_bill2');
  assert.equal(paid.code, 0, paid.stderr + JSON.stringify(b.last()));
  assert.deepEqual([b.last().obligation, b.last().state, b.last().airiReport], [`entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`, 'PAID', 'REPORTED']);
  assert.match(b.queue(['show']).stdout, /^NOT_PAYABLE .*INV-20250201-1234/m);
});

test('bill: interrupted after the confirmation is journaled, recovery reaches the same outcome for the same bill; a competing attempt is refused meanwhile', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const approved = b.approveAs('cass');
  b.mandateFor('mdt_bill1', b.digestOf(approved.stdout));
  b.mandateFor('mdt_bill2', b.digestOf(approved.stdout));
  assert.equal(b.pay('mdt_bill1', { FAKE_AWX_MODE: 'kill-on-readback' }).code, null);
  assert.equal(b.pay('mdt_bill2').code, 1);
  assert.equal(b.last().refused, 'OBLIGATION_RESERVED');
  assert.equal(b.run(AIRI, ['reconcile', '--bill', SLACK100], { HOROS_STALE_MS: '0' }).code, 0);
  const settled = b.last();
  assert.deepEqual([settled.obligation, settled.state, settled.airiReports], [`entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`, 'PAID', { mdt_bill1: 'REPORTED' }]);
});

test('bill: a replaced verification, a different destination path or another Airwallex account each need a fresh approval', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const approved = b.approveAs('cass');
  b.mandateFor('mdt_bill1', b.digestOf(approved.stdout));
  // Re-verified at another path on the same host: the old approval no longer names what was verified.
  b.queue(['verify', SLACK100, '--vendor', SLACK_VENDOR, '--destination', `${STAND_IN}-v2`, '--by', 'cass', '--evidence', 'moved checkout route']);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.match(b.last().refused, /^APPROVAL_STALE:.*verificationId.*destination/);
  b.verify();
  b.useAccount('acct_sandbox_B');
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.match(b.last().refused, /^APPROVAL_STALE:.*paymentAccount/);
  assert.equal(b.paCalls().length, 0, 'nothing reached Airwallex');
});

test('bill: a bill with no verified destination cannot even be previewed, and the preview never claims a check that did not happen', () => {
  const b = billSandbox();
  b.queue(['import']);
  const hp = b.run(AIRI, ['approve', '--bill', 't0_bill_prod_6f3f948454ee3b41cabe']);
  assert.equal(hp.code, 1);
  assert.match(hp.stderr, /no person has verified a checkout destination/);
  assert.doesNotMatch(hp.stdout, /verified/);
});

test('bill: a bill paid elsewhere after approval is refused from a fresh T:0 read, before the passkey is even asked for', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  // Only T:0 changed: no import ran since the approval, so the local queue still says ready.
  b.setPage(JSON.parse(readFileSync(b.paidElsewhere, 'utf8')));
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_WITHDRAWN');
  assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0]);
});

test('bill: a bill paid elsewhere while the passkey is pending is caught before anything is reserved or charged', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  // Read 1 is the start of pay; read 2 comes after the passkey wait.
  assert.equal(b.pay('mdt_bill1', { FAKE_T0_PAGE_FROM: `2:${b.paidElsewhere}` }).code, 1);
  assert.equal(b.last().refused, 'ELIGIBILITY_CHANGED:BILL_WITHDRAWN');
  assert.equal(b.paCalls().length, 0);
  assert.equal(b.json(b.files('airi-payment-').at(-1)!).state, undefined);
});

test('bill: a bill paid elsewhere after the intent is created stops the confirm and cancels the intent', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  const r = b.pay('mdt_bill1', { FAKE_T0_PAGE_FROM: `3:${b.paidElsewhere}` });
  assert.equal(r.code, 1);
  assert.equal(b.last().state, 'OPEN');
  assert.match(b.last().error, /ELIGIBILITY_CHANGED:BILL_WITHDRAWN/);
  assert.ok(!b.paCalls().some((c) => c.path.endsWith('/confirm')), 'never confirmed');
  assert.ok(b.paCalls().some((c) => c.path.endsWith('/cancel')), 'the intent was cancelled');
});

test('bill: when T:0 cannot be read, nothing is paid: refused at the start, and cancelled if it fails before confirm', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const digest = b.digestOf(b.approveAs('cass').stdout);
  b.mandateFor('mdt_bill1', digest);
  b.mandateFor('mdt_bill2', digest);
  assert.equal(b.pay('mdt_bill1', { FAKE_T0_FAIL: '1' }).code, 1);
  assert.equal(b.last().refused, 'SOURCE_UNREADABLE');
  assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0]);
  assert.equal(b.pay('mdt_bill2', { FAKE_T0_FAIL_FROM: '3' }).code, 1);
  assert.equal(b.last().state, 'OPEN');
  assert.match(b.last().error, /ELIGIBILITY_CHANGED:SOURCE_UNREADABLE/);
  assert.ok(!b.paCalls().some((c) => c.path.endsWith('/confirm')), 'never confirmed');
  assert.ok(b.paCalls().some((c) => c.path.endsWith('/cancel')), 'the intent was cancelled');
});

test('bill: a blank or malformed receiving account is refused before a preview, an approval or a credential', () => {
  for (const account of ['', '   ', 'not-an-account']) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    const approved = b.approveAs('cass');
    assert.equal(approved.code, 0, approved.stderr);
    b.mandateFor('mdt_bill1', b.digestOf(approved.stdout));
    b.useAccount(account);
    const preview = b.approve();
    assert.equal(preview.code, 1, JSON.stringify(account));
    assert.match(preview.stderr, /ACCOUNT_IDENTITY_INVALID/);
    assert.doesNotMatch(preview.stdout, /--token/);
    const paid = b.pay('mdt_bill1');
    assert.equal(paid.code, 1);
    assert.match(paid.stderr, /ACCOUNT_IDENTITY_INVALID/, 'refused for the account itself, not only as a stale approval');
    assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0]);
  }
});

test('bill: a mandate on the verified host but another path is refused before any credential or payment', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout), `${STAND_IN}-elsewhere`);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.ok(b.last().findings.includes('MERCHANT_URL_NOT_VERIFIED_DESTINATION'));
  assert.equal(b.paCalls().length, 0);
  assert.equal(b.airiCalls().filter((c) => c[1] === 'get-credential').length, 0);
});

test('resolve: a bill a person marks paid without a provider payment is held for accounting review, never posted', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  const key = `entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`;
  const digest = (db.prepare('SELECT digest FROM approvals WHERE obligation = ?').get(key) as { digest: string }).digest;
  db.prepare("UPDATE obligations SET state = 'EXCEPTION', attempt_id = 'att-manual', approval_digest = ? WHERE key = ?").run(digest, key);
  db.close();
  assert.equal(b.run(HOROS, ['resolve', key, 'PAID', 'paid outside Horos; receipt on file']).code, 0);
  const status = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ACCOUNTING, 'status'], { cwd: b.cwd, env: b.env, encoding: 'utf8' });
  assert.equal(status.status, 4);
  assert.equal(JSON.parse(status.stdout)[0].status, 'NEEDS_REVIEW');
});

// A person may close an invoice the provider short-paid or never confirmed; the books follow what the provider settled.
test('resolve: closing a bill books it only on the provider\'s exact settlement; a short charge or an unreadable one goes to review', () => {
  const cases = [
    { mode: 'charged-other-amount', at: 'EXCEPTION', resolveMode: 'ok', status: 'NEEDS_REVIEW', detail: /PROVIDER_SETTLED_USD 1_APPROVED_USD 100\.00/ },
    { mode: 'provider-down-after-confirm', at: 'PAYMENT_UNKNOWN', resolveMode: 'provider-down-after-confirm', status: 'NEEDS_REVIEW', detail: /NO_PROVIDER_SETTLEMENT/ },
    { mode: 'provider-down-after-confirm', at: 'PAYMENT_UNKNOWN', resolveMode: 'ok', status: 'PENDING', detail: null },
  ];
  for (const c of cases) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    b.pay('mdt_bill1', { FAKE_AWX_MODE: c.mode });
    const key = `entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`;
    const before = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
    assert.equal((before.prepare('SELECT state FROM obligations WHERE key = ?').get(key) as { state: string }).state, c.at, c.mode);
    before.close();
    const r = b.run(HOROS, ['resolve', key, 'PAID', 'closed by AP after review'], { FAKE_AWX_MODE: c.resolveMode });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.obligation.state, 'PAID', 'the invoice is closed either way');
    assert.equal(out.accounting.status, c.status, `${c.mode} resolved with the provider ${c.resolveMode}`);
    if (c.detail) assert.match(out.accounting.detail, c.detail);
    if (c.detail) assert.match(r.stderr, /invoice closed; its accounting entry is held for review, not booked/);
  }
});

// The decisive case: one provider-confirmed payment whose acknowledgement was lost, then a person tries to reopen.
test('resolve: a bill whose payment succeeded cannot be reopened, so a second mandate cannot pay it again', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const digest = b.digestOf(b.approveAs('cass').stdout);
  b.mandateFor('mdt_bill1', digest);
  b.mandateFor('mdt_bill2', digest);
  assert.equal(b.pay('mdt_bill1', { FAKE_AWX_MODE: 'provider-down-after-confirm' }).code, 3);
  assert.equal(stateOf(b), 'PAYMENT_UNKNOWN');
  // Provider still unreachable: nothing proves the charge failed, so the invoice stays closed to retry.
  const blind = b.run(HOROS, ['resolve', KEY, 'OPEN', 'looks failed to me'], { FAKE_AWX_MODE: 'provider-down-after-confirm' });
  assert.equal(blind.code, 1);
  assert.match(blind.stderr, /not reopened: the provider does not prove this attempt unpaid/);
  // Provider readable: it shows the charge succeeded, so reopening is refused again.
  const seen = b.run(HOROS, ['resolve', KEY, 'OPEN', 'looks failed to me']);
  assert.equal(seen.code, 1);
  assert.match(seen.stderr, /"status":"SUCCEEDED"/);
  assert.equal(stateOf(b), 'PAYMENT_UNKNOWN');
  assert.equal(b.pay('mdt_bill2').code, 1);
  assert.equal(b.last().refused, 'OBLIGATION_PAYMENT_UNKNOWN');
  // Recovery then settles it as the one payment it was, and Airi hears SUCCEEDED for that mandate only.
  assert.equal(b.run(AIRI, ['reconcile', '--bill', SLACK100]).code, 0);
  assert.equal(stateOf(b), 'PAID');
  assert.equal(succeededIntents(b), 1, 'one charge at the provider');
  assert.deepEqual(b.airiCalls().filter((c) => c[1] === 'result').map((c) => `${c[3]}:${c[5]}`), ['mdt_bill1:SUCCEEDED']);
});

test('resolve: a short-paid exception cannot be reopened for a second charge either', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  b.pay('mdt_bill1', { FAKE_AWX_MODE: 'charged-other-amount' });
  assert.equal(stateOf(b), 'EXCEPTION');
  const r = b.run(HOROS, ['resolve', KEY, 'OPEN', 'retry the full amount']);
  assert.equal(r.code, 1);
  assert.equal(stateOf(b), 'EXCEPTION');
});

test('resolve: a genuinely cancelled attempt can still be reopened, and the retry pays once', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const digest = b.digestOf(b.approveAs('cass').stdout);
  b.mandateFor('mdt_bill1', digest);
  b.mandateFor('mdt_bill2', digest);
  // T:0 down before confirm: the intent is created, never confirmed, and cancelled.
  assert.equal(b.pay('mdt_bill1', { FAKE_T0_FAIL_FROM: '3' }).code, 1);
  // A person is asked to decide on that attempt, as after an unclear recovery.
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  const attempt = (db.prepare("SELECT attempt_id FROM history WHERE key = ? AND to_state = 'RESERVED'").get(KEY) as { attempt_id: string }).attempt_id;
  db.prepare("UPDATE obligations SET state = 'PAYMENT_UNKNOWN', attempt_id = ?, rail = 'VIC_CHECKOUT' WHERE key = ?").run(attempt, KEY);
  db.close();
  const r = b.run(HOROS, ['resolve', KEY, 'OPEN', 'provider shows the intent cancelled']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(stateOf(b), 'OPEN');
  assert.equal(b.pay('mdt_bill2').code, 0);
  assert.equal(succeededIntents(b), 1);
  assert.deepEqual(b.airiCalls().filter((c) => c[1] === 'result').map((c) => `${c[3]}:${c[5]}`), ['mdt_bill1:DECLINED', 'mdt_bill2:SUCCEEDED']);
});

test('resolve: an attempt that never journaled an intent id never sent a confirm, so it can be reopened', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.digestOf(b.approveAs('cass').stdout);
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  db.prepare("UPDATE obligations SET state = 'PAYMENT_UNKNOWN', attempt_id = 'att-no-intent', rail = 'VIC_CHECKOUT' WHERE key = ?").run(KEY);
  db.close();
  const r = b.run(HOROS, ['resolve', KEY, 'OPEN', 'no intent was ever created']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(stateOf(b), 'OPEN');
});

// Checkout authority must still hold at the instant of confirmation, however long the last source read took.
test('bill: a mandate or an approval that expires during the last source read is never confirmed; a slow read inside both still pays', () => {
  const cases = [
    { name: 'mandate', mandateMs: 15 * 60_000, slowMs: 20 * 60_000, finding: 'MANDATE_EXPIRED', other: 'APPROVAL_EXPIRED' },
    { name: 'approval', mandateMs: 100 * 3_600_000, slowMs: 73 * 3_600_000, finding: 'APPROVAL_EXPIRED', other: 'MANDATE_EXPIRED' },
  ];
  for (const c of cases) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout), STAND_IN, c.mandateMs);
    const r = b.pay('mdt_bill1', { FAKE_T0_SLOW_FROM: `3:${c.slowMs}` });
    assert.equal(r.code, 1, c.name);
    assert.match(b.last().error, new RegExp(c.finding), c.name);
    assert.doesNotMatch(b.last().error, new RegExp(c.other), `${c.name} expired alone`);
    assert.equal(b.last().state, 'OPEN', c.name);
    assert.ok(!b.paCalls().some((p) => p.path.endsWith('/confirm')), `${c.name}: never confirmed`);
    assert.ok(b.paCalls().some((p) => p.path.endsWith('/cancel')), `${c.name}: the intent was cancelled`);
  }
  const control = billSandbox();
  control.queue(['import']);
  control.verify();
  control.mandateFor('mdt_bill1', control.digestOf(control.approveAs('cass').stdout));
  assert.equal(control.pay('mdt_bill1', { FAKE_T0_SLOW_FROM: '3:60000' }).code, 0, 'a minute-long read inside both windows');
});

test('bill: a mandate with less time left than the confirm call can take is not confirmed; one with enough is', () => {
  for (const [leftMs, pays] of [[45_000, false], [90_000, true]] as const) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout), STAND_IN, 15 * 60_000);
    const r = b.pay('mdt_bill1', { FAKE_T0_SLOW_FROM: `3:${15 * 60_000 - leftMs}` });
    assert.equal(r.code, pays ? 0 : 1, `${leftMs} ms left`);
    if (!pays) assert.match(b.last().error, /MANDATE_EXPIRED/);
    assert.equal(b.paCalls().filter((p) => p.path.endsWith('/confirm')).length, pays ? 1 : 0, `${leftMs} ms left`);
  }
});

test('bill: a source bill with two vendors, or open with a paid or voided date, is held from a fresh read and never paid', () => {
  const variants: [string, (row: any) => void][] = [
    ['second vendor after', (row) => row.links.push({ dataType: 'Vendor', externalId: 'other-sandbox-vendor' })],
    ['second vendor before', (row) => row.links.unshift({ dataType: 'Vendor', externalId: 'other-sandbox-vendor' })],
    ['paid date', (row) => (row.data.paidDate = '2026-11-11')],
    ['voided date', (row) => (row.data.voidedDate = '2026-11-11')],
  ];
  for (const [name, change] of variants) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    const page = structuredClone(T0_PAGE);
    change(page.data.find((r: any) => r.id.externalId === SLACK100));
    b.setPage(page);
    assert.equal(b.pay('mdt_bill1').code, 1, name);
    assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW', name);
    assert.ok(b.last().flags.some((f: any) => f.kind === 'SOURCE_CONFLICT'), name);
    assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0], name);
    assert.match(b.queue(['show']).stdout, /the T:0 record contradicts itself/, name);
  }
});

// A known duplicate stays held when its other copy leaves the open list, however it left.
test('bill: a duplicate stays held after its other copy is paid, voided or dropped; a different invoice from the same vendor still pays', () => {
  const sibling = (status: string) => {
    const copy = structuredClone(T0_PAGE.data.find((r: any) => r.id.externalId === SLACK100));
    copy.id.externalId = 'same-invoice-second-record';
    copy.data.status = status;
    return copy;
  };
  for (const disposition of ['paid', 'voided', 'dropped']) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    // The copy appears open alongside the approved bill: both are held.
    b.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, sibling('open')] });
    b.queue(['import']);
    assert.match(b.queue(['show']).stdout, /^HOLD_FOR_REVIEW .*INV-20250201-1234/m, disposition);
    // Then it leaves the open list: the surviving copy must stay held on the approval it already had.
    b.setPage({ ...T0_PAGE, data: disposition === 'dropped' ? T0_PAGE.data : [...T0_PAGE.data, sibling(disposition)] });
    assert.equal(b.pay('mdt_bill1').code, 1, disposition);
    assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW', disposition);
    assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0], disposition);
    assert.match(b.queue(['show']).stdout, new RegExp(`not open in T:0: same-invoice-second-record \\(${disposition === 'dropped' ? 'no longer open' : disposition}\\)`), disposition);
  }
  // A copy already paid before HOROS ever saw it open is found in the history too.
  const early = billSandbox();
  early.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, sibling('paid')] });
  early.queue(['import']);
  assert.match(early.queue(['show']).stdout, /^HOLD_FOR_REVIEW .*INV-20250201-1234/m);
  // Control: last month's paid bill from the same vendor for the same amount, another invoice, is not a copy.
  const control = billSandbox();
  const other = sibling('paid');
  other.data.customFields = { ...other.data.customFields, bill_number: 'INV-20250101-0999', invoice_number: 'INV-20250101-0999' };
  other.data.date = '2025-01-01';
  other.data.dueDate = '2025-01-31';
  control.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, other] });
  control.queue(['import']);
  control.verify();
  control.mandateFor('mdt_bill1', control.digestOf(control.approveAs('cass').stdout));
  assert.equal(control.pay('mdt_bill1').code, 0);
});

test('bill: a copy first seen already paid keeps the bill held after it vanishes from T:0, across a restart', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  const paidCopy = structuredClone(T0_PAGE.data.find((r: any) => r.id.externalId === SLACK100));
  paidCopy.id.externalId = 'same-invoice-paid-record';
  paidCopy.data.status = 'paid';
  b.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, paidCopy] });
  b.queue(['import']);
  assert.match(b.queue(['show']).stdout, /^HOLD_FOR_REVIEW .*INV-20250201-1234/m);
  // The paid copy then disappears from the source entirely; every command below is a fresh process.
  b.setPage(T0_PAGE);
  b.queue(['import']);
  assert.match(b.queue(['show']).stdout, /not open in T:0: same-invoice-paid-record \(paid\)/);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
  assert.equal(b.paCalls().length, 0);
});
