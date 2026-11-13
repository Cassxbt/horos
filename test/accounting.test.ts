import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ACCOUNTING, AIRI, billSandbox, FAKE, FAKE_T0, KEY, SLACK100, SLACK_VENDOR, T0_PAGE } from './harness.ts';

// What a paid bill owes the accounting system, and what Horos will and will not tell T:0.
test('accounting: a paid bill owes T:0 exactly one record; a lost acknowledgement, a race and a delay never make a second', async () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const store = join(b.cwd, 't0-store.json');
  const acct = (args: string[], mode = '') => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, ...args], {
      cwd: b.cwd,
      env: { ...b.env, T0_API_KEY: 'fake', T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_T0_MODE: mode },
      encoding: 'utf8',
    });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : undefined, stderr: r.stderr };
  };
  const owed = acct(['status']);
  assert.equal(owed.code, 3);
  assert.equal(owed.out.length, 1);
  assert.deepEqual([owed.out[0].obligation, owed.out[0].status], [`entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`, 'PENDING']);
  const recordId = owed.out[0].record;

  assert.equal(acct(['sync', '--bill', SLACK100], 'lose-ack').code, 3, 'stored by T:0, acknowledgement lost: still owed');
  const [w1, w2] = await Promise.all([0, 1].map(() => new Promise<number | null>((done) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_API_KEY: 'fake', T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_T0_MODE: 'not-yet-visible' },
      stdio: 'ignore',
    });
    c.on('exit', done);
  })));
  assert.deepEqual([w1, w2].sort(), [3, 3], 'two racing workers: accepted, not yet readable');
  assert.equal(acct(['status']).out[0].status, 'ACCEPTED');
  const final = acct(['sync', '--bill', SLACK100]);
  assert.equal(final.code, 0);
  assert.equal(final.out.records[0].status, 'CONFIRMED');
  const t0 = JSON.parse(readFileSync(store, 'utf8'));
  assert.deepEqual(Object.keys(t0.records), [recordId], 'exactly one accounting entry');
  const entry = t0.records[recordId];
  assert.deepEqual([entry.data.amount, entry.data.currencyCode, entry.links[0].externalId], [100, 'USD', SLACK100]);
  assert.equal(b.paCalls().filter((c) => c.path.endsWith('/confirm')).length, 1, 'accounting never pays again');
  assert.equal(b.airiCalls().filter((c) => c[1] === 'result').length, 1, 'and never reports again');
});

test('accounting: a refused record or a read-back that does not match goes to a person; T:0 being busy is retried', () => {
  for (const [mode, expected, code] of [['reject', 'REJECTED', 4], ['mismatch', 'MISMATCH', 4], ['busy', 'PENDING', 3]] as const) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    assert.equal(b.pay('mdt_bill1').code, 0);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_API_KEY: 'fake', T0_WRITE_ENABLED: '1', FAKE_T0_STORE: join(b.cwd, 't0-store.json'), FAKE_T0_MODE: mode },
      encoding: 'utf8',
    });
    assert.equal(r.status, code, mode);
    assert.equal(JSON.parse(r.stdout).records[0].status, expected, mode);
  }
});

test('accounting: writing to T:0 needs the explicit switch', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  b.pay('mdt_bill1');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env: { ...b.env, T0_API_KEY: 'fake', FAKE_T0_STORE: join(b.cwd, 't0-store.json') }, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not synced: set T0_WRITE_ENABLED=1/);
  assert.equal(existsSync(join(b.cwd, 't0-store.json')), false, 'nothing was sent');
  const status = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ACCOUNTING, 'status'], { cwd: b.cwd, env: b.env, encoding: 'utf8' });
  assert.equal(JSON.parse(status.stdout)[0].detail, null, 'and it is not marked as sent');
});

