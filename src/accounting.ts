import type { AccountingRecord, Ledger, Obligation } from './ledger.ts';
import { toCents, type ApprovalTerms } from './policy.ts';

type Link = { dataType: string; externalId: string };
type Payload = ReturnType<typeof paymentRecord>;
export type ReadBack = { id?: { externalId: string; dataType?: string }; data: { amount: number; currencyCode: string; type?: string; customFields?: Record<string, unknown> }; links?: Link[] };
export type T0Writer = {
  post: (records: unknown[]) => Promise<{ status: number; body: unknown }>;
  find: (recordId: string) => Promise<ReadBack[]>;
};
// The provider's own reading of a payment: what was actually charged, as opposed to what was approved.
export type ProviderPayment = { id: string; status: string; amount: unknown; currency: unknown };

// The one shape of the record a paid bill owes T:0: built from what was approved, the attempt that paid, the
// provider's payment and the day it was recorded paid. Nothing else goes into it.
export const paymentRecord = (recordId: string, attempt: string, approved: ApprovalTerms, providerRef: string, paidAt: string) => ({
  id: { dataType: 'BillPayment', externalId: recordId },
  data: { amount: toCents(approved.amount) / 100, currencyCode: approved.currency, date: paidAt.slice(0, 10), type: 'bill', customFields: { horos_attempt: attempt, airwallex_payment: providerRef || null } },
  links: [
    { dataType: 'VendorBill', externalId: approved.invoiceId },
    { dataType: 'Vendor', externalId: approved.vendorId },
  ],
});

const exactCents = (amount: unknown): amount is number => typeof amount === 'number' && Number.isFinite(amount) && Math.abs(toCents(amount) - amount * 100) < 1e-6;
// The one link of a type, or undefined when there is none or more than one: a second bill or vendor makes the
// attribution ambiguous, never half right.
const onlyLink = (links: Link[] | undefined, dataType: string) => {
  const all = (Array.isArray(links) ? links : []).filter((l) => l?.dataType === dataType);
  return all.length === 1 ? all[0].externalId : undefined;
};

// Stored JSON that no longer parses is a problem with that entry, never a crash that hides every other entry.
const parsed = (text: string | null) => {
  try {
    return { ok: true as const, value: text === null ? null : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false as const, value: undefined };
  }
};

// Why this entry may not go to the books, or nothing when it may. The provider must have settled exactly what the
// person approved, for this attempt, to the cent, and the stored payload must be exactly the record built from those
// facts. The same rule decides a new entry and re-checks one stored by an older version, before it is first sent and
// before it is confirmed.
export function entryProblems(entry: Pick<AccountingRecord, 'record_id' | 'attempt_id' | 'provider_ref' | 'payload' | 'settlement'>, o: Obligation, approved: ApprovalTerms | undefined, paidAt: string | undefined) {
  if (!approved) return ['NO_APPROVAL'];
  const problems: string[] = [];
  const approvedCents = toCents(approved.amount);
  if (o.state !== 'PAID' || o.attempt_id !== entry.attempt_id) problems.push('NOT_THE_PAYING_ATTEMPT');
  if (o.amount_cents !== approvedCents || o.currency !== approved.currency) problems.push('OBLIGATION_DIFFERS_FROM_APPROVAL');

  const settlement = parsed(entry.settlement);
  const settled = (settlement.value ?? undefined) as ProviderPayment | undefined;
  if (!settlement.ok) problems.push('SETTLEMENT_UNREADABLE');
  else if (!settled) problems.push('NO_PROVIDER_SETTLEMENT');
  else if (!entry.provider_ref || settled.id !== entry.provider_ref) problems.push('SETTLEMENT_IS_ANOTHER_PAYMENT');
  else if (settled.status !== 'SUCCEEDED') problems.push(`PROVIDER_STATUS_${settled.status}`);
  else if (!exactCents(settled.amount) || toCents(settled.amount) !== approvedCents || settled.currency !== approved.currency) {
    problems.push(`PROVIDER_SETTLED_${settled.currency} ${settled.amount}_APPROVED_${approved.currency} ${approved.amount.toFixed(2)}`);
  }

  if (!paidAt) return [...problems, 'NO_PAID_DATE'];
  const payload = parsed(entry.payload);
  if (!payload.ok) return [...problems, 'PAYLOAD_UNREADABLE'];
  const stored = payload.value as Record<string, unknown> | null;
  const expected = paymentRecord(entry.record_id, entry.attempt_id, approved, entry.provider_ref, paidAt) as Record<string, unknown>;
  const at = (r: Record<string, unknown> | null, path: string) => path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], r);
  const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
  const fields = [...new Set([...keys(stored), ...keys(expected)])].flatMap((k) => (k === 'data' ? [...new Set([...keys(stored?.data), ...keys(expected.data)])].map((d) => `data.${d}`) : [k]));
  const differ = fields.filter((f) => JSON.stringify(at(stored, f)) !== JSON.stringify(at(expected, f)));
  if (differ.length) problems.push(`PAYLOAD_DIFFERS:${differ.join(',')}`);
  return problems;
}

