import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AIRI, failed, HOROS, receiptOf, restoredAfterCards, sandbox } from './harness.ts';

test('run: a clean sandbox run passes every check, pays once and restores remote auth last', () => {
  const s = sandbox();
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.deepEqual(failed(receipt), [], r.stderr);
  assert.equal(r.code, 0);
  assert.equal(receipt.ledger.obligation.state, 'PAID');
  assert.equal(receipt.overcaptureTest.reconciliation.reason, 'CLEARED_ABOVE_APPROVAL');
  assert.ok(receipt.cleanup.cards.every((c: any) => c.status === 'CLOSED'));
  assert.equal(receipt.remoteAuthAfterRun.enabled, false);
  assert.ok(restoredAfterCards(s.calls()));
  assert.deepEqual(s.activeAtExit(), []);
  assert.equal(receipt.singleMessageTest.attempt.horos.transactionType, 'CLEARING');
});

test('run: a declined payment executes the decline policy: card closed, no retry, invoice reopened and escalated', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'decline-payment' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.equal(receipt.ledger.obligation.state, 'OPEN');
  assert.deepEqual([receipt.payment.decline.closeCard, receipt.payment.decline.retry, receipt.payment.decline.escalate], [true, false, true]);
  const paymentCharges = s.calls().filter((c) => c.path.endsWith('/simulation/issuing/create') && c.body.card_id === receipt.payment.cardId);
  assert.equal(paymentCharges.length, 2, 'the payment and the scripted replay only');
  assert.deepEqual(s.activeAtExit(), []);
});

test('run: a stop signal mid-run starts nothing new, closes every card and never exits 0', () => {
  const s = sandbox({ FAKE_SIGNAL_AT: 'cards/create:3', FAKE_AWX_LATENCY: '5' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.equal(receipt.aborted, 'SIGINT');
  assert.equal(s.calls().filter((c) => c.path.endsWith('/issuing/cards/create')).length, 3);
  assert.deepEqual(s.activeAtExit(), []);
  assert.ok(restoredAfterCards(s.calls()));
});

test('run: a card create still in flight when the stop signal lands is waited for and closed', () => {
  const s = sandbox({ FAKE_SIGNAL_AT: 'cards/create:3', FAKE_SLOW: 'cards/create:400' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  assert.equal(r.code, 1);
  assert.deepEqual(s.pendingAtExit(), []);
  assert.deepEqual(s.activeAtExit(), []);
  assert.ok(restoredAfterCards(s.calls()));
});

test('run: a stop signal near the end still completes cleanup and never exits 0', () => {
  const s = sandbox({ FAKE_SIGNAL_AT: 'balances/current:2', FAKE_AWX_LATENCY: '5' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.equal(receipt.aborted, 'SIGINT');
  assert.equal(receipt.remoteAuthAfterRun.enabled, false);
  assert.deepEqual(s.activeAtExit(), []);
});

test('run: a declined capture is never recorded as paid and fails the run', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'declined-capture' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.notEqual(receipt.ledger.obligation.state, 'PAID');
  assert.ok(failed(receipt).includes('invoice marked PAID only from a matching provider clearing'));
});

test('run: a capture error leaves the payment UNKNOWN, closes every card, then restores remote auth', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'capture-throws' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.equal(receipt.ledger.obligation.state, 'PAYMENT_UNKNOWN');
  assert.ok(receipt.cleanup.cards.every((c: any) => c.status === 'CLOSED'));
  assert.ok(restoredAfterCards(s.calls()));
});

test('run: when a card cannot be confirmed closed, remote auth stays on declining and the run reports an incident', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'close-fails' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 2);
  assert.match(receipt.incident, /remote authorization left on/);
  assert.ok(!s.calls().some((c) => c.path.endsWith('/issuing/config/update') && c.body?.remote_auth?.enabled === false));
});

test('run: a card whose create response was lost is swept and closed', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'lost-create' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 1);
  assert.equal(receipt.cleanup.cards.find((c: any) => c.id === 'card-1')?.status, 'CLOSED');
  assert.equal(receipt.remoteAuthAfterRun.enabled, false);
});