test('accounting: a bill changed in T:0 after approval is still booked as approved and paid; another entity gets no write', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1', { FAKE_AWX_MODE: 'kill-on-readback' }).code, null);
  // The source bill now says EUR and points at a replacement vendor.
  const drifted = structuredClone(T0_PAGE);
  const row = drifted.data.find((r: any) => r.id.externalId === SLACK100);
  row.data.currencyCode = 'EUR';
  row.links = [{ dataType: 'Vendor', externalId: 't0_vendor_replacement' }];
  row.expanded.vendor = [{ id: { dataType: 'Vendor', externalId: 't0_vendor_replacement' }, data: { name: 'Slack Technologies, Inc.' } }];
  b.setPage(drifted);
  b.queue(['import']);
  assert.equal(b.run(AIRI, ['reconcile', '--bill', SLACK100], { HOROS_STALE_MS: '0' }).code, 0);
  // A second entity also owes a record.
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  db.prepare("INSERT INTO obligations (key, amount_cents, currency, state, updated_at) VALUES ('entity_other/b1', 500, 'USD', 'PAID', 'x')").run();
  const otherPayload = { id: { dataType: 'BillPayment', externalId: 'other-record' }, data: { amount: 5, currencyCode: 'USD', date: '2026-11-11', type: 'bill', customFields: { airwallex_payment: 'int_x' } }, links: [{ dataType: 'VendorBill', externalId: 'b1' }, { dataType: 'Vendor', externalId: 'v1' }] };
  db.prepare("INSERT INTO accounting (key, record_id, attempt_id, provider_ref, payload, status, at) VALUES ('entity_other/b1', 'other-record', 'a', 'int_x', ?, 'PENDING', 'x')").run(JSON.stringify(otherPayload));
  db.close();
  const store = join(b.cwd, 't0-store.json');
  const sync = (mode = '') =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_API_KEY: 'fake', T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_T0_MODE: mode },
      encoding: 'utf8',
    });
  sync('lose-ack');
  const done = sync();
  assert.equal(done.status, 0, done.stdout + done.stderr);
  const t0 = JSON.parse(readFileSync(store, 'utf8'));
  const entries = Object.values(t0.records) as any[];
  assert.equal(entries.length, 1, 'exactly one entry, and none for the other entity');
  const [entry] = entries;
  const intent = b.calls().find((c) => c.path.endsWith('/pa/payment_intents/create'))!;
  assert.deepEqual(
    [entry.data.amount, entry.data.currencyCode, entry.links.find((l: any) => l.dataType === 'Vendor').externalId, entry.links.find((l: any) => l.dataType === 'VendorBill').externalId],
    [100, 'USD', SLACK_VENDOR, SLACK100],
  );
  assert.ok(entry.data.customFields.airwallex_payment.startsWith('int_'), 'names the Airwallex payment');
  assert.ok(intent);
  const check = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  assert.equal((check.prepare("SELECT status FROM accounting WHERE key = 'entity_other/b1'").get() as { status: string }).status, 'PENDING');
  check.close();
});

// Entries written by an older version, or edited on disk, are checked again before T:0 ever sees them.
test('accounting: a stored entry that no longer matches the approval and settlement is held, whether unsent, accepted or confirmed', () => {
  for (const status of ['PENDING', 'ACCEPTED', 'CONFIRMED']) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    assert.equal(b.pay('mdt_bill1').code, 0);
    const key = `entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`;
    const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
    const row = db.prepare('SELECT payload FROM accounting WHERE key = ?').get(key) as { payload: string };
    // The round-five failure: EUR and a replacement vendor for an approved USD payment.
    const bad = JSON.parse(row.payload);
    bad.data.currencyCode = 'EUR';
    bad.links = [bad.links[0], { dataType: 'Vendor', externalId: 't0_vendor_replacement' }];
    db.prepare('UPDATE accounting SET payload = ?, status = ? WHERE key = ?').run(JSON.stringify(bad), status, key);
    db.close();
    const store = join(b.cwd, 't0-store.json');
    const env = { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store };
    const audit = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ACCOUNTING, 'status'], { cwd: b.cwd, env, encoding: 'utf8' });
    assert.equal(audit.status, 4, status);
    assert.deepEqual(JSON.parse(audit.stdout)[0].problems, ['PAYLOAD_DIFFERS:data.currencyCode,links'], status);
    const sync = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env, encoding: 'utf8' });
    assert.equal(sync.status, 4, status);
    const [record] = JSON.parse(sync.stdout).records;
    assert.equal(record.status, 'NEEDS_REVIEW', status);
    assert.match(record.detail, status === 'PENDING' ? /^not sent: / : /^already sent to T:0; check record horos-payment-\w+ there before amending: /);
    assert.equal(existsSync(store), false, `${status}: nothing was sent or read back`);
  }
});

