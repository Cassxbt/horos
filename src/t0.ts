import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import type { ReadBack } from './accounting.ts';

// Read-only client for T:0 vendor bills. Nothing here writes to the accounting system.

const BASE = process.env.T0_BASE_URL ?? 'https://api.t0.ai';
// api.t0.ai can take over a second to accept a connection; Node's default 250 ms per address gives up first.
setDefaultAutoSelectFamilyAttemptTimeout(2000);

export type Bill = {
  billId: string;
  entityId: string;
  vendorId: string;
  vendorName: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  billDate: string;
  dueDate: string;
  // T:0's own lifecycle status: only an `open` bill is payable; the others are history.
  status: string;
  sourcePlatform: string | null;
  // What in the source record contradicts itself; a bill with any is held until a person or T:0 settles it.
  conflicts?: string[];
};

type Ref = { dataType: string; externalId: string };
type RawBill = {
  id: Ref;
  data: { total: number; currencyCode: string; date: string; dueDate: string; status: string; paidDate?: string | null; voidedDate?: string | null; customFields?: Record<string, string> };
  links?: Ref[];
  expanded?: { vendor?: { id: Ref; data: { name: string } }[] };
};

export function normalizeBill(entityId: string, raw: RawBill): Bill {
  // A bill pays one supplier: with links to two vendor records there is no single vendor to approve, so none is taken.
  // A repeated link to the same record is still one vendor; a link spelled 'vendor' is still a vendor link.
  const vendorIds = [...new Set((raw.links ?? []).filter((l) => l?.dataType?.trim().toLowerCase() === 'vendor').map((l) => l.externalId))];
  const vendorLink = vendorIds.length === 1 ? { dataType: 'Vendor', externalId: vendorIds[0] } : undefined;
  const vendor = raw.expanded?.vendor?.find((v) => v.id.externalId === vendorLink?.externalId);
  const fields = raw.data.customFields ?? {};
  // An open bill that also carries a paid or voided date may already be settled; which field wins is T:0's to say.
  const conflicts = [
    ...(vendorIds.length > 1 ? ['MULTIPLE_VENDOR_LINKS'] : []),
    ...(raw.data.status === 'open' && raw.data.paidDate ? ['OPEN_WITH_PAID_DATE'] : []),
    ...(raw.data.status === 'open' && raw.data.voidedDate ? ['OPEN_WITH_VOIDED_DATE'] : []),
  ];
  return {
    billId: raw.id.externalId,
    entityId,
    vendorId: vendorLink?.externalId ?? '',
    vendorName: vendor?.data.name ?? '',
    invoiceNumber: fields.bill_number ?? fields.invoice_number ?? '',
    amount: raw.data.total,
    currency: raw.data.currencyCode,
    billDate: raw.data.date,
    dueDate: raw.data.dueDate,
    status: raw.data.status,
    sourcePlatform: fields.t0_primary_source_platform ?? null,
    conflicts,
  };
}

type Get = (url: string) => Promise<{ data: RawBill[]; next_cursor: string | null }>;

const httpGet: Get = async (url) => {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.T0_API_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`T:0 returned HTTP ${res.status}`);
  return res.json();
};

// Every bill for one entity, whatever its status, across every page, with its linked vendor record. Paid and voided
// bills are read too: a copy of an invoice that was already paid is the strongest reason not to pay it again.
export async function sourceBills(entityId: string, get: Get = httpGet): Promise<Bill[]> {
  const bills: Bill[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ entity: entityId, expand: 'vendor', limit: '50', ...(cursor ? { cursor } : {}) });
    const r = await get(`${BASE}/v1/vendor-bills?${query}`);
    bills.push(...r.data.map((b) => normalizeBill(entityId, b)));
    if (!r.next_cursor) return bills;
    cursor = r.next_cursor;
  }
  throw new Error('T0_TOO_MANY_PAGES');
}

// Writes are separate from reads and need an explicit switch: accounting is changed only on purpose.
const writeHeaders = () => {
  if (process.env.T0_WRITE_ENABLED !== '1') throw new Error('T0_WRITE_DISABLED: set T0_WRITE_ENABLED=1 to write to T:0');
  return { Authorization: `Bearer ${process.env.T0_API_KEY}`, 'content-type': 'application/json' };
};

// POST /v1/records: all-or-nothing batch; 202 with {received, inserted, duplicates}. An identical resubmission is
// counted as a duplicate; the same id with different content replaces the record, so callers resend exact bytes.
export async function postRecords(records: unknown[]) {
  const res = await fetch(`${BASE}/v1/records`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(records), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

// A submitted record becomes readable after T:0's nightly processing, found by our own id. Unconfirmed live: in this
// sandbox the readable types are Invoice, VendorBill, Payment, Customer, Vendor, LineItem and BillLineItem, and a
// BillPayment lookup returns CAPI66. The supported read-back for a vendor bill payment is to be settled with T:0.
export async function findPaymentRecord(entityId: string, recordId: string) {
  const found: ReadBack[] = [];
  let cursor: string | null = null;
  // Every page: a uniqueness check on the first page alone could miss a second copy.
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ entity: entityId, platform_object_ids: recordId, ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${BASE}/v1/payments?${query}`, { headers: { Authorization: `Bearer ${process.env.T0_API_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`T:0 returned HTTP ${res.status}`);
    const r = (await res.json()) as { data: ReadBack[]; next_cursor?: string | null };
    found.push(...r.data);
    if (!r.next_cursor) return found;
    cursor = r.next_cursor;
  }
  throw new Error('T0_TOO_MANY_PAGES');
}
