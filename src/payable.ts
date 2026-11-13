import type { Ledger } from './ledger.ts';
import { obligationKey, toCents, type Invoice, type Vendor } from './policy.ts';
import { queueView, type Action, type Flag } from './queue.ts';
import type { Bill } from './t0.ts';
import { vendorReviewKey } from './email.ts';
import { invoice as demoInvoice, vendor as demoVendor } from './demo-data.ts';

// The T:0 sandbox entity provided for the hackathon.
export const T0_ENTITY = process.env.T0_ENTITY ?? 'entity_prod_ieEAMzvhgtHalvsm';
export const latestImportSetting = (entity: string) => `t0_latest_import:${entity}`;

// Records one complete read of an entity's bills: every open bill as a payable, the rest as history, and the
// completed-import marker, in one transaction, so readers see the old snapshot or the new one, never a mix of both. An
// open bill missing from it is withdrawn; the history, kept across reads, is what duplicate checks compare against.
export function recordImport(ledger: Ledger, entity: string, bills: Bill[]) {
  const open = bills.filter((b) => b.status === 'open');
  return ledger.atomically(() => {
    const result = new Map(open.map((b) => [b.billId, ledger.importBill(`${b.entityId}/${b.billId}`, b, toCents(b.amount))]));
    // Closed bills accumulate: one seen paid stays known after it stops appearing, so a duplicate it caused is not
    // forgotten. The latest status of each wins, and a bill open again is a payable, not history.
    const previous = JSON.parse(ledger.setting(latestImportSetting(entity)) ?? '{}') as { closed?: Bill[] };
    const openIds = new Set(open.map((b) => b.billId));
    const closed = [
      ...(previous.closed ?? []).filter((b) => !openIds.has(b.billId) && !bills.some((n) => n.billId === b.billId)),
      ...bills.filter((b) => b.status !== 'open'),
    ];
    ledger.setSetting(latestImportSetting(entity), JSON.stringify({ at: new Date().toISOString(), billIds: open.map((b) => b.billId), closed }));
    return result;
  });
}

// The queue as the ledger knows it: the one answer import, show and the payment executor all read.
export function queueFor(ledger: Ledger, entity = T0_ENTITY, today = new Date().toISOString().slice(0, 10)) {
  const stored = ledger.bills(entity).map((r) => ({ ...r, reviews: ledger.reviews(r.key), vendorReviews: r.current.vendorId ? ledger.reviews(vendorReviewKey(entity, r.current.vendorId)) : [] }));
  const latest = ledger.setting(latestImportSetting(entity));
  return queueView(stored, latest ? JSON.parse(latest) : undefined, today);
}

export type Payable = {
  key: string;
  invoice: Invoice;
  vendor: Vendor;
  // The version of the source bill a decision was made on; null for the built-in demo invoice.
  sourceVersion: string | null;
  // The person's verification of who this pays, and the full checkout address they verified; null when absent.
  verification: { id: string; by: string; at: string; destination: string; evidence: string; billVersion: string } | null;
  invoiceNumber: string;
  action: Action;
  eligibility: Action;
  flags: Flag[];
  source: 'T0_BILL' | 'DEMO_FIXTURE';
};

// What a payment command acts on: an imported T:0 bill, with its verified destination, or the built-in demo invoice.
export function payableFor(ledger: Ledger, billId?: string): Payable | undefined {
  if (!billId) {
    return { key: obligationKey(demoInvoice), invoice: demoInvoice, vendor: demoVendor, sourceVersion: null, verification: null, invoiceNumber: demoInvoice.id, action: 'READY_FOR_APPROVAL', eligibility: 'READY_FOR_APPROVAL', flags: [], source: 'DEMO_FIXTURE' };
  }
  const row = queueFor(ledger).find((r) => r.billId === billId);
  if (!row) return undefined;
  const host = row.verification ? new URL(row.verification.destination).hostname : '';
  const invoice: Invoice = { id: row.billId, entityId: row.entityId, vendorId: row.vendorId, amount: row.amount, currency: row.currency, dueDate: row.dueDate };
  const vendor: Vendor = {
    id: row.vendorId,
    name: row.vendorName,
    iban: '',
    portalDomain: host,
    merchantDescriptor: row.vendorName.toUpperCase().replace(/[^A-Z0-9 ]+/g, '').replace(/ +/g, ' ').trim().slice(0, 25),
    mcc: '',
    currency: row.currency,
  };
  return { key: row.key, invoice, vendor, sourceVersion: row.version, verification: row.verification ?? null, invoiceNumber: row.invoiceNumber, action: row.action, eligibility: row.eligibility, flags: row.flags, source: 'T0_BILL' };
}
