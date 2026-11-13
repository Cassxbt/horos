import { createHash } from 'node:crypto';
import { validMoney } from './policy.ts';
import type { Bill } from './t0.ts';

export type Action = 'READY_FOR_APPROVAL' | 'NEEDS_VENDOR_VERIFICATION' | 'HOLD_FOR_REVIEW' | 'WITHDRAWN' | 'NOT_PAYABLE';

export type Flag =
  | { kind: 'EXACT_DUPLICATE'; others: string[]; notOpen: string[] }
  | { kind: 'POSSIBLE_DUPLICATE'; others: string[]; evidence: string }
  | { kind: 'VENDOR_LINK_MISSING' }
  | { kind: 'VENDOR_NAME_SHARED'; otherVendorIds: string[] }
  | { kind: 'VENDOR_VERIFIED'; by: string; destination: string; at: string }
  | { kind: 'CHANGED_IN_SOURCE'; fields: string[] }
  | { kind: 'NOT_IN_LATEST_IMPORT' }
  | { kind: 'RECURRING'; series: string[] }
  | { kind: 'OVERDUE'; daysPastDue: number }
  | { kind: 'UNSUPPORTED_MONEY' }
  | { kind: 'SOURCE_CONFLICT'; conflicts: string[] }
  | { kind: 'SUPPLIER_EMAIL'; at: string; from: string; subject: string; passage: string; reasons: string[]; emailSha256: string };

export type Triaged = Bill & { action: Action; flags: Flag[] };

const SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'technologies', 'technology', 'systems']);

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t && !SUFFIXES.has(t));

const exactName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "Dell Inc." and "Dell Technologies Inc." lead with the same distinctive word; "Hewlett-Packard Inc." does not.
const similarVendors = (a: Bill, b: Bill) => {
  const [x, y] = [nameTokens(a.vendorName), nameTokens(b.vendorName)];
  return x.length > 0 && y.length > 0 && x[0] === y[0];
};

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

// The fields a payment decision rests on. A verification or an approval is only valid for this exact version.
export const billVersion = (b: Bill) =>
  createHash('sha256')
    .update(JSON.stringify([b.entityId, b.billId, b.vendorId, b.vendorName, b.invoiceNumber, b.amount, b.currency, b.dueDate]))
    .digest('hex')
    .slice(0, 16);

// Flags each open bill against every bill ever seen for the entity, open or not. A copy that was paid, voided or
// dropped from the open list is still a copy: the hold it caused stands until a person decides, and a vendor name once
// shared by two vendor records stays ambiguous.
export function triage(bills: Bill[], today: string, seen: Bill[] = bills): Triaged[] {
  return bills.map((bill) => {
    const flags: Flag[] = [];
    if (!validMoney(bill.amount, bill.currency)) flags.push({ kind: 'UNSUPPORTED_MONEY' });
    if (!bill.vendorId || !bill.vendorName) flags.push({ kind: 'VENDOR_LINK_MISSING' });
    if (bill.conflicts?.length) flags.push({ kind: 'SOURCE_CONFLICT', conflicts: bill.conflicts });

    // The same supplier invoice recorded twice under two accounting ids: the strongest duplicate signal there is.
    const copies = seen.filter(
      (o) => o.billId !== bill.billId && o.entityId === bill.entityId && o.vendorId === bill.vendorId && o.invoiceNumber === bill.invoiceNumber && o.amount === bill.amount && o.currency === bill.currency,
    );
    const notOpen = (o: Bill) => (o.status && o.status !== 'open' ? `${o.billId} (${o.status})` : undefined);
    if (bill.invoiceNumber && copies.length) {
      flags.push({ kind: 'EXACT_DUPLICATE', others: copies.map((o) => o.billId), notOpen: copies.map(notOpen).filter((x): x is string => Boolean(x)) });
    }

    const lookalikes = seen.filter(
      (o) =>
        o.billId !== bill.billId &&
        !copies.includes(o) &&
        o.amount === bill.amount &&
        o.currency === bill.currency &&
        o.dueDate === bill.dueDate &&
        similarVendors(o, bill) &&
        (o.vendorId !== bill.vendorId || o.invoiceNumber !== bill.invoiceNumber),
    );
    if (lookalikes.length) {
      flags.push({
        kind: 'POSSIBLE_DUPLICATE',
        others: lookalikes.map((o) => o.billId),
        evidence: lookalikes
          .map((o) => `${o.vendorName} ${o.invoiceNumber} (vendor ${o.vendorId === bill.vendorId ? 'same record' : 'different record'}${notOpen(o) ? `, ${o.status} in T:0` : ''}), same amount and due date`)
          .join('; '),
      });
    }

    const namesakes = [...new Set(seen.filter((o) => o.vendorId && o.vendorId !== bill.vendorId && exactName(o.vendorName) === exactName(bill.vendorName)).map((o) => o.vendorId))];
    if (bill.vendorName && namesakes.length) flags.push({ kind: 'VENDOR_NAME_SHARED', otherVendorIds: namesakes });

    const series = bills
      .filter((o) => o.entityId === bill.entityId && o.vendorId === bill.vendorId && o.amount === bill.amount && o.currency === bill.currency && o.invoiceNumber !== bill.invoiceNumber)
      .concat(bill)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const gaps = series.slice(1).map((o, i) => days(series[i].dueDate, o.dueDate));
    if (series.length >= 3 && gaps.every((g) => g === gaps[0] && g > 0)) flags.push({ kind: 'RECURRING', series: series.map((o) => o.invoiceNumber) });

    const late = days(bill.dueDate, today);
    if (late > 0) flags.push({ kind: 'OVERDUE', daysPastDue: late });
    return { ...bill, action: decide(flags), flags };
  });
}