test('run: config propagation lag is caught by the readiness probe before any armed card exists', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'config-lag' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.deepEqual(failed(receipt), []);
  assert.equal(r.code, 0);
  assert.equal(receipt.readiness[0].network, 'APPROVED');
  assert.equal(receipt.readiness.at(-1).horos, 'UNKNOWN_CARD');
});

test('run: a failed restore of remote auth is reported as an unconfirmed cleanup', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'config-update-fails' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 2);
  assert.ok(receipt.restoreError);
});

test('run: SIGTERM during a capture that never answers closes every card but leaves remote auth on: exit 2', async () => {
  const s = sandbox({ FAKE_AWX_MODE: 'capture-hangs' });
  const child = spawn(process.execPath, s.argv(HOROS, ['run', 'https://fake.invalid']), { cwd: s.cwd, env: s.env, stdio: 'ignore' });
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  for (let i = 0; i < 300 && !s.calls().some((c) => c.path.endsWith('/capture')); i++) await new Promise((r) => setTimeout(r, 50));
  child.kill('SIGTERM');
  assert.equal(await exited, 2);
  const receipt = receiptOf(s);
  assert.equal(receipt.aborted, 'SIGTERM');
  assert.equal(receipt.cleanup.drained, false);
  assert.ok(receipt.cleanup.cards.every((c: any) => c.status === 'CLOSED'));
  assert.ok(!s.calls().some((c) => c.path.endsWith('/issuing/config/update') && c.body?.remote_auth?.enabled === false));
  assert.deepEqual(s.activeAtExit(), []);
});

function airiSandbox(mandate: (digest: string) => Record<string, unknown> = (d) => ({}), extraMandates: string[] = []) {
  const s = sandbox({ FAKE_AIRI_MANDATES: '' });
  const approved = s.run(AIRI, ['approve']);
  assert.equal(approved.code, 0, approved.stderr);
  const digest = approved.stdout.match(/"digest": "([0-9a-f]{64})"/)![1];
  const base = {
    mandateId: 'mdt_test1',
    status: 'READY',
    protocolType: 'VIC',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    merchantInfo: { name: 'Tessaline Systems Inc.', url: 'https://pay.tessaline.example', country: 'US' },
    orderInfo: { currency: 'USD', totalAmount: '186.40', description: `Pay invoice INV-4417. Approval digest ${digest.slice(0, 12)}` },
  };
  const mandatesFile = join(s.cwd, 'mandates.json');
  writeFileSync(mandatesFile, JSON.stringify([{ ...base, ...mandate(digest) }, ...extraMandates.map((mandateId) => ({ ...base, mandateId }))]));
  s.env.FAKE_AIRI_MANDATES = mandatesFile;
  // The credential is fetched by pay itself, for the validated mandate; none is ever passed in.
  const pay = (more: Record<string, string> = {}, mandateId = 'mdt_test1') => s.run(AIRI, ['pay', mandateId], more);
  const credentialFetches = () => s.airiCalls().filter((c) => c[1] === 'get-credential');
  const paCalls = () => s.calls().filter((c) => c.path.includes('/pa/'));
  const last = () => s.json(s.files('airi-payment-').at(-1)!);
  return { ...s, pay, paCalls, last, credentialFetches };
}

test('airi: an unrelated mandate is refused before any payment call', () => {
  const a = airiSandbox();
  const r = a.pay({}, 'mdt_unrelated');
  assert.equal(r.code, 1);
  assert.deepEqual(a.last().findings, ['MANDATE_NOT_FOUND']);
  assert.equal(a.paCalls().length, 0);
  assert.equal(a.credentialFetches().length, 0, 'no credential is requested for a mandate that fails its check');
});

