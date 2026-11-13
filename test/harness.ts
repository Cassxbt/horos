// Sandboxes shared by the integration tests: each runs the real scripts in a fresh directory against the fakes.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const HOROS = here('../scripts/horos.ts');
export const AIRI = here('../scripts/airi-pay.ts');
export const FAKE = here('./fixtures/fake-airwallex.mjs');
export const FAKE_CLI = here('./fixtures/fake-airi-cli.mjs');
let port = 19000 + (process.pid % 2000);

export function sandbox(extra: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'horos-runner-'));
  const bin = join(cwd, 'bin');
  spawnSync('mkdir', [bin]);
  writeFileSync(join(bin, 'airi-cli'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(join(bin, 'airi-cli'), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    AWX_CLIENT_ID: 'fake',
    AWX_API_KEY: 'fake',
    AWX_REMOTE_AUTH_SECRET: 'fake-secret',
    HOROS_PORT: String(port++),
    FAKE_AWX_LOG: join(cwd, 'awx.jsonl'),
    FAKE_AIRI_LOG: join(cwd, 'airi.jsonl'),
    FAKE_PA_STORE: join(cwd, 'pa.jsonl'),
    ...extra,
  };
  const argv = (script: string, args: string[]) => ['--disable-warning=ExperimentalWarning', '--import', FAKE, script, ...args];
  const run = (script: string, args: string[], more: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, argv(script, args), { cwd, env: { ...env, ...more }, encoding: 'utf8', timeout: 30_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const entries = () => (existsSync(env.FAKE_AWX_LOG) ? readFileSync(env.FAKE_AWX_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const calls = () => entries().filter((e) => e.path) as { method: string; path: string; body?: any }[];
  // Cards the fake still held ACTIVE when the script process exited.
  const activeAtExit = () => entries().filter((e) => e.activeAtExit).at(-1)?.activeAtExit as string[] | undefined;
  const pendingAtExit = () => entries().filter((e) => e.pendingAtExit).at(-1)?.pendingAtExit as string[] | undefined;
  const airiCalls = () => (existsSync(env.FAKE_AIRI_LOG) ? readFileSync(env.FAKE_AIRI_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);
  const files = (prefix: string) => (existsSync(join(cwd, 'runs')) ? readdirSync(join(cwd, 'runs')).filter((f) => f.startsWith(prefix)).sort() : []);
  const json = (f: string) => JSON.parse(readFileSync(join(cwd, 'runs', f), 'utf8'));
  return { cwd, env, argv, run, calls, activeAtExit, pendingAtExit, airiCalls, files, json };
}

export const receiptOf = (s: ReturnType<typeof sandbox>) => s.json(s.files('receipt-').at(-1)!);
export const failed = (receipt: any) => receipt.checks.filter((c: any) => !c.pass).map((c: any) => c.check);

// Remote auth may only be switched off after every card update; nothing may disable it while a card is still live.
export function restoredAfterCards(calls: ReturnType<ReturnType<typeof sandbox>['calls']>) {
  const lastCard = calls.map((c) => c.path).findLastIndex((p) => /\/issuing\/cards\/[^/]+\/update$/.test(p));
  const offs = calls.map((c, i) => (c.path.endsWith('/issuing/config/update') && c.body?.remote_auth?.enabled === false ? i : -1)).filter((i) => i >= 0);
  return offs.length > 0 && offs.every((i) => i > lastCard);
}

// The selected-bill workflow on the real T:0 bill id, with fake providers: import, a person verifies the vendor and
// destination, a person approves exactly what is shown, then the executor pays only what was approved.
export const QUEUE = here('../scripts/queue.ts');
export const ACCOUNTING = here('../scripts/accounting.ts');
export const EMAIL = here('../scripts/email.ts');
export const EMAILS = here('../demo/emails');
export const FAKE_T0 = here('./fixtures/fake-t0.mjs');
export const T0_PAGE = JSON.parse(readFileSync(here('./fixtures/t0-open-bills.json'), 'utf8'));
export const SLACK100 = 't0_bill_prod_9a32a0da12fe3faf33e5';
export const SLACK_VENDOR = 't0_vendor_prod_78e1a442b0eb63a0b44c';
export const STAND_IN = 'https://pay.horos-sandbox.example/slack';

export function billSandbox() {
  const s = sandbox();
  const pageFile = join(s.cwd, 't0-page.json');
  const setPage = (page: unknown) => writeFileSync(pageFile, JSON.stringify(page));
  setPage(T0_PAGE);
  // The executor reads T:0 itself, so every script sees the same source page.
  Object.assign(s.env, { T0_API_KEY: 'fake', FAKE_T0_PAGE: pageFile });
  // The same source with the Slack bill paid by someone else: it leaves the open list.
  const paidElsewhere = join(s.cwd, 't0-page-paid.json');
  const paid = structuredClone(T0_PAGE);
  paid.data.find((r: any) => r.id.externalId === SLACK100).data.status = 'paid';
  writeFileSync(paidElsewhere, JSON.stringify(paid));
  const queue = (args: string[]) => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', FAKE_T0, QUEUE, ...args], { cwd: s.cwd, env: { ...s.env, T0_API_KEY: 'fake', FAKE_T0_PAGE: pageFile }, encoding: 'utf8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const verify = () => queue(['verify', SLACK100, '--vendor', SLACK_VENDOR, '--destination', STAND_IN, '--by', 'cass', '--evidence', 'Slack AP confirmed this vendor record and checkout by phone']);
  const approve = (extra: string[] = []) => s.run(AIRI, ['approve', '--bill', SLACK100, ...extra], { FAKE_AWX_ACCOUNT: account });
  // A person approves what they just read: the preview's token, then --approve-as with it.
  const approveAs = (name: string) => {
    const preview = approve();
    const token = preview.stdout.match(/--token ([0-9a-f]{8})/)?.[1] ?? 'none';
    return approve(['--approve-as', name, '--token', token]);
  };
  let account = 'acct_sandbox_A';
  const useAccount = (a: string) => void (account = a);
  const mandatesFile = join(s.cwd, 'mandates.json');
  s.env.FAKE_AIRI_MANDATES = mandatesFile;
  const mandates: object[] = [];
  const mandateFor = (mandateId: string, digest: string, url = STAND_IN, expiresInMs = 15 * 60_000) => {
    mandates.push({
      mandateId,
      status: 'READY',
      protocolType: 'VIC',
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      merchantInfo: { name: 'Slack Technologies, Inc.', url, country: 'US' },
      orderInfo: { currency: 'USD', totalAmount: '100.00', description: `Pay invoice INV-20250201-1234. Approval digest ${digest.slice(0, 12)}` },
    });
    writeFileSync(mandatesFile, JSON.stringify(mandates));
  };
  const pay = (mandateId: string, more: Record<string, string> = {}) => s.run(AIRI, ['pay', mandateId, '--bill', SLACK100], { FAKE_AWX_ACCOUNT: account, ...more });
  const last = () => s.json(s.files('airi-payment-').at(-1)!);
  const digestOf = (out: string) => out.match(/"digest": "([0-9a-f]{64})"/)![1];
  const paCalls = () => s.calls().filter((c) => c.path.includes('/pa/'));
  const credentialFetches = () => s.airiCalls().filter((c) => c[1] === 'get-credential').length;
  return { ...s, setPage, paidElsewhere, queue, verify, approve, approveAs, useAccount, mandateFor, pay, last, digestOf, paCalls, credentialFetches };
}

export const KEY = `entity_prod_ieEAMzvhgtHalvsm/${SLACK100}`;

export const stateOf = (b: ReturnType<typeof billSandbox>) => {
  const db = new DatabaseSync(join(b.cwd, 'data', 'horos.db'));
  try {
    return (db.prepare('SELECT state FROM obligations WHERE key = ?').get(KEY) as { state: string }).state;
  } finally {
    db.close();
  }
};

export const succeededIntents = (b: ReturnType<typeof billSandbox>) => {
  const all = readFileSync(b.env.FAKE_PA_STORE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return new Set(all.filter((i) => i.status === 'SUCCEEDED').map((i) => i.id)).size;
};
