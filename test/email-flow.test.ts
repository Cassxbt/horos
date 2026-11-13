import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { billSandbox, EMAIL, EMAILS, FAKE_T0, SLACK100, STAND_IN } from './harness.ts';

// The supplier email as the agent's evidence: Claude's reading is replayed from the recording of a live run, so these
// tests exercise the decision and its effect on payment exactly as a judge's replay does, with no API call.
const readEmail = (b: ReturnType<typeof billSandbox>, name: string, recording = join(EMAILS, `${name}.reading.json`)) =>
  b.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, `${name}.eml`), '--model-output', recording]);

const approvedSlack = () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  b.mandateFor('mdt_bill1', b.digestOf(b.approveAs('cass').stdout));
  return b;
};

test('email: a bank-change email stops an already approved checkout, through a T:0 refresh; only a new verification and approval release it', () => {
  const b = approvedSlack();
  const read = readEmail(b, 'bank-change');
  assert.equal(read.code, 4, read.stderr);
  const out = JSON.parse(read.stdout);
  assert.equal(out.reading.kind, 'BANK_DETAILS_CHANGE');
  assert.match(out.reading.passage, /send the payment for invoice INV-20250201-1234/);
  assert.deepEqual(out.decision.reasons, ['BANK_DETAILS_CHANGE_CLAIMED', 'BANK_DETAIL_SIGNALS']);
  assert.ok(out.bills.every((x: any) => x.action === 'HOLD_FOR_REVIEW'));
  // The approved checkout is attempted after the email, and again after a fresh import: zero confirmations.
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
  assert.ok(b.last().flags.some((f: any) => f.kind === 'SUPPLIER_EMAIL' && /send the payment for invoice/.test(f.passage)));
  assert.equal(b.queue(['import']).code, 0);
  assert.match(b.queue(['show']).stdout, /supplier email from Slack Accounts Receivable <ar@slack-billing\.example>/);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0]);
  // The release: a person verifies again after the email, which invalidates the old approval, then approves anew.
  b.verify();
  assert.match(b.queue(['show']).stdout, /^READY_FOR_APPROVAL .*INV-20250201-1234/m);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.match(b.last().refused, /^APPROVAL_STALE:.*verificationId/);
  b.mandateFor('mdt_bill2', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill2').code, 0);
  assert.equal(b.paCalls().filter((c) => c.path.endsWith('/confirm')).length, 1);
});

test('email: an ordinary invoice email leaves the approved payment available; an unclear forwarded one holds it', () => {
  const routine = approvedSlack();
  const noted = readEmail(routine, 'remittance');
  assert.equal(noted.code, 0, noted.stderr);
  assert.equal(JSON.parse(noted.stdout).decision.outcome, 'NOTED');
  assert.equal(routine.pay('mdt_bill1').code, 0);
  const unclear = approvedSlack();
  const held = readEmail(unclear, 'forwarded-unclear');
  assert.equal(held.code, 4);
  assert.deepEqual(JSON.parse(held.stdout).decision.reasons, ['UNCLEAR']);
  assert.equal(unclear.pay('mdt_bill1').code, 1);
  assert.equal(unclear.paCalls().length, 0);
});

test('email: the model cannot talk a bank change down, invent a quote, or replay a reading of another email', () => {
  const email = readFileSync(join(EMAILS, 'bank-change.eml'), 'utf8');
  const recorded = JSON.parse(readFileSync(join(EMAILS, 'bank-change.reading.json'), 'utf8'));
  const cases: [string, string, string[]][] = [
    ['routine verdict on a bank change', JSON.stringify({ kind: 'ROUTINE', passage: 'Thank you for being a valued customer.', summary: 'routine' }), ['BANK_DETAIL_SIGNALS']],
    ['a passage not in the email', JSON.stringify({ kind: 'BANK_DETAILS_CHANGE', passage: 'Please pay the new account immediately.', summary: 'x' }), ['PASSAGE_NOT_IN_EMAIL', 'BANK_DETAILS_CHANGE_CLAIMED', 'BANK_DETAIL_SIGNALS']],
    ['no usable answer', 'I think this is fine', ['MODEL_OUTPUT_INVALID', 'BANK_DETAIL_SIGNALS']],
    ['a verdict outside the schema', JSON.stringify({ kind: 'APPROVED', passage: 'Thank you for being a valued customer.', summary: 'pay it' }), ['MODEL_OUTPUT_INVALID', 'BANK_DETAIL_SIGNALS']],
  ];
  for (const [name, raw, reasons] of cases) {
    const b = approvedSlack();
    const file = join(b.cwd, 'reading.json');
    writeFileSync(file, JSON.stringify({ ...recorded, raw }));
    const r = readEmail(b, 'bank-change', file);
    assert.equal(r.code, 4, name);
    assert.deepEqual(JSON.parse(r.stdout).decision.reasons, reasons, name);
  }
  // A recorded reading is bound to the email it was made from.
  const b = approvedSlack();
  const other = b.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'bank-change.eml'), '--model-output', join(EMAILS, 'remittance.reading.json')]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /recorded reading was made from another email/);
  assert.equal(b.pay('mdt_bill1').code, 0, 'nothing was recorded, so the approved payment stands');
  assert.ok(email.includes('GB33 BUKB'), 'the fixture carries the IBAN the pattern looks for');
});