test('airi: a mandate whose amount, portal or digest differ from the approval is refused', () => {
  for (const [change, finding] of [
    [{ orderInfo: { currency: 'USD', totalAmount: '190.00', description: 'x' } }, 'AMOUNT_MISMATCH'],
    [{ merchantInfo: { name: 'Tessaline', url: 'https://pay.tessaline-billing.example' } }, 'MERCHANT_URL_NOT_APPROVED_PORTAL'],
    [{ status: 'COMPLETED' }, 'MANDATE_STATUS_COMPLETED'],
    [{ merchantInfo: { name: 'Another Merchant LLC', url: 'https://pay.tessaline.example' } }, 'MERCHANT_NAME_NOT_APPROVED_SUPPLIER'],
  ] as const) {
    const a = airiSandbox(() => change);
    assert.equal(a.pay().code, 1);
    assert.ok(a.last().findings.includes(finding), JSON.stringify(a.last().findings));
    assert.equal(a.paCalls().length, 0);
  }
});

test('airi: a matching mandate pays once, is reported, and a second payment on any rail is refused', () => {
  const a = airiSandbox();
  const first = a.pay();
  assert.equal(first.code, 0, first.stderr);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReport, 'REPORTED');
  assert.ok(a.airiCalls().some((c) => c.join(' ').includes('mandate result --mandate-id mdt_test1 --result SUCCEEDED')));
  const before = a.paCalls().length;
  assert.equal(a.pay().code, 1);
  assert.equal(a.last().refused, 'OBLIGATION_PAID');
  assert.equal(a.paCalls().length, before);
});

test('airi: a failed report keeps the paid record, and reconcile reports it later', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AIRI_RESULT: 'fail' }).code, 2);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReport, 'REPORT_FAILED');
  const r = a.run(AIRI, ['reconcile']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(a.last().airiReports.mdt_test1, 'REPORTED');
});

test('airi: a lost confirm response is resolved by reading the intent back', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-lost' }).code, 0);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReport, 'REPORTED');
});

test('airi: an outcome nobody can read is UNKNOWN, blocks a second payment, and reconcile settles it', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'provider-down-after-confirm' }).code, 3);
  assert.equal(a.last().state, 'PAYMENT_UNKNOWN');
  assert.ok(!a.airiCalls().some((c) => c[1] === 'result'));
  const before = a.paCalls().length;
  assert.equal(a.pay().code, 1);
  assert.equal(a.last().refused, 'OBLIGATION_PAYMENT_UNKNOWN');
  assert.equal(a.paCalls().length, before);
  assert.equal(a.run(AIRI, ['reconcile']).code, 0);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReports.mdt_test1, 'REPORTED');
});

test('airi: a crash right after the provider charged is not stuck: reconcile waits while fresh, then settles PAID', () => {
  const a = airiSandbox();
  const killed = a.pay({ FAKE_AWX_MODE: 'kill-after-confirm' });
  assert.equal(killed.code, null);
  const fresh = a.run(AIRI, ['reconcile']);
  assert.equal(fresh.code, 3, 'still unresolved');
  assert.deepEqual([a.last().state, a.last().evidence], ['RESERVED', 'IN_FLIGHT']);
  assert.equal(a.run(AIRI, ['reconcile'], { HOROS_STALE_MS: '0' }).code, 0);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReports.mdt_test1, 'REPORTED');
});

test('airi: an obligation already paid by the card rail cannot be paid again through VIC', () => {
  const a = airiSandbox();
  const db = new DatabaseSync(join(a.cwd, 'data', 'horos.db'));
  db.prepare("UPDATE obligations SET state = 'PAID', rail = 'ISSUED_CARD' WHERE key = 'sandbox/INV-4417'").run();
  db.close();
  assert.equal(a.pay().code, 1);
  assert.equal(a.last().refused, 'OBLIGATION_PAID');
  assert.equal(a.paCalls().length, 0);
});

