import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billSandbox, EMAIL, EMAILS, SLACK100 } from '../test/harness.ts';

// Plays the supplier-email story end to end with the real Horos commands, against fake Airwallex, Airi and T:0 and
// Claude's readings recorded from live runs. No key and no network: anyone can run it and get the same evidence.

type Sandbox = ReturnType<typeof billSandbox>;
const OUT = fileURLToPath(new URL('./replay.json', import.meta.url));

const json = (stdout: string, until?: string) => JSON.parse(until ? stdout.slice(0, stdout.indexOf(until)) : stdout);
// The bill's own row in the queue, not a note under another bill that happens to quote its invoice number.
const slackLine = (b: Sandbox) => b.queue(['show']).stdout.split('\n').find((l) => /^[A-Z_]+ .*INV-20250201-1234/.test(l))!.trim();
const confirms = (b: Sandbox) => b.paCalls().filter((c) => c.path.endsWith('/confirm')).length;
const readEmail = (b: Sandbox, name: string) => b.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, `${name}.eml`), '--model-output', join(EMAILS, `${name}.reading.json`)]);
const attempt = (b: Sandbox, mandate: string, when: string) => {
  const r = b.pay(mandate);
  const last = b.last();
  return { when, exit: r.code, refused: last.refused ?? null, state: last.state ?? null, flags: (last.flags ?? []).map((f: { kind: string }) => f.kind), confirmsSoFar: confirms(b) };
};

function approved() {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const preview = json(b.approve().stdout, '\npreview only').preview;
  const approval = b.approveAs('cassxbt');
  const digest = b.digestOf(approval.stdout);
  b.mandateFor('mdt_replay_1', digest);
  return { b, preview, approval: json(approval.stdout, '\n\nairi-cli') };
}

const story = (() => {
  const { b, preview, approval } = approved();
  const before = slackLine(b);
  const read = readEmail(b, 'bank-change');
  const email = { exit: read.code, ...json(read.stdout) };
  const after = slackLine(b);
  const attempts = [attempt(b, 'mdt_replay_1', 'the approved checkout, right after the email')];
  b.queue(['import']);
  attempts.push(attempt(b, 'mdt_replay_1', 'again, after a fresh T:0 import'));
  const heldTotals = { confirms: confirms(b), credentialFetches: b.credentialFetches(), providerCalls: b.paCalls().length };
  // The release: a person confirms the vendor and destination through a known contact, after the email.
  b.verify();
  const stale = attempt(b, 'mdt_replay_1', 'the old approval, after the person verified again');
  const reapproval = json(b.approveAs('cassxbt').stdout, '\n\nairi-cli');
  b.mandateFor('mdt_replay_2', reapproval.digest);
  const paid = b.pay('mdt_replay_2');
  return {
    preview,
    approval,
    queueBefore: before,
    queueAfter: after,
    email,
    attempts,
    heldTotals,
    release: { stale, reapproval, payment: { exit: paid.code, ...b.last() } },
    totals: { confirms: confirms(b), airiResults: b.airiCalls().filter((c) => c[1] === 'result').map((c) => `${c[3]}:${c[5]}`) },
  };
})();

const control = (name: string) => {
  const { b } = approved();
  const read = readEmail(b, name);
  const pay = attempt(b, 'mdt_replay_1', `the approved checkout, after the ${name} email`);
  return { email: { exit: read.code, ...json(read.stdout) }, queueAfterEmail: slackLine(b), attempt: pay, credentialFetches: b.credentialFetches(), confirms: confirms(b) };
};

// Paths in command output are made relative to the repository, so the published file names no local folder.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      how: 'Real Horos commands (queue.ts, email.ts, airi-pay.ts) in a fresh directory, against fake Airwallex, Airi and T:0, with Claude readings recorded from live runs (demo/emails/*.reading.json). Regenerate with `npm run demo`.',
      story,
      controls: { remittance: control('remittance'), forwarded: control('forwarded-unclear') },
    },
    null,
    2,
  ).replaceAll(ROOT, ''),
);
console.log(`saved ${OUT}: held with ${story.heldTotals.confirms} confirmations, then paid once (${story.totals.confirms} confirmation in total)`);