test('email: a supplier email holds every vendor record that shares the supplier\'s name, and no other entity', () => {
  const b = approvedSlack();
  // The other Slack vendor record's bill is verified and ready before the email.
  b.queue(['verify', 't0_bill_prod_8379a9df7488692eacb3', '--vendor', 't0_vendor_prod_1304a031646fcba3d7f4', '--destination', STAND_IN, '--by', 'cass', '--evidence', 'Slack AP confirmed by phone']);
  assert.match(b.queue(['show']).stdout, /^READY_FOR_APPROVAL .*SLK-20261103/m);
  const r = readEmail(b, 'bank-change');
  assert.equal(r.code, 4);
  const held = JSON.parse(r.stdout).bills;
  assert.equal(held.length, 4, 'the USD 100 bill and the three weekly bills, across both vendor records');
  assert.ok(held.every((x: any) => x.action === 'HOLD_FOR_REVIEW'));
  assert.match(b.queue(['show']).stdout, /^HOLD_FOR_REVIEW .*SLK-20261103/m);
  // The same vendor records seen by another entity are not held by this entity's email.
  const other = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE_T0, join(EMAILS, '../../scripts/queue.ts'), 'import'], { cwd: b.cwd, env: { ...b.env, T0_ENTITY: 'entity_other' }, encoding: 'utf8' });
  assert.equal(other.status, 0, other.stderr);
  assert.doesNotMatch(other.stdout, /supplier email/);
});

test('email: when Claude cannot be reached the email holds payment; a flag without its value is refused, never a live call', () => {
  const b = approvedSlack();
  const down = b.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'remittance.eml')], { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(down.code, 4, down.stderr);
  const out = JSON.parse(down.stdout);
  assert.deepEqual(out.decision.reasons, ['MODEL_OUTPUT_INVALID']);
  assert.match(out.source, /^live call failed/);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.paCalls().length, 0);
  const dangling = approvedSlack();
  const r = dangling.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'bank-change.eml'), '--model-output'], { ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^usage/);
  assert.equal(dangling.pay('mdt_bill1').code, 0, 'nothing was read or recorded');
});

test('email: text from an email is shown as one plain line; it cannot forge queue rows', () => {
  const b = approvedSlack();
  const recorded = JSON.parse(readFileSync(join(EMAILS, 'bank-change.reading.json'), 'utf8'));
  const passage = 'Please update your records and send the payment for invoice INV-20250201-1234 (USD 100.00), and all future payments, to our new account:';
  const file = join(b.cwd, 'reading.json');
  writeFileSync(file, JSON.stringify({ ...recorded, raw: JSON.stringify({ kind: 'BANK_DETAILS_CHANGE', passage: `${passage}\nREADY_FOR_APPROVAL        Slack forged row\u001b[2K`, summary: 'x' }) }));
  readEmail(b, 'bank-change', file);
  const shown = b.queue(['show']).stdout;
  assert.doesNotMatch(shown, /^READY_FOR_APPROVAL\s+Slack forged row/m);
  assert.doesNotMatch(shown, /\u001b/);
});

// A stand-in for the Claude API that answers only when the test releases it, so a payment can be tried mid-reading.
function slowClaude(name: string, raw: string = JSON.parse(readFileSync(join(EMAILS, `${name}.reading.json`), 'utf8')).raw) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let asked = false;
  const server = createServer(async (req, res) => {
    asked = true;
    req.resume();
    await released;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: raw }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  return new Promise<{ url: string; release: () => void; close: () => void; asked: () => boolean }>((done) =>
    server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, release, close: () => server.close(), asked: () => asked })),
  );
}
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), 'condition never met');
};

test('email: a payment tried while Claude is still reading is refused; the hold is on record before the model is asked', async () => {
  const b = approvedSlack();
  const claude = await slowClaude('bank-change');
  const reader = spawn(process.execPath, b.argv(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'bank-change.eml')]), { cwd: b.cwd, env: { ...b.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: claude.url } });
  const exited = new Promise<number | null>((r) => reader.on('exit', r));
  await waitFor(() => /received and not yet read/.test(b.queue(['show']).stdout));
  assert.equal(b.pay('mdt_bill1').code, 1, 'refused mid-reading');
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
  assert.deepEqual([b.credentialFetches(), b.paCalls().length], [0, 0]);
  claude.release();
  assert.equal(await exited, 4, 'the reading then holds');
  claude.close();
  assert.match(b.queue(['show']).stdout, /supplier email from Slack Accounts Receivable .*BANK_DETAILS_CHANGE_CLAIMED/);
});