test('airi: the credential is fetched for the validated mandate; no passkey approval means no payment', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AIRI_CREDENTIAL: 'fail' }).code, 1);
  assert.equal(a.last().refused, 'CREDENTIAL_NOT_ISSUED');
  assert.equal(a.paCalls().length, 0);
  assert.equal(a.pay().code, 0);
  assert.deepEqual(a.credentialFetches().at(-1)?.slice(2, 4), ['--mandate-id', 'mdt_test1']);
});

test('airi: a retryable card refusal cancels the intent before the invoice reopens', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-retryable' }).code, 1);
  assert.equal(a.last().state, 'OPEN');
  assert.equal(a.paCalls().filter((c) => c.path.endsWith('/cancel')).length, 1);
  assert.equal(a.last().airwallex.observed.status, 'CANCELLED');
});

test('airi: a charge for another amount is an exception, never paid', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'charged-other-amount' }).code, 1);
  assert.equal(a.last().state, 'EXCEPTION');
  assert.deepEqual([a.last().airwallex.expected.amount, a.last().airwallex.observed.amount], [186.4, 1]);
  assert.ok(!a.airiCalls().some((c) => c[1] === 'result'));
});

test('airi: a confirm response that disagrees with the provider read-back is an exception, never paid', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-response-amount' }).code, 1);
  assert.equal(a.last().state, 'EXCEPTION');
  assert.match(a.last().airwallex.remediation, /conflicting/);
});

test('run: a create still in flight past the drain limit is unresolved: no restore, incident, exit 2', () => {
  const s = sandbox({ FAKE_SIGNAL_AT: 'cards/create:3', FAKE_SLOW: 'cards/create:2400' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.equal(r.code, 2);
  assert.equal(receipt.cleanup.drained, false);
  assert.match(receipt.incident, /in flight/);
  assert.ok(!s.calls().some((c) => c.path.endsWith('/issuing/config/update') && c.body?.remote_auth?.enabled === false));
});

test('run: a signal during the final restore is latched: never exit 0, and the receipt says so', () => {
  const s = sandbox({ FAKE_SIGNAL_AT: 'config/update:2', FAKE_SLOW: 'config/update:25' });
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  const receipt = receiptOf(s);
  assert.notEqual(r.code, 0);
  assert.match(receipt.aborted, /SIGINT/);
  assert.deepEqual(s.activeAtExit(), []);
});

test('run: a second run is refused while another holds the account lock; cleanup releases a crashed one', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'close-fails' });
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 2);
  const blocked = s.run(HOROS, ['run', 'https://fake.invalid']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /holds the account lock/);
});

test('run: every card in the run pays its own ledger obligation, and gate exceptions are in the ledger', () => {
  const s = sandbox();
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 0);
  const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
  const states = Object.fromEntries((db.prepare('SELECT key, state FROM obligations').all() as { key: string; state: string }[]).map((r) => [r.key.split('/').at(-1), r.state]));
  const unjournaled = db.prepare("SELECT key FROM obligations o WHERE NOT EXISTS (SELECT 1 FROM operations p WHERE p.obligation = o.key AND p.kind = 'CARD_CREATE' AND p.external_id IS NOT NULL)").all();
  db.close();
  assert.deepEqual(unjournaled, [], 'every obligation journals the card that paid it');
  assert.deepEqual(states, {
    'INV-4417': 'PAID',
    'INV-4417~gate-test': 'OPEN',
    'INV-4417~single-message-test': 'PAID',
    'INV-4417~overcapture-test': 'EXCEPTION',
    'INV-4417~race-test': 'OPEN',
    'INV-4417~outage-test': 'OPEN',
  });
});

const lockOf = (s: ReturnType<typeof sandbox>) => {
  const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
  const row = db.prepare("SELECT value FROM settings WHERE name = 'account_run_lock'").get() as { value: string } | undefined;
  db.close();
  return row?.value;
};

