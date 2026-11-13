import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { fileURLToPath } from 'node:url';
import { emailDecision, EMAIL_PROMPT_VERSION, parseEmail, parseReading, readingRequest } from '../src/email.ts';

// Twelve emails labelled before any model read them: ordinary receipts, real changes to where payments go, and
// ambiguous messages. Each is read by Claude once (`--live`, recorded beside the email) and then decided by the same
// policy the product uses. Without `--live` only the recordings are used, so anyone can rerun it with no key.

// As for T:0: Node's default 250 ms per address gives up before the API's first address answers on some networks.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DIR = here('./emails/eval');
const { expected } = JSON.parse(readFileSync(`${DIR}/labels.json`, 'utf8')) as { expected: Record<string, 'NOTED' | 'HOLD'> };
const live = process.argv.includes('--live');
const supplier = (from: string) => (/slack/i.test(from) ? 'Slack Technologies, Inc.' : /atlassian/i.test(from) ? 'Atlassian' : /hp/i.test(from) ? 'Hewlett-Packard Inc.' : /dell/i.test(from) ? 'Dell Inc.' : 'Slack Technologies, Inc.');

type Row = { name: string; subject: string; expected: 'NOTED' | 'HOLD'; kind: string; passage: string; outcome: string; reasons: string[]; signals: string[]; agrees: boolean; model: string; tokens: number };
const rows: Row[] = [];
for (const name of readdirSync(DIR).filter((f) => f.endsWith('.eml')).map((f) => f.slice(0, -4)).sort()) {
  const email = parseEmail(readFileSync(`${DIR}/${name}.eml`, 'utf8'));
  const recording = `${DIR}/${name}.reading.json`;
  if (!existsSync(recording)) {
    if (!live) throw new Error(`no recorded reading for ${name}: run with --live once`);
    const response = await new Anthropic().messages.create(readingRequest(email, { vendorName: supplier(email.from), invoiceNumber: 'the open invoice', amount: 0, currency: 'USD' }));
    const raw = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    writeFileSync(recording, JSON.stringify({ at: new Date().toISOString(), emailSha256: email.sha256, model: response.model, promptVersion: EMAIL_PROMPT_VERSION, stopReason: response.stop_reason, usage: response.usage, raw }, null, 2));
  }
  const r = JSON.parse(readFileSync(recording, 'utf8')) as { emailSha256: string; promptVersion: string; raw: string; model: string; usage: { input_tokens: number; output_tokens: number } };
  if (r.emailSha256 !== email.sha256 || r.promptVersion !== EMAIL_PROMPT_VERSION) throw new Error(`${name}: the recording is of another email or prompt`);
  const reading = parseReading(r.raw);
  const decision = emailDecision(email, reading);
  rows.push({ name, subject: email.subject, expected: expected[name], kind: reading?.kind ?? 'UNREADABLE', passage: reading?.passage ?? '', outcome: decision.outcome, reasons: decision.reasons, signals: decision.signals, agrees: decision.outcome === expected[name], model: r.model, tokens: r.usage.input_tokens + r.usage.output_tokens });
}

const count = (f: (r: Row) => boolean) => rows.filter(f).length;
const summary = {
  emails: rows.length,
  agree: count((r) => r.agrees),
  falseHolds: count((r) => r.expected === 'NOTED' && r.outcome === 'HOLD'),
  missedHolds: count((r) => r.expected === 'HOLD' && r.outcome === 'NOTED'),
  heldWithoutPattern: count((r) => r.outcome === 'HOLD' && r.signals.length === 0),
};
writeFileSync(here('./eval.json'), JSON.stringify({ generatedAt: new Date().toISOString(), how: 'demo/emails/eval: emails and labels.json written first; each read once by Claude (recorded beside it); decided by src/email.ts. Rerun with `node demo/eval.ts`.', summary, rows }, null, 2));
console.log(`eval: ${summary.agree}/${summary.emails} agree with the labels; ${summary.falseHolds} false holds, ${summary.missedHolds} missed holds; ${summary.heldWithoutPattern} held on Claude's reading alone`);
for (const r of rows) console.log(`${r.agrees ? ' ' : '!'} ${r.name.padEnd(28)} expected ${r.expected.padEnd(5)} got ${r.outcome.padEnd(5)} ${r.kind.padEnd(19)} ${r.signals.join(',')}`);

// A verification, not a report: any disagreement, or an email and its label out of step, fails the command.
const unlabelled = rows.filter((r) => !r.expected).map((r) => r.name);
const unread = Object.keys(expected).filter((name) => !rows.some((r) => r.name === name));
if (summary.agree !== summary.emails || unlabelled.length || unread.length) {
  console.error(`eval failed: ${summary.emails - summary.agree} disagreement(s)${unlabelled.length ? `; no label for ${unlabelled.join(', ')}` : ''}${unread.length ? `; labelled but missing ${unread.join(', ')}` : ''}`);
  process.exit(1);
}
