import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { emailDecision, EMAIL_MODEL, EMAIL_PROMPT_VERSION, parseEmail, parseReading, readingRequest, vendorReviewKey, type EmailReading } from '../src/email.ts';
import { openLedger } from '../src/ledger.ts';
import { queueFor, T0_ENTITY } from '../src/payable.ts';
import { normalizeName } from '../src/policy.ts';

const USAGE = `usage (from horos/, with --env-file=.env):
  scripts/email.ts read --bill <t0-bill-id> --file <email file> [--model-output <recorded reading>]
      Claude reads a supplier email about the bill's vendor and quotes the passage it relied on; a fixed policy then
      decides. An email that asks to move payments, or that cannot be read with confidence, holds every bill of that
      vendor record until a person verifies the vendor and destination again. Nothing in an email can change a payee
      or approve a payment. --model-output replays a reading recorded by an earlier run, for the same email, with no
      API call. Exit 0 when the email is only noted, 4 when it holds payment, by this reading or an earlier one.`;

const args = process.argv.slice(2);
// A flag given without its value is a mistake, never a silent fall-back to a live call.
const option = (name: string) => {
  if (!args.includes(name)) return undefined;
  const value = args[args.indexOf(name) + 1];
  return value && !value.startsWith('--') ? value : null;
};
const [billId, file, recorded] = [option('--bill'), option('--file'), option('--model-output')];
if (args[0] !== 'read' || !billId || !file || recorded === null) {
  console.error(USAGE);
  process.exit(1);
}

const ledger = openLedger(process.env.HOROS_DB ?? 'data/horos.db');
const row = queueFor(ledger).find((r) => r.billId === billId);
if (!row?.vendorId) {
  console.error(`not read: ${row ? 'the bill has no single vendor record' : `unknown bill ${billId}: import it with scripts/queue.ts import`}`);
  process.exit(1);
}
const email = parseEmail(readFileSync(file, 'utf8'));
const recording = recorded ? (JSON.parse(readFileSync(recorded, 'utf8')) as { emailSha256: string; model: string; promptVersion: string; raw: string }) : undefined;
// A recorded reading counts only for the exact email it was made from; checked before anything is recorded.
if (recording && (recording.emailSha256 !== email.sha256 || recording.promptVersion !== EMAIL_PROMPT_VERSION)) {
  console.error('not read: the recorded reading was made from another email or prompt');
  process.exit(1);
}

// A supplier is known by name as much as by record: when two vendor records share the name, an email about one is
// about both, and each is held.
const sameSupplier = (r: { vendorName: string }) => normalizeName(r.vendorName) === normalizeName(row.vendorName);
const vendorIds = [...new Set(queueFor(ledger).filter((r) => r.vendorId && sameSupplier(r)).map((r) => r.vendorId))];
// Ties this run's decision to its own pending record, so concurrent readings of one email cannot resolve each other.
const readingId = randomUUID();
const review = (decision: string, by: string, evidence: Record<string, unknown>) =>
  ledger.atomically(() => {
    for (const vendorId of vendorIds) {
      ledger.addReview({
        key: vendorReviewKey(T0_ENTITY, vendorId),
        billVersion: row.version,
        vendorId,
        destination: '',
        decision,
        by,
        evidence: JSON.stringify({ from: email.from, subject: email.subject, date: email.date, emailSha256: email.sha256, readingId, ...evidence }),
      });
    }
  });

// The email is on record, and holding payment, before it is read: a payment begun while Claude reads, a crash, or a
// slow answer all meet the hold. The reading's own decision then resolves it. A routine reading cannot undo a hold an
// earlier reading of the same email established.
review('SUPPLIER_EMAIL_PENDING', 'horos (received, not yet read)', { passage: '', reasons: ['READING_IN_PROGRESS'] });

type Read = { reading: EmailReading | undefined; raw: string; model: string; source: string; response?: { stop_reason: string | null; usage: unknown } };
async function read(): Promise<Read> {
  if (recording) return { reading: parseReading(recording.raw), raw: recording.raw, model: recording.model, source: `recorded ${recorded}` };
  // Claude unavailable is not a clean bill of health: with no reading, the policy holds.
  const response = await new Anthropic().messages.create(readingRequest(email, row!)).catch((e: Error) => e);
  if (response instanceof Error) return { reading: undefined, raw: '', model: EMAIL_MODEL, source: `live call failed: ${response.message.split('\n')[0]}` };
  const raw = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { reading: response.stop_reason === 'end_turn' ? parseReading(raw) : undefined, raw, model: response.model, source: 'live', response };
}

const { reading, raw, model, source, response } = await read();
const decision = emailDecision(email, reading);
review(decision.outcome === 'HOLD' ? 'SUPPLIER_EMAIL_HOLD' : 'SUPPLIER_EMAIL_NOTED', `horos (${model}, ${EMAIL_PROMPT_VERSION})`, {
  kind: reading?.kind ?? null,
  passage: reading?.passage ?? '',
  summary: reading?.summary ?? '',
  reasons: decision.reasons,
  signals: decision.signals,
  source,
});

// The live reading is also kept as a replayable file, after the decision is on record: losing the file loses evidence,
// never the hold.
let saved: string | undefined;
if (response) {
  try {
    mkdirSync('runs', { recursive: true });
    saved = `runs/email-reading-${Date.now()}.json`;
    writeFileSync(saved, JSON.stringify({ at: new Date().toISOString(), emailSha256: email.sha256, model, promptVersion: EMAIL_PROMPT_VERSION, stopReason: response.stop_reason, usage: response.usage, raw }, null, 2));
  } catch (e) {
    console.error(`decision recorded; the reading could not be saved for replay: ${(e as Error).message}`);
    saved = undefined;
  }
}

const affected = queueFor(ledger).filter((r) => vendorIds.includes(r.vendorId));
const held = decision.outcome === 'HOLD' || affected.some((r) => r.flags.some((f) => f.kind === 'SUPPLIER_EMAIL' && f.emailSha256 === email.sha256));
console.log(
  JSON.stringify(
    {
      email: { from: email.from, subject: email.subject, date: email.date },
      reading: reading ?? 'UNREADABLE',
      model,
      source: saved ? `${source}, saved ${saved}` : source,
      decision,
      bills: affected.map((r) => ({ bill: r.billId, invoice: r.invoiceNumber, amount: `${r.currency} ${r.amount.toFixed(2)}`, action: r.action })),
      // A payment already reserved or made before this email was on record cannot be stopped by it; a person checks it.
      alreadyStarted: affected.filter((r) => r.state !== 'OPEN').map((r) => ({ bill: r.billId, invoice: r.invoiceNumber, state: r.state })),
      standing: decision.outcome !== 'HOLD' && held ? 'an earlier reading of this email holds payment; this reading cannot release it' : undefined,
      release: held ? 'a person confirms the vendor and the checkout destination through a known contact, then: scripts/queue.ts verify, and a new approval' : undefined,
    },
    null,
    2,
  ),
);
process.exit(held ? 4 : 0);