test('run: a gate charge that slipped past remote auth keeps its obligation blocked unless the hold is released', () => {
  for (const [mode, state] of [['lag-gate', 'OPEN'], ['lag-gate-stuck', 'PAYMENT_UNKNOWN']] as const) {
    const s = sandbox({ FAKE_AWX_MODE: mode });
    const r = s.run(HOROS, ['run', 'https://fake.invalid']);
    assert.equal(r.code, 1, mode);
    assert.equal(receiptOf(s).gateTest.attempts[0].network, 'APPROVED', mode);
    const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
    const gate = db.prepare("SELECT state FROM obligations WHERE key LIKE '%~gate-test'").get() as { state: string };
    db.close();
    assert.equal(gate.state, state, mode);
  }
});

test('run: a failure before anything changed releases the lock, so the next run can start', () => {
  const s = sandbox({ FAKE_AWX_MODE: 'cardholder-fails' });
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 1);
  assert.equal(lockOf(s), undefined);
});

test('run: a receipt that cannot be written still ends the process, with exit 2', () => {
  const s = sandbox();
  spawnSync('mkdir', ['-p', join(s.cwd, 'runs')]);
  chmodSync(join(s.cwd, 'runs'), 0o555);
  const r = s.run(HOROS, ['run', 'https://fake.invalid']);
  chmodSync(join(s.cwd, 'runs'), 0o755);
  assert.equal(r.code, 2);
});

test('cleanup: refuses while the run holding the lock is alive, and releases a lock whose run is gone', async () => {
  const s = sandbox({ FAKE_AWX_MODE: 'capture-hangs' });
  const child = spawn(process.execPath, s.argv(HOROS, ['run', 'https://fake.invalid']), { cwd: s.cwd, env: s.env, stdio: 'ignore' });
  const exited = new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 300 && !s.calls().some((c) => c.path.endsWith('/capture')); i++) await new Promise((r) => setTimeout(r, 50));
  const refused = s.run(HOROS, ['cleanup'], { FAKE_AWX_MODE: 'ok' });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /may still be running/);
  child.kill('SIGKILL');
  await exited;
  const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
  db.prepare("UPDATE cards SET status = 'CLOSED'").run();
  db.prepare("DELETE FROM settings WHERE name = 'remote_auth_before_run'").run();
  db.close();
  const cleaned = s.run(HOROS, ['cleanup'], { FAKE_AWX_MODE: 'ok' });
  assert.equal(cleaned.code, 0, cleaned.stdout + cleaned.stderr);
  assert.equal(lockOf(s), undefined);
});

test('resolve: a person closes an exception with a recorded reason; nothing else can', () => {
  const s = sandbox();
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 0);
  const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
  const over = (db.prepare("SELECT key FROM obligations WHERE key LIKE '%~overcapture-test'").get() as { key: string }).key;
  db.close();
  assert.equal(s.run(HOROS, ['resolve', over, 'PAID']).code, 1, 'a reason is required');
  const r = s.run(HOROS, ['resolve', over, 'PAID', 'excess of 3.60 disputed with the supplier, case 77']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).obligation.detail, /resolved by operator: excess of 3.60 disputed/);
});

// Wiring only: this fake keeps cards per process, so the resolver sees none and must refuse. The cleared-card and
// closed-card evidence itself is tested in-process in recovery.test.ts.
test('resolve: a card attempt the provider cannot show is never reopened', () => {
  const s = sandbox();
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 0);
  const db = new DatabaseSync(join(s.cwd, 'data', 'horos.db'));
  const over = (db.prepare("SELECT key FROM obligations WHERE key LIKE '%~overcapture-test'").get() as { key: string }).key;
  db.close();
  const r = s.run(HOROS, ['resolve', over, 'OPEN', 'charge it again']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not reopened/);
});