test('accounting: a stored entry edited anywhere, even in fields T:0 might not echo back, is held and never sent', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  const row = db.prepare('SELECT payload FROM accounting').get() as { payload: string };
  const edited = JSON.parse(row.payload);
  Object.assign(edited.id, { dataType: 'Invoice' });
  Object.assign(edited.data, { type: 'refund', date: '1999-01-01', memo: 'added' });
  db.prepare('UPDATE accounting SET payload = ?').run(JSON.stringify(edited));
  db.close();
  const store = join(b.cwd, 't0-store.json');
  const sync = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env: { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store }, encoding: 'utf8' });
  assert.equal(sync.status, 4);
  assert.equal(JSON.parse(sync.stdout).records[0].detail, 'not sent: PAYLOAD_DIFFERS:id,data.date,data.type,data.memo');
  assert.equal(existsSync(store), false);
});

test('accounting: a malformed read-back from T:0 is a mismatch for a person, not a crash', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const store = join(b.cwd, 't0-store.json');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
    cwd: b.cwd,
    env: { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_T0_MODE: 'malformed' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 4, r.stderr);
  assert.equal(JSON.parse(r.stdout).records[0].status, 'MISMATCH');
});

test('accounting: an entry stored before settlement evidence was kept is held for review, never sent', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  db.exec('UPDATE accounting SET settlement = NULL');
  db.close();
  const store = join(b.cwd, 't0-store.json');
  const sync = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env: { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store }, encoding: 'utf8' });
  assert.equal(sync.status, 4);
  assert.match(JSON.parse(sync.stdout).records[0].detail, /NO_PROVIDER_SETTLEMENT/);
  assert.equal(existsSync(store), false);
});

test('accounting: an entry held after a send whose acknowledgement was lost says delivery is unknown, never "not sent"', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const store = join(b.cwd, 't0-store.json');
  const sync = (mode = '') =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_T0_MODE: mode },
      encoding: 'utf8',
    });
  assert.equal(sync('lose-ack').status, 3);
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  db.exec('UPDATE accounting SET settlement = NULL');
  const recordId = (db.prepare('SELECT record_id FROM accounting').get() as { record_id: string }).record_id;
  db.close();
  const held = sync();
  assert.equal(held.status, 4);
  const [record] = JSON.parse(held.stdout).records;
  assert.equal(record.status, 'NEEDS_REVIEW');
  assert.equal(record.detail, `delivery to T:0 unknown (sent, never acknowledged); check record ${recordId} there before amending: NO_PROVIDER_SETTLEMENT`);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(store, 'utf8')).records), [recordId], 'T:0 does hold it');
});

test('accounting: an entry whose stored payload or settlement no longer parses is held with that reason; other entries stay visible', () => {
  for (const column of ['payload', 'settlement']) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    assert.equal(b.pay('mdt_bill1').code, 0);
    // A second, healthy-looking entry for another bill of the same entity.
    const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
    db.exec("INSERT INTO obligations (key, amount_cents, currency, state, updated_at) VALUES ('entity_prod_ieEAMzvhgtHalvsm/other', 500, 'USD', 'PAID', 'x')");
    db.exec("INSERT INTO accounting (key, record_id, attempt_id, provider_ref, payload, status, at) VALUES ('entity_prod_ieEAMzvhgtHalvsm/other', 'other-record', 'a', 'int_x', 'null', 'PENDING', 'x')");
    db.prepare(`UPDATE accounting SET ${column} = '{"truncated": ' WHERE key = ?`).run(KEY);
    db.close();
    const env = { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: join(b.cwd, 't0-store.json') };
    const status = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ACCOUNTING, 'status'], { cwd: b.cwd, env, encoding: 'utf8' });
    assert.equal(status.status, 4, `${column}: ${status.stderr}`);
    const rows = JSON.parse(status.stdout);
    assert.equal(rows.length, 2, `${column}: both entries listed`);
    assert.ok(rows.find((r: any) => r.obligation === KEY).problems.includes(`${column.toUpperCase()}_UNREADABLE`), column);
    const sync = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env, encoding: 'utf8' });
    assert.equal(sync.status, 4, `${column}: ${sync.stderr}`);
    assert.equal(JSON.parse(sync.stdout).records[0].status, 'NEEDS_REVIEW', column);
    assert.equal(existsSync(env.FAKE_T0_STORE), false, `${column}: nothing sent`);
  }
});

