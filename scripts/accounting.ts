import { auditEntry, syncAccounting } from '../src/accounting.ts';
import { openLedger } from '../src/ledger.ts';
import { T0_ENTITY } from '../src/payable.ts';
import { findPaymentRecord, postRecords } from '../src/t0.ts';

const USAGE = `usage (from horos/, with --env-file=.env):
  scripts/accounting.ts status
      Lists the accounting records owed to T:0 for this entity's paid bills, with their state and anything that keeps
      one from being posted as it stands (checked against the approval and the provider's settlement).
  scripts/accounting.ts sync --bill <t0-bill-id>
      Sends that one bill's owed record (its exact stored content) and reads it back. Needs T0_WRITE_ENABLED=1.
      Exit 0 when it is confirmed, 3 while it is in flight, 4 when a person must look at it.`;

const ledger = openLedger(process.env.HOROS_DB ?? 'data/horos.db');
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// Only this entity's records are ever listed or sent.
const mine = () => ledger.accounting().filter((r) => r.key.startsWith(`${T0_ENTITY}/`));
const summary = (keys?: string[]) =>
  mine()
    .filter((r) => !keys || keys.includes(r.key))
    .map((r) => ({ obligation: r.key, record: r.record_id, payment: r.provider_ref, status: r.status, detail: r.detail, problems: auditEntry(ledger, r) }));
const exitCode = (rows: { status: string; problems: string[] }[]) =>
  rows.some((r) => ['REJECTED', 'MISMATCH', 'NEEDS_REVIEW'].includes(r.status) || r.problems.length) ? 4 : rows.some((r) => r.status === 'PENDING' || r.status === 'ACCEPTED') ? 3 : 0;

if (args[0] === 'status') {
  console.log(JSON.stringify(summary(), null, 2));
  process.exit(exitCode(summary()));
} else if (args[0] === 'sync' && option('--bill') && process.env.T0_WRITE_ENABLED !== '1') {
  // Checked before anything is touched, so an entry is never marked as sent when nothing could be.
  console.error('not synced: set T0_WRITE_ENABLED=1 to write to T:0');
  process.exit(3);
} else if (args[0] === 'sync' && option('--bill')) {
  // One write, chosen by the operator: exactly this entity's record for this bill, and nothing else.
  const key = `${T0_ENTITY}/${option('--bill')}`;
  if (!mine().some((r) => r.key === key)) {
    console.error(`no accounting record owed for ${key}`);
    process.exit(1);
  }
  const moved = await syncAccounting(ledger, { post: postRecords, find: (id) => findPaymentRecord(T0_ENTITY, id) }, [key]);
  const rows = summary([key]);
  console.log(JSON.stringify({ moved, records: rows }, null, 2));
  process.exit(exitCode(rows));
} else {
  console.error(USAGE);
  process.exit(1);
}