const HOLD: Flag['kind'][] = ['EXACT_DUPLICATE', 'POSSIBLE_DUPLICATE', 'UNSUPPORTED_MONEY', 'VENDOR_LINK_MISSING', 'SOURCE_CONFLICT', 'CHANGED_IN_SOURCE', 'SUPPLIER_EMAIL'];

function decide(flags: Flag[]): Action {
  const has = (k: Flag['kind']) => flags.some((f) => f.kind === k);
  if (has('NOT_IN_LATEST_IMPORT')) return 'WITHDRAWN';
  if (HOLD.some(has)) return 'HOLD_FOR_REVIEW';
  if (has('VENDOR_NAME_SHARED') && !has('VENDOR_VERIFIED')) return 'NEEDS_VENDOR_VERIFICATION';
  return 'READY_FOR_APPROVAL';
}

export type Review = { bill_version: string; vendor_id: string; destination: string; decision: string; by: string; evidence: string; at: string };

// A supplier email holds every bill of that vendor record while any reading of it is unfinished, and from its first
// holding reading on, whatever a later reading says: only a person's verification made after the hold releases it, as
// an earlier one cannot have accounted for the email. Each reading resolves only its own pending record, and a routine
// reading of one email never clears another. One standing hold per email: its latest holding record. `reviews` is in
// the ledger's order, oldest first.
export function emailHolds(reviews: Review[]): Review[] {
  // Records from before readings carried an id belong to their email alone, as they did then: a later decision about
  // the same email finishes its pending reading, and nothing about another email does.
  const records = reviews
    .filter((r) => r.decision.startsWith('SUPPLIER_EMAIL_'))
    .map((r) => {
      const e = JSON.parse(r.evidence) as { emailSha256: string; readingId?: string };
      return { r, email: e.emailSha256, reading: e.readingId ?? `before reading ids: ${e.emailSha256}` };
    });
  const standing = new Map<string, Review>();
  const decidedLater = new Set<string>();
  for (const { r, email, reading } of records.reverse()) {
    if (r.decision !== 'SUPPLIER_EMAIL_PENDING') decidedLater.add(reading);
    const holds = r.decision === 'SUPPLIER_EMAIL_HOLD' || (r.decision === 'SUPPLIER_EMAIL_PENDING' && !decidedLater.has(reading));
    if (holds && !standing.has(email)) standing.set(email, r);
  }
  return [...standing.values()];
}
export type StoredBill = { key: string; bill: Bill; current: Bill; changed: { fields: string[] } | null; state: string; reviews: Review[]; vendorReviews?: Review[] };

// The one answer to "may this bill be paid", for import, show and the payment executor alike. It is computed from the
// ledger: the latest complete import, the version last seen, a person's verification and the payable's own state.
export function queueView(stored: StoredBill[], latestImport: { billIds: string[]; closed?: Bill[] } | undefined, today: string) {
  const inLatest = new Set(latestImport?.billIds ?? []);
  const open = stored.filter((s) => inLatest.has(s.current.billId)).map((s) => ({ ...s.current, status: 'open' }));
  // Every bill ever seen, with its latest known status: a stored bill gone from the open list is at least not open.
  const closed = new Map((latestImport?.closed ?? []).map((b) => [b.billId, b]));
  const seen = [
    ...open,
    ...stored.filter((s) => !inLatest.has(s.current.billId)).map((s) => closed.get(s.current.billId) ?? { ...s.current, status: 'no longer open' }),
    ...[...closed.values()].filter((b) => !stored.some((s) => s.current.billId === b.billId)),
  ];
  const flagged = new Map(triage(open, today, seen).map((t) => [t.billId, t]));
  return stored.map((s) => {
    const base = flagged.get(s.current.billId) ?? { ...s.current, action: 'WITHDRAWN' as Action, flags: [] as Flag[] };
    const flags = [...base.flags];
    if (!inLatest.has(s.current.billId)) flags.push({ kind: 'NOT_IN_LATEST_IMPORT' });
    if (s.changed) flags.push({ kind: 'CHANGED_IN_SOURCE', fields: s.changed.fields });
    const version = billVersion(s.current);
    // Only the latest verification counts: a newer one for another destination replaces it, it does not add to it.
    const latest = s.reviews.filter((r) => r.decision === 'VENDOR_VERIFIED').at(-1);
    const verified = latest && latest.bill_version === version && latest.vendor_id === s.current.vendorId ? latest : undefined;
    if (verified) flags.push({ kind: 'VENDOR_VERIFIED', by: verified.by, destination: verified.destination, at: verified.at });
    for (const hold of emailHolds(s.vendorReviews ?? [])) {
      if (verified && verified.at > hold.at) continue;
      const e = JSON.parse(hold.evidence) as { from: string; subject: string; passage: string; reasons: string[]; emailSha256: string };
      flags.push({ kind: 'SUPPLIER_EMAIL', at: hold.at, from: e.from, subject: e.subject, passage: e.passage, reasons: e.reasons, emailSha256: e.emailSha256 });
    }
    // `eligibility` is the bill's own verdict; `action` also says whether its payable is free to start a payment.
    const eligibility = decide(flags);
    const action: Action = s.state !== 'OPEN' ? 'NOT_PAYABLE' : eligibility;
    const verification = verified && {
      id: createHash('sha256').update(JSON.stringify([s.key, verified.bill_version, verified.vendor_id, verified.destination, verified.by, verified.evidence, verified.at])).digest('hex').slice(0, 16),
      by: verified.by,
      at: verified.at,
      destination: verified.destination,
      evidence: verified.evidence,
      billVersion: verified.bill_version,
    };
    return { key: s.key, ...s.current, version, state: s.state, action, eligibility, flags, verification };
  });
}