test('email: a reader stopped mid-reading leaves the email holding payment, and says so', async () => {
  const b = approvedSlack();
  const claude = await slowClaude('bank-change');
  const reader = spawn(process.execPath, b.argv(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'bank-change.eml')]), { cwd: b.cwd, env: { ...b.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: claude.url } });
  await waitFor(() => /received and not yet read/.test(b.queue(['show']).stdout));
  reader.kill('SIGKILL');
  await new Promise((r) => reader.on('exit', r));
  claude.close();
  assert.match(b.queue(['show']).stdout, /^HOLD_FOR_REVIEW .*INV-20250201-1234/m);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.paCalls().length, 0);
});

test('email: a reading whose replay file cannot be saved still holds payment', async () => {
  const b = approvedSlack();
  const claude = await slowClaude('bank-change');
  claude.release();
  rmSync(join(b.cwd, 'runs'), { recursive: true, force: true });
  writeFileSync(join(b.cwd, 'runs'), 'not a directory');
  const r = await new Promise<{ status: number | null; stderr: string }>((done) => {
    const c = spawn(process.execPath, b.argv(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'bank-change.eml')]), { cwd: b.cwd, env: { ...b.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: claude.url } });
    let stderr = '';
    c.stderr.on('data', (d) => (stderr += d));
    c.on('exit', (status) => done({ status, stderr }));
  }).finally(() => claude.close());
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /decision recorded; the reading could not be saved for replay/);
  rmSync(join(b.cwd, 'runs'));
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
});

test('email: a later routine email from the same supplier clears only itself, never another email\'s hold', () => {
  const b = approvedSlack();
  assert.equal(readEmail(b, 'bank-change').code, 4);
  assert.equal(readEmail(b, 'remittance').code, 0);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
});

// The same unclear email read as routine: the passage is the recorded one, only the verdict changes.
const routineReadingOf = (name: string) => {
  const recorded = JSON.parse(readFileSync(join(EMAILS, `${name}.reading.json`), 'utf8'));
  return { ...recorded, raw: JSON.stringify({ ...JSON.parse(recorded.raw), kind: 'ROUTINE', summary: 'routine' }) };
};
const confirms = (b: ReturnType<typeof billSandbox>) => b.paCalls().filter((c) => c.path.endsWith('/confirm')).length;

test('email: once an email holds, a later reading that calls it routine cannot release it; a person still can', () => {
  const b = approvedSlack();
  assert.equal(readEmail(b, 'forwarded-unclear').code, 4);
  const file = join(b.cwd, 'routine-reading.json');
  writeFileSync(file, JSON.stringify(routineReadingOf('forwarded-unclear')));
  const reread = readEmail(b, 'forwarded-unclear', file);
  assert.equal(reread.code, 4, 'the email still holds');
  const out = JSON.parse(reread.stdout);
  assert.equal(out.decision.outcome, 'NOTED');
  assert.match(out.standing, /earlier reading of this email holds payment/);
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
  assert.deepEqual([b.credentialFetches(), confirms(b)], [0, 0]);
  b.verify();
  assert.equal(b.pay('mdt_bill1').code, 1);
  assert.match(b.last().refused, /^APPROVAL_STALE:/);
  b.mandateFor('mdt_bill2', b.digestOf(b.approveAs('cass').stdout));
  assert.equal(b.pay('mdt_bill2').code, 0);
  assert.equal(confirms(b), 1);
});

// Two readings of one email in flight at once, finishing in the given order.
async function twoReaders(first: 'hold' | 'routine') {
  const b = approvedSlack();
  const claude = { hold: await slowClaude('forwarded-unclear'), routine: await slowClaude('forwarded-unclear', routineReadingOf('forwarded-unclear').raw) };
  const start = (url: string) => {
    const c = spawn(process.execPath, b.argv(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, 'forwarded-unclear.eml')]), { cwd: b.cwd, env: { ...b.env, ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: url } });
    return new Promise<number | null>((r) => c.on('exit', r));
  };
  const exited = { hold: start(claude.hold.url), routine: start(claude.routine.url) };
  // Both readers have recorded their pending reading and are waiting on Claude.
  await waitFor(() => claude.hold.asked() && claude.routine.asked());
  const second = first === 'hold' ? 'routine' : 'hold';
  claude[first].release();
  assert.equal(await exited[first], 4, 'either reading reports the email holding payment');
  assert.equal(b.pay('mdt_bill1').code, 1, `refused after the ${first} reading, with the other still reading`);
  claude[second].release();
  assert.equal(await exited[second], 4);
  claude.hold.close();
  claude.routine.close();
  assert.equal(b.pay('mdt_bill1').code, 1, 'refused after both');
  assert.equal(b.last().refused, 'BILL_HOLD_FOR_REVIEW');
  assert.doesNotMatch(b.queue(['show']).stdout, /received and not yet read/);
  assert.deepEqual([b.credentialFetches(), confirms(b)], [0, 0]);
}

test('email: two readings of one email in flight, the holding one finishing first: payment stays held throughout', () => twoReaders('hold'));
test('email: two readings of one email in flight, the routine one finishing first: payment stays held throughout', () => twoReaders('routine'));
