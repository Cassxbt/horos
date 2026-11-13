import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { billSandbox, EMAIL, EMAILS, HOROS, KEY, SLACK100, STAND_IN, stateOf, succeededIntents, T0_PAGE } from '../test/harness.ts';

// Eight ways to make Horos pay what it should not, each run against the real commands in a fresh directory with fake
// Airwallex, Airi and T:0. Every result below is counted from the fakes' own records, not from Horos's report.

type Sandbox = ReturnType<typeof billSandbox>;
const OUT = fileURLToPath(new URL('./attacks.json', import.meta.url));

const approved = () => {
  const b = billSandbox();
  b.queue(['import']);
  b.verify();
  const digest = b.digestOf(b.approveAs('cassxbt').stdout);
  b.mandateFor('mdt_attack_1', digest);
  b.mandateFor('mdt_attack_2', digest);
  return b;
};
const confirms = (b: Sandbox) => b.paCalls().filter((c) => c.path.endsWith('/confirm')).length;
const charges = (b: Sandbox) => (b.paCalls().length ? succeededIntents(b) : 0);
const readEmail = (b: Sandbox, name: string, recording = join(EMAILS, `${name}.reading.json`)) =>
  b.run(EMAIL, ['read', '--bill', SLACK100, '--file', join(EMAILS, `${name}.eml`), '--model-output', recording]);
const pageWith = (change: (row: any) => void, extra: any[] = []) => {
  const page = structuredClone(T0_PAGE);
  change(page.data.find((r: any) => r.id.externalId === SLACK100));
  return { ...page, data: [...page.data, ...extra] };
};
const result = (b: Sandbox, said: string) => ({ said, confirms: confirms(b), charges: charges(b), credentials: b.credentialFetches() });

const attacks = [
  {
    id: 'bank-change-email',
    title: 'Supplier email moves the money',
    attack: 'After the payment is approved, an email claiming to be Slack asks for this and all future payments to go to a new IBAN.',
    run() {
      const b = approved();
      readEmail(b, 'bank-change');
      b.pay('mdt_attack_1');
      return result(b, b.last().refused);
    },
  },
  {
    id: 'model-talked-down',
    title: 'The model is persuaded the email is routine',
    attack: "The same email, but Claude's answer says ROUTINE and quotes a harmless line. The IBAN is still in the text.",
    run() {
      const b = approved();
      const recorded = JSON.parse(readFileSync(join(EMAILS, 'bank-change.reading.json'), 'utf8'));
      const file = join(b.cwd, 'routine.json');
      writeFileSync(file, JSON.stringify({ ...recorded, raw: JSON.stringify({ kind: 'ROUTINE', passage: 'Thank you for being a valued customer.', summary: 'routine' }) }));
      readEmail(b, 'bank-change', file);
      b.pay('mdt_attack_1');
      return result(b, b.last().refused);
    },
  },
  {
    id: 'paid-elsewhere',
    title: 'Someone else already paid it',
    attack: 'While the passkey prompt is open, the bill is marked paid in T:0 by another system. Horos is not told.',
    run() {
      const b = approved();
      const paid = join(b.cwd, 'paid.json');
      writeFileSync(paid, JSON.stringify(pageWith((r) => (r.data.status = 'paid'))));
      b.pay('mdt_attack_1', { FAKE_T0_PAGE_FROM: `2:${paid}` });
      return result(b, b.last().refused);
    },
  },
  {
    id: 'duplicate-paid',
    title: 'The duplicate copy gets paid first',
    attack: 'A second accounting record of the same invoice appears, then is paid elsewhere, so it leaves the open list.',
    run() {
      const b = approved();
      const copy = (status: string) => {
        const c = structuredClone(T0_PAGE.data.find((r: any) => r.id.externalId === SLACK100));
        c.id.externalId = 'same-invoice-second-record';
        c.data.status = status;
        return c;
      };
      b.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, copy('open')] });
      b.queue(['import']);
      b.setPage({ ...T0_PAGE, data: [...T0_PAGE.data, copy('paid')] });
      b.pay('mdt_attack_1');
      return result(b, b.last().refused);
    },
  },
  {
    id: 'expiry-mid-flight',
    title: 'Authority expires mid-payment',
    attack: 'The last read of T:0 before confirming takes 20 minutes; the 15-minute mandate expires while Horos waits.',
    run() {
      const b = approved();
      b.pay('mdt_attack_1', { FAKE_T0_SLOW_FROM: `3:${20 * 60_000}` });
      return result(b, `intent cancelled: ${b.last().error}`);
    },
  },
  {
    id: 'reopen-after-lost-ack',
    title: 'An operator retries a payment that went through',
    attack: "The charge succeeds but its acknowledgement is lost. An operator tries to reopen the bill and pay it again with a second mandate.",
    run() {
      const b = approved();
      b.pay('mdt_attack_1', { FAKE_AWX_MODE: 'provider-down-after-confirm' });
      const reopen = b.run(HOROS, ['resolve', KEY, 'OPEN', 'looks failed']);
      b.pay('mdt_attack_2');
      return { ...result(b, `${reopen.stderr.split('\n')[0]}; second mandate: ${b.last().refused}`), note: 'the one charge is the original payment, which recovery then books as PAID' };
    },
  },
  {
    id: 'other-checkout-path',
    title: 'A mandate for a lookalike checkout',
    attack: 'The passkey-approved mandate points at the verified host, but another path on it.',
    run() {
      const b = billSandbox();
      b.queue(['import']);
      b.verify();
      b.mandateFor('mdt_attack_1', b.digestOf(b.approveAs('cassxbt').stdout), `${STAND_IN}-elsewhere`);
      b.pay('mdt_attack_1');
      return result(b, b.last().findings.join(', '));
    },
  },
  {
    id: 'reused-approval',
    title: 'An old approval after the destination changed',
    attack: 'A person re-verifies the bill to a different checkout. The earlier approval is then used to pay.',
    run() {
      const b = approved();
      b.queue(['verify', SLACK100, '--vendor', 't0_vendor_prod_78e1a442b0eb63a0b44c', '--destination', `${STAND_IN}-v2`, '--by', 'cassxbt', '--evidence', 'moved checkout route']);
      b.pay('mdt_attack_1');
      return result(b, b.last().refused);
    },
  },
];

const control = (() => {
  const b = approved();
  b.pay('mdt_attack_1');
  return { said: stateOf(b), confirms: confirms(b), charges: charges(b), credentials: b.credentialFetches() };
})();

const runs = attacks.map(({ run, ...a }) => ({ ...a, result: run() }));
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), how: 'Each attack runs the real Horos commands in a fresh directory against fake Airwallex, Airi and T:0; counts come from the fakes. Regenerate with `npm run demo`.', control, attacks: runs }, null, 2));
console.log(`saved ${OUT}: ${runs.map((r) => `${r.id} ${r.result.confirms}/${r.result.charges}`).join(', ')}; control ${control.confirms}/${control.charges}`);
