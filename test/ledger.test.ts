import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LostOwnership, openLedger } from '../src/ledger.ts';
import { approvalTerms, cardControls } from '../src/policy.ts';
import { invoice, policy, vendor } from '../src/demo-data.ts';

const dbFile = () => join(mkdtempSync(join(tmpdir(), 'horos-ledger-')), 'horos.db');
const KEY = 'sandbox/INV-4417';

test('an obligation is reserved by exactly one attempt on one rail', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  const attempt = l.reserve(KEY, 'ISSUED_CARD', 'd1');
  assert.ok(attempt);
  assert.equal(l.reserve(KEY, 'VIC_CHECKOUT', 'd1'), undefined);
  assert.equal(l.reserve(KEY, 'ISSUED_CARD', 'd1'), undefined);
  assert.deepEqual([l.get(KEY)?.rail, l.get(KEY)?.attempt_id, l.owns(KEY, attempt)], ['ISSUED_CARD', attempt, true]);
  assert.ok(l.get(KEY)?.reserved_at);
});

test('five processes racing for the same obligation: exactly one wins', async () => {
  const file = dbFile();
  openLedger(file).open(KEY, 18640, 'USD');
  const ledgerUrl = new URL('../src/ledger.ts', import.meta.url).href;
  const script = `import { openLedger } from ${JSON.stringify(ledgerUrl)}; const l = openLedger(${JSON.stringify(file)}); process.stdout.write(String(Boolean(l.reserve(${JSON.stringify(KEY)}, 'ISSUED_CARD', 'd'))));`;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script]);
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('exit', () => resolve(out));
    })),
  );
  assert.equal(results.filter((r) => r === 'true').length, 1, results.join(','));
});

test('state survives a restart: a reopened ledger still refuses to pay a paid obligation', () => {
  const file = dbFile();
  const a = openLedger(file);
  a.open(KEY, 18640, 'USD');
  a.transition(KEY, a.reserve(KEY, 'ISSUED_CARD', 'd')!, 'RESERVED', 'PAID');
  a.close();
  const b = openLedger(file);
  assert.equal(b.get(KEY)?.state, 'PAID');
  assert.equal(b.reserve(KEY, 'VIC_CHECKOUT', 'd'), undefined);
});

test('an unknown payment blocks every rail until reconciled', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  const attempt = l.reserve(KEY, 'VIC_CHECKOUT', 'd')!;
  l.transition(KEY, attempt, 'RESERVED', 'PAYMENT_UNKNOWN', 'lost confirm');
  assert.equal(l.reserve(KEY, 'ISSUED_CARD', 'd'), undefined);
  l.transition(KEY, attempt, 'PAYMENT_UNKNOWN', 'OPEN', 'reconciled: not paid');
  assert.ok(l.reserve(KEY, 'ISSUED_CARD', 'd'));
});

test('paid is terminal, an exception leaves only by a decision, and transitions start from the current state', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  assert.throws(() => l.transition(KEY, 'x', 'PAID', 'OPEN'), /ILLEGAL_TRANSITION/);
  assert.throws(() => l.transition(KEY, 'x', 'EXCEPTION', 'RESERVED'), /ILLEGAL_TRANSITION/);
  assert.throws(() => l.transition(KEY, 'x', 'RESERVED', 'PAID'), LostOwnership, 'not reserved yet');
  assert.equal(l.get(KEY)?.state, 'OPEN');
});

test('only the owning attempt can journal or move the obligation, and a released attempt is locked out', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  const first = l.reserve(KEY, 'VIC_CHECKOUT', 'd')!;
  const op = { request_id: 'r1', obligation: KEY, rail: 'VIC_CHECKOUT' as const, kind: 'INTENT_CREATE', external_id: null, status: 'SENT', detail: null };
  assert.throws(() => l.record('someone-else', op), LostOwnership);
  assert.throws(() => l.transition(KEY, 'someone-else', 'RESERVED', 'OPEN'), LostOwnership);
  l.record(first, op);
  l.transition(KEY, first, 'RESERVED', 'OPEN', 'released');
  const second = l.reserve(KEY, 'ISSUED_CARD', 'd')!;
  assert.equal(l.owns(KEY, first), false);
  assert.throws(() => l.record(first, { ...op, request_id: 'r2', kind: 'CONFIRM' }), LostOwnership);
  assert.throws(() => l.transition(KEY, first, 'RESERVED', 'PAID'), LostOwnership);
  assert.deepEqual(l.operations(KEY, second), []);
  assert.equal(l.operations(KEY, first).length, 1);
});