test('accounting: a stored approval that no longer parses holds that entry for review and hides no other', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  db.exec("INSERT INTO obligations (key, amount_cents, currency, state, updated_at) VALUES ('entity_prod_ieEAMzvhgtHalvsm/other', 500, 'USD', 'PAID', 'x')");
  db.exec("INSERT INTO accounting (key, record_id, attempt_id, provider_ref, payload, status, at) VALUES ('entity_prod_ieEAMzvhgtHalvsm/other', 'other-record', 'a', 'int_x', 'null', 'PENDING', 'x')");
  db.exec(`UPDATE approvals SET terms = '{"trunc'`);
  db.close();
  const env = { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: join(b.cwd, 't0-store.json') };
  const status = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ACCOUNTING, 'status'], { cwd: b.cwd, env, encoding: 'utf8' });
  assert.equal(status.status, 4, status.stderr);
  const rows = JSON.parse(status.stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find((r: any) => r.obligation === KEY).problems, ['NO_APPROVAL']);
  const sync = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], { cwd: b.cwd, env, encoding: 'utf8' });
  assert.equal(sync.status, 4, sync.stderr);
  assert.equal(existsSync(env.FAKE_T0_STORE), false);
});

test('accounting: a 202 counts as accepted only when its counters account for the one record sent', () => {
  for (const [mode, status, code] of [['', 'ACCEPTED', 3], ['ack-empty', 'PENDING', 3], ['ack-zero', 'PENDING', 3]] as const) {
    const b = billSandbox();
    b.queue(['import']);
    b.verify();
    b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
    assert.equal(b.pay('mdt_bill1').code, 0);
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_WRITE_ENABLED: '1', FAKE_T0_STORE: join(b.cwd, 't0-store.json'), FAKE_T0_MODE: mode || 'not-yet-visible' },
      encoding: 'utf8',
    });
    const out = JSON.parse(r.stdout);
    assert.equal(r.status, code, mode);
    assert.equal(out.records[0].status, status, mode || 'counted');
    if (status === 'ACCEPTED') assert.deepEqual(JSON.parse(out.records[0].detail), { received: 1, inserted: 1, duplicates: 0 }, 'the counters are kept');
    else assert.match(out.moved.at(-1).detail, /^delivery unverified: 202 without a count for this record/, mode);
  }
});

test('accounting: nothing goes to the books until the provider reports the payment settled; then exactly one record', () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill1').code, 0);
  const store = join(b.cwd, 't0-store.json');
  const sync = (attempt?: string) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE, ACCOUNTING, 'sync', '--bill', SLACK100], {
      cwd: b.cwd,
      env: { ...b.env, T0_API_KEY: 'fake', T0_WRITE_ENABLED: '1', FAKE_T0_STORE: store, FAKE_PA_ATTEMPT: attempt ?? '' },
      encoding: 'utf8',
    });
    return { code: r.status, out: JSON.parse(r.stdout) };
  };
  const early = sync('CAPTURE_REQUESTED');
  assert.equal(early.code, 3, 'still owed');
  assert.match(early.out.moved[0].detail, /waiting for settlement: the payment attempt is CAPTURE_REQUESTED/);
  assert.deepEqual([early.out.records[0].status, early.out.records[0].detail], ['PENDING', null], 'never marked as sent');
  assert.equal(existsSync(store), false, 'nothing reached T:0');
  const settled = sync();
  assert.equal(settled.code, 0);
  assert.equal(settled.out.records[0].status, 'CONFIRMED');
  assert.equal(Object.keys(JSON.parse(readFileSync(store, 'utf8')).records).length, 1);
});
