import { mkdirSync, writeFileSync } from 'node:fs';
import { openLedger, type Ledger } from '../src/ledger.ts';
import { queueFor, recordImport, T0_ENTITY } from '../src/payable.ts';
import { checkPortal } from '../src/policy.ts';
import { billVersion, type Flag } from '../src/queue.ts';
import { sourceBills } from '../src/t0.ts';

const USAGE = `usage (from horos/, with --env-file=.env):
  scripts/queue.ts import
      Reads every bill from T:0 (read-only), records each open one as a payable keyed by entity and bill id, and keeps
      the rest as history for duplicate checks. A bill that is no longer open is withdrawn from payment; a bill that
      changed, or that duplicates any bill ever seen, is held. Prints the queue.
  scripts/queue.ts show
      Prints the same queue from the ledger, without calling T:0.
  scripts/queue.ts verify <bill-id> --vendor <vendor-record-id> --destination <https checkout url> --by <name> --evidence "<how it was checked>"
      Records a person's verification of who this bill pays. Valid only for the bill's current version and vendor record.`;

const DB_FILE = process.env.HOROS_DB ?? 'data/horos.db';
const ENTITY = T0_ENTITY;
const view = (ledger: Ledger) => queueFor(ledger);

// Text that came from outside, such as an email, is printed as one plain line: it cannot forge rows or control the terminal.
const oneLine = (s: string) => s.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim();

const describe = (f: Flag) =>
  f.kind === 'EXACT_DUPLICATE'
    ? `same supplier invoice also recorded as ${f.others.join(', ')}${f.notOpen.length ? `; not open in T:0: ${f.notOpen.join(', ')}` : ''}: held until a person decides`
    : f.kind === 'POSSIBLE_DUPLICATE'
      ? `possible duplicate of ${f.others.join(', ')}: ${f.evidence}`
      : f.kind === 'VENDOR_LINK_MISSING'
        ? 'no vendor record linked'
        : f.kind === 'VENDOR_NAME_SHARED'
          ? `vendor name also used by vendor record ${f.otherVendorIds.join(', ')}`
          : f.kind === 'VENDOR_VERIFIED'
            ? `vendor and destination ${f.destination} verified by ${f.by} at ${f.at}`
            : f.kind === 'CHANGED_IN_SOURCE'
              ? `changed in T:0 since first import (${f.fields.join(', ')}): held until reviewed`
              : f.kind === 'NOT_IN_LATEST_IMPORT'
                ? 'not in the latest complete import from T:0: withdrawn until its source record is checked'
                : f.kind === 'RECURRING'
                  ? `recurring series ${f.series.join(' > ')}`
                  : f.kind === 'OVERDUE'
                    ? `${f.daysPastDue} days past due`
                    : f.kind === 'SOURCE_CONFLICT'
                      ? `the T:0 record contradicts itself (${f.conflicts.join(', ')}): held until it is clarified`
                      : f.kind === 'SUPPLIER_EMAIL'
                        ? f.reasons.includes('READING_IN_PROGRESS')
                          ? `supplier email from ${oneLine(f.from)} received and not yet read: held until its reading is recorded, or a person verifies the vendor and destination again`
                          : `supplier email from ${oneLine(f.from)} (${f.reasons.join(', ')}): "${oneLine(f.passage)}". Held until a person verifies the vendor and destination again`
                        : 'amount or currency not payable';

function print(rows: ReturnType<typeof view>, imported?: Map<string, string>) {
  for (const r of rows) {
    const note = imported?.get(r.billId);
    console.log(`${r.action.padEnd(25)} ${r.vendorName || '(no vendor)'} ${r.invoiceNumber}  ${r.currency} ${r.amount.toFixed(2)}  due ${r.dueDate}  [${r.state}${note ? `, ${note}` : ''}]`);
    console.log(`  bill ${r.billId}  vendor ${r.vendorId || '-'}  version ${r.version}`);
    for (const f of r.flags) console.log(`  - ${describe(f)}`);
  }
}

const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const [command, billId] = process.argv.slice(2);
mkdirSync('data', { recursive: true });
const ledger = openLedger(DB_FILE);

if (command === 'import') {
  // A failed or partial fetch throws before anything is recorded; only a complete read replaces the latest import.
  const bills = await sourceBills(ENTITY);
  const imported = recordImport(ledger, ENTITY, bills);
  const rows = view(ledger);
  print(rows, imported);
  mkdirSync('runs', { recursive: true });
  const file = `runs/queue-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), entity: ENTITY, source: 'T:0 GET /v1/vendor-bills?expand=vendor, every status (read-only)', rows }, null, 2));
  console.log(`\n${bills.filter((b) => b.status === 'open').length} open of ${bills.length} bills in T:0; saved ${file}`);
} else if (command === 'show') {
  print(view(ledger));
} else if (command === 'verify' && billId) {
  const row = view(ledger).find((r) => r.billId === billId);
  const vendorId = flag('--vendor');
  const destination = flag('--destination') ?? '';
  const by = flag('--by');
  const evidence = flag('--evidence');
  const host = (() => {
    try {
      return new URL(destination).hostname;
    } catch {
      return '';
    }
  })();
  const problem = !row
    ? 'unknown bill for this entity'
    : row.action === 'WITHDRAWN' || row.action === 'NOT_PAYABLE'
      ? `bill is ${row.action}`
      : !vendorId || vendorId !== row.vendorId
        ? `vendor must be the bill's linked record (${row.vendorId || 'none'})`
        : !checkPortal(destination, { portalDomain: host }).allowed || !host
          ? 'destination must be a plain https checkout url'
          : !by || !evidence
            ? '--by and --evidence are required'
            : undefined;
  if (problem) {
    console.error(`not recorded: ${problem}`);
    process.exit(1);
  }
  ledger.addReview({ key: row!.key, billVersion: billVersion(row!), vendorId: vendorId!, destination, decision: 'VENDOR_VERIFIED', by: by!, evidence: evidence! });
  print(view(ledger).filter((r) => r.billId === billId));
} else {
  console.error(USAGE);
  process.exit(1);
}