test('an obligation cannot be re-registered with a different amount or currency', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  assert.throws(() => l.open(KEY, 19000, 'USD'), /OBLIGATION_TERMS_CHANGED/);
  assert.throws(() => l.open(KEY, 18640, 'EUR'), /OBLIGATION_TERMS_CHANGED/);
});

test('operations keep their external id when a later update has none', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  const attempt = l.reserve(KEY, 'VIC_CHECKOUT', 'd')!;
  l.record(attempt, { request_id: 'r1', obligation: KEY, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: 'int_1', status: 'SENT', detail: null });
  l.record(attempt, { request_id: 'r1', obligation: KEY, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: null, status: 'NO_RESPONSE', detail: 'timeout' });
  assert.deepEqual(
    l.operations(KEY).map((o) => [o.external_id, o.status]),
    [['int_1', 'NO_RESPONSE']],
  );
});

test('an attempt that reconcile has parked cannot journal its next side effect', () => {
  const l = openLedger(dbFile());
  l.open(KEY, 18640, 'USD');
  const attempt = l.reserve(KEY, 'VIC_CHECKOUT', 'd')!;
  l.transition(KEY, attempt, 'RESERVED', 'PAYMENT_UNKNOWN', 'parked by reconcile');
  assert.throws(() => l.record(attempt, { request_id: 'c1', obligation: KEY, rail: 'VIC_CHECKOUT', kind: 'CONFIRM', external_id: 'int_1', status: 'SENT', detail: null }), LostOwnership);
});

test('processes opening a brand-new ledger at the same moment all succeed', async () => {
  const ledgerUrl = new URL('../src/ledger.ts', import.meta.url).href;
  for (let round = 0; round < 3; round++) {
    const file = dbFile();
    const script = `import { openLedger } from ${JSON.stringify(ledgerUrl)}; openLedger(${JSON.stringify(file)}).close(); process.stdout.write('ok');`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => new Promise<string>((resolve) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        child.on('exit', () => resolve(out));
      })),
    );
    assert.deepEqual(results, Array(8).fill('ok'), `round ${round}`);
  }
});

test('one account-wide run at a time', () => {
  const l = openLedger(dbFile());
  assert.equal(l.lock('run', 'run-1'), true);
  assert.equal(l.lock('run', 'run-2'), false);
  l.unlock('run', 'run-2');
  assert.equal(l.lock('run', 'run-2'), false, 'only the holder can release');
  l.unlock('run', 'run-1');
  assert.equal(l.lock('run', 'run-2'), true);
});

test('a ledger from an older schema is refused instead of silently misread', () => {
  const file = dbFile();
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE obligations (key TEXT PRIMARY KEY); PRAGMA user_version = 1;');
  raw.close();
  assert.throws(() => openLedger(file), /LEDGER_SCHEMA_OUTDATED/);
});

test('a v6 ledger upgrades in place: its accounting entries are kept, with no settlement evidence on record', () => {
  const file = dbFile();
  const l = openLedger(file);
  l.open('e/b1', 10000, 'USD');
  l.close();
  const raw = new DatabaseSync(file);
  raw.exec("INSERT INTO accounting (key, record_id, attempt_id, provider_ref, payload, status, at) VALUES ('e/b1', 'r1', 'a1', 'int_1', '{}', 'PENDING', 'x')");
  raw.exec('ALTER TABLE accounting DROP COLUMN settlement; PRAGMA user_version = 6;');
  raw.close();
  const upgraded = openLedger(file);
  assert.deepEqual(upgraded.accounting().map((r) => [r.record_id, r.status, r.settlement]), [['r1', 'PENDING', null]]);
});

test('a stored approval whose terms were edited no longer counts as approved', () => {
  const file = dbFile();
  const l = openLedger(file);
  const terms = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy), policy);
  l.open(terms.obligation, 18640, 'USD');
  const saved = l.saveApproval(terms, 'tester');
  assert.equal(l.latestApproval(terms.obligation)?.digest, saved.digest);
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE approvals SET terms = ? WHERE digest = ?').run(JSON.stringify({ ...terms, amount: 9999 }), saved.digest);
  assert.equal(l.approval(saved.digest), undefined);
  assert.equal(l.latestApproval(terms.obligation), undefined);
});