// CONFIRMED means T:0's copy is ours in every identity it can show, unambiguously: our record id, exactly one bill
// link and one vendor link, the Airwallex payment and the attempt that made it, the currency, and the amount to the
// exact cent. The date is not compared until T:0 says whether processing keeps it as sent.
export function sameEntry(found: unknown[], payload: Payload) {
  const r = found.length === 1 ? (found[0] as ReadBack | null) : undefined;
  if (!r || typeof r !== 'object' || !r.data || typeof r.data !== 'object') return false;
  const fields = r.data.customFields ?? {};
  // A field T:0 may drop is not required, but one it states differently is a contradiction.
  const stated = (value: unknown, ours: unknown) => value === undefined || value === ours;
  return (
    r.id?.externalId === payload.id.externalId &&
    stated(r.id?.dataType, payload.id.dataType) &&
    stated(r.data.type, payload.data.type) &&
    exactCents(r.data.amount) &&
    toCents(r.data.amount) === toCents(payload.data.amount) &&
    r.data.currencyCode === payload.data.currencyCode &&
    fields.airwallex_payment === payload.data.customFields?.airwallex_payment &&
    fields.horos_attempt === payload.data.customFields?.horos_attempt &&
    onlyLink(r.links, 'VendorBill') === onlyLink(payload.links, 'VendorBill') &&
    onlyLink(r.links, 'Vendor') === onlyLink(payload.links, 'Vendor')
  );
}

// T:0 answers a batch with 202 and counters for what it took. For our one-record batch, an acknowledgement accounts for
// the record only if exactly one was received and it was either inserted or an identical duplicate.
const acknowledges = (body: unknown) => {
  const b = (body ?? {}) as { received?: unknown; inserted?: unknown; duplicates?: unknown };
  return b.received === 1 && typeof b.inserted === 'number' && typeof b.duplicates === 'number' && b.inserted + b.duplicates === 1;
};

// Recorded on a PENDING entry just before it is sent, so a lost acknowledgement is never mistaken for no send.
const SENT_UNACKNOWLEDGED = 'sent to T:0; acknowledgement not yet received';

// What a stored entry's problems mean for it now: one never sent is simply held; one T:0 may already hold, because
// it was sent, accepted or confirmed, is held with the record id to check there before anything is amended.
const reviewNote = (rec: AccountingRecord, problems: string[]) => {
  const reason = problems.join(', ');
  if (rec.status === 'PENDING' && rec.detail !== SENT_UNACKNOWLEDGED) return `not sent: ${reason}`;
  const delivery = rec.status === 'PENDING' ? 'delivery to T:0 unknown (sent, never acknowledged)' : 'already sent to T:0';
  return `${delivery}; check record ${rec.record_id} there before amending: ${reason}`;
};

export function auditEntry(ledger: Ledger, rec: AccountingRecord) {
  const o = ledger.get(rec.key);
  if (!o) return ['NO_OBLIGATION'];
  const paidAt = ledger.history(rec.key).filter((h) => h.attempt_id === rec.attempt_id && h.to_state === 'PAID').at(-1)?.at;
  return entryProblems(rec, o, o.approval_digest ? ledger.approval(o.approval_digest)?.terms : undefined, paidAt);
}

// Moves the selected accounting records one step toward CONFIRMED. It sends only the exact payload stored when the
// payment was recorded, so a retry after a lost acknowledgement is a duplicate, never a second or different entry,
// and only after that payload passes the same check a new entry does. It reads and writes accounting state only:
// nothing here can start, repeat or reverse a payment.
export async function syncAccounting(ledger: Ledger, t0: T0Writer, keys: string[]) {
  const results: { key: string; recordId: string; from: string; to: string; detail?: string }[] = [];
  for (const rec of ledger.accounting().filter((r) => keys.includes(r.key) && ['PENDING', 'ACCEPTED', 'CONFIRMED'].includes(r.status))) {
    let status = rec.status;
    const move = (to: typeof status, detail: string) => {
      if (ledger.setAccounting(rec.key, status, to, detail)) {
        results.push({ key: rec.key, recordId: rec.record_id, from: status, to, detail });
        status = to;
      }
    };
    const problems = auditEntry(ledger, rec);
    if (problems.length) {
      move('NEEDS_REVIEW', reviewNote(rec, problems));
      continue;
    }
    const payload = JSON.parse(rec.payload) as Payload;
    if (status === 'PENDING') {
      ledger.setAccounting(rec.key, 'PENDING', 'PENDING', SENT_UNACKNOWLEDGED);
      const sent = await t0.post([payload]).catch((e) => ({ status: 0, body: (e as Error).message }));
      if (sent.status === 202 && acknowledges(sent.body)) move('ACCEPTED', JSON.stringify(sent.body));
      else if (sent.status === 202) results.push({ key: rec.key, recordId: rec.record_id, from: status, to: status, detail: `delivery unverified: 202 without a count for this record ${JSON.stringify(sent.body)}` });
      else if (sent.status >= 400 && sent.status < 500 && sent.status !== 409 && sent.status !== 429) move('REJECTED', JSON.stringify(sent.body));
      else results.push({ key: rec.key, recordId: rec.record_id, from: status, to: status, detail: `will retry: ${sent.status || 'no response'}` });
    }
    if (status === 'ACCEPTED') {
      const found = await t0.find(rec.record_id).catch(() => undefined);
      if (!found || found.length === 0) {
        results.push({ key: rec.key, recordId: rec.record_id, from: status, to: status, detail: found ? 'not yet readable (T:0 books records nightly)' : 'read-back failed' });
        continue;
      }
      move(sameEntry(found, payload) ? 'CONFIRMED' : 'MISMATCH', JSON.stringify(found));
    }
  }
  return results;
}