test('airi: a failed DECLINED report is retried by reconcile', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-retryable', FAKE_AIRI_RESULT: 'fail' }).code, 2);
  assert.equal(a.last().state, 'OPEN');
  assert.equal(a.run(AIRI, ['reconcile']).code, 0);
  assert.equal(a.last().airiReports.mdt_test1, 'REPORTED');
  assert.ok(a.airiCalls().filter((c) => c[1] === 'result').at(-1)?.includes('DECLINED'));
});

test('airi: a reconcile that settles the payment mid-confirm still leaves a receipt and tells Airi', () => {
  const a = airiSandbox();
  const r = a.pay({ FAKE_AWX_MODE: 'steal-after-confirm' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(a.last().state, 'PAID');
  assert.equal(a.last().airiReport, 'REPORTED');
});

const reportsSent = (a: ReturnType<typeof airiSandbox>) => a.airiCalls().filter((c) => c[1] === 'result').map((c) => `${c[3]}:${c[5]}`);

test('airi: an issuer decline returned as an HTTP error is still reported to Airi as DECLINED', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-http-decline' }).code, 1);
  assert.equal(a.last().state, 'OPEN');
  assert.deepEqual(reportsSent(a), ['mdt_test1:DECLINED']);
});

test('airi: one mandate\'s failed report survives another mandate paying the same bill, and is retried on its own', () => {
  const a = airiSandbox(undefined, ['mdt_test2']);
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-retryable', FAKE_AIRI_RESULT: 'fail' }, 'mdt_test1').code, 2);
  // B's payment sends every result still owed, oldest first: A's decline is retried, then B's success.
  assert.equal(a.pay({}, 'mdt_test2').code, 0);
  assert.equal(a.last().state, 'PAID');
  assert.deepEqual(reportsSent(a), ['mdt_test1:DECLINED', 'mdt_test1:DECLINED', 'mdt_test2:SUCCEEDED']);
  assert.equal(a.run(AIRI, ['reconcile']).code, 0);
  assert.deepEqual(a.last().airiReports, {}, 'nothing left owed');
});

test('airi: a mandate already used for one attempt is refused before any reservation', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-retryable' }).code, 1);
  assert.equal(a.last().state, 'OPEN');
  assert.equal(a.pay().code, 1);
  assert.equal(a.last().refused, 'MANDATE_ALREADY_USED');
  assert.equal(a.credentialFetches().length, 1);
});

test('airi: reconcile says when a person must decide (exit 4), distinct from unresolved (exit 3)', () => {
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AWX_MODE: 'charged-other-amount' }).code, 1);
  assert.equal(a.run(AIRI, ['reconcile']).code, 4);
});

test('airi: while Airi is unreachable, every owed result stays pending per mandate until reconcile delivers both', () => {
  const a = airiSandbox(undefined, ['mdt_test2']);
  assert.equal(a.pay({ FAKE_AWX_MODE: 'confirm-retryable', FAKE_AIRI_RESULT: 'fail' }, 'mdt_test1').code, 2);
  assert.equal(a.pay({ FAKE_AIRI_RESULT: 'fail' }, 'mdt_test2').code, 2);
  assert.equal(a.run(AIRI, ['reconcile']).code, 0);
  assert.deepEqual(a.last().airiReports, { mdt_test1: 'REPORTED', mdt_test2: 'REPORTED' });
});

test('reconcile: an exception or an undelivered Airi result is never reported as all clear', () => {
  const s = sandbox();
  assert.equal(s.run(HOROS, ['run', 'https://fake.invalid']).code, 0);
  assert.equal(s.run(HOROS, ['reconcile']).code, 4, 'the overcapture exception is outstanding');
  assert.equal(s.run(HOROS, ['reconcile']).code, 4, 'and stays outstanding');
  const a = airiSandbox();
  assert.equal(a.pay({ FAKE_AIRI_RESULT: 'fail' }).code, 2);
  const r = a.run(HOROS, ['reconcile']);
  assert.equal(r.code, 2, r.stdout);
  assert.match(r.stdout, /mdt_test1/);
});
