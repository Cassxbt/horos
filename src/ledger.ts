import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { entryProblems, paymentRecord, type ProviderPayment } from './accounting.ts';
import { approvalDigest, type ApprovalTerms } from './policy.ts';

// OPEN: nothing in flight. RESERVED: one attempt owns it and may move money. PAYMENT_UNKNOWN: money may have moved;
// every rail is blocked until reconciliation. PAID and EXCEPTION are terminal until a person acts.
export type ObligationState = 'OPEN' | 'RESERVED' | 'PAYMENT_UNKNOWN' | 'PAID' | 'EXCEPTION';
export type Rail = 'ISSUED_CARD' | 'VIC_CHECKOUT';

export type Obligation = {
  key: string;
  amount_cents: number;
  currency: string;
  state: ObligationState;
  rail: Rail | null;
  attempt_id: string | null;
  reserved_at: string | null;
  approval_digest: string | null;
  detail: string | null;
  updated_at: string;
};

export type IssuedCard = { request_id: string; card_id: string | null; label: string; status: string; at: string };

export type SavedApproval = { digest: string; terms: ApprovalTerms; approvedBy: string; approvedAt: string };

export type Operation = {
  request_id: string;
  obligation: string;
  attempt_id: string;
  rail: Rail;
  kind: string;
  external_id: string | null;
  status: string;
  detail: string | null;
  at: string;
};

export type HistoryEntry = { key: string; at: string; attempt_id: string | null; from_state: string; to_state: string; detail: string | null };

// A result Airi must hear, owed by one mandate. Written in the same transaction as the outcome it reports, so a
// crash can never leave an outcome without its report, and one mandate's report never stands in for another's.
export type PendingReport = { mandate_id: string; obligation: string; attempt_id: string; result: 'SUCCEEDED' | 'DECLINED'; reason: string | null; status: string; at: string };

// PENDING: owed, not yet accepted. ACCEPTED: T:0 took it (202) but it is not yet readable. CONFIRMED: read back and
// matching. REJECTED, MISMATCH and NEEDS_REVIEW (an entry the approval and the provider's settlement do not both
// support) need a person. None of these states can ever start a payment.
export type AccountingStatus = 'PENDING' | 'ACCEPTED' | 'CONFIRMED' | 'REJECTED' | 'MISMATCH' | 'NEEDS_REVIEW';
export type AccountingRecord = { key: string; record_id: string; attempt_id: string; provider_ref: string; payload: string; settlement: string | null; status: AccountingStatus; detail: string | null; at: string };

export class LostOwnership extends Error {
  constructor(key: string) {
    super(`LOST_OWNERSHIP ${key}`);
  }
}

const SCHEMA_VERSION = 7;
// Additive steps from an older ledger, so paid locks, reports and approvals under real bill keys survive an upgrade.
const MIGRATIONS: Record<number, string> = {
  4: `ALTER TABLE bills ADD COLUMN current TEXT;
      CREATE TABLE IF NOT EXISTS reviews (key TEXT NOT NULL, bill_version TEXT NOT NULL, vendor_id TEXT NOT NULL, destination TEXT NOT NULL, decision TEXT NOT NULL, by TEXT NOT NULL, evidence TEXT NOT NULL, at TEXT NOT NULL);`,
  5: `CREATE TABLE IF NOT EXISTS accounting (
      key TEXT PRIMARY KEY REFERENCES obligations(key),
      record_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    );`,
  6: `ALTER TABLE accounting ADD COLUMN settlement TEXT;`,
};

const ALLOWED: Record<ObligationState, ObligationState[]> = {
  OPEN: ['RESERVED'],
  // Back to OPEN only when the rail proved no money moved and nothing can still move it.
  RESERVED: ['OPEN', 'PAYMENT_UNKNOWN', 'PAID', 'EXCEPTION'],
  PAYMENT_UNKNOWN: ['OPEN', 'PAID', 'EXCEPTION'],
  PAID: [],
  // Only through `horos.ts resolve`: a person's recorded decision after reviewing the remediation.
  EXCEPTION: ['PAID', 'OPEN'],
};

export function openLedger(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  // Switching to WAL takes a lock the busy timeout does not cover, so a second process opening at the same moment
  // retries instead of failing.
  for (let i = 0; ; i++) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      break;
    } catch (e) {
      if (i > 50 || !/locked|busy/i.test((e as Error).message)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  // Schema check and creation in one write transaction: a process opening a brand-new file never sees it half made.
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligations'").get();
    if (hasTables && version !== SCHEMA_VERSION) {
      if (!MIGRATIONS[version]) throw new Error(`LEDGER_SCHEMA_OUTDATED ${file}: no migration from v${version}; move it aside and start a new ledger`);
      for (let v = version; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS obligations (
      key TEXT PRIMARY KEY,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL,
      rail TEXT,
      attempt_id TEXT,
      reserved_at TEXT,
      approval_digest TEXT,
      detail TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      request_id TEXT PRIMARY KEY,
      obligation TEXT NOT NULL REFERENCES obligations(key),
      attempt_id TEXT NOT NULL,
      rail TEXT NOT NULL,
      kind TEXT NOT NULL,
      external_id TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cards (
      request_id TEXT PRIMARY KEY,
      card_id TEXT,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      key TEXT NOT NULL,
      at TEXT NOT NULL,
      attempt_id TEXT,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS reports (
      mandate_id TEXT PRIMARY KEY,
      obligation TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      result TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bills (
      key TEXT PRIMARY KEY REFERENCES obligations(key),
      bill TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      changed TEXT,
      current TEXT
    );
    CREATE TABLE IF NOT EXISTS reviews (
      key TEXT NOT NULL,
      bill_version TEXT NOT NULL,
      vendor_id TEXT NOT NULL,
      destination TEXT NOT NULL,
      decision TEXT NOT NULL,
      by TEXT NOT NULL,
      evidence TEXT NOT NULL,
      at TEXT NOT NULL
    );
CREATE TABLE IF NOT EXISTS accounting (
      key TEXT PRIMARY KEY REFERENCES obligations(key),
      record_id TEXT NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      provider_ref TEXT NOT NULL,
      payload TEXT NOT NULL,
      settlement TEXT,
      status TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS approvals (
      digest TEXT PRIMARY KEY,
      obligation TEXT NOT NULL REFERENCES obligations(key),
      terms TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const now = () => new Date().toISOString();
  const get = (key: string) => db.prepare('SELECT * FROM obligations WHERE key = ?').get(key) as Obligation | undefined;

  // A stored approval whose terms no longer parse, or no longer hash to its digest, is treated as absent.
  const approval = (digest: string): SavedApproval | undefined => {
    const row = db.prepare('SELECT * FROM approvals WHERE digest = ?').get(digest) as
      | { digest: string; terms: string; approved_by: string; approved_at: string }
      | undefined;
    if (!row) return undefined;
    let terms: ApprovalTerms;
    try {
      terms = JSON.parse(row.terms) as ApprovalTerms;
    } catch {
      return undefined;
    }
    if (approvalDigest(terms) !== row.digest) return undefined;
    return { digest: row.digest, terms, approvedBy: row.approved_by, approvedAt: row.approved_at };
  };

  return {
    get,
    approval,
    // Registering an obligation twice keeps the first record: amount and currency cannot be rewritten later.
    open(key: string, amountCents: number, currency: string) {
      db.prepare("INSERT INTO obligations (key, amount_cents, currency, state, updated_at) VALUES (?, ?, ?, 'OPEN', ?) ON CONFLICT(key) DO NOTHING").run(
        key,
        amountCents,
        currency,
        now(),
      );
      const row = get(key)!;
      if (row.amount_cents !== amountCents || row.currency !== currency) throw new Error('OBLIGATION_TERMS_CHANGED');
      return row;
    },
    inState: (state: ObligationState) => db.prepare('SELECT * FROM obligations WHERE state = ? ORDER BY updated_at').all(state) as Obligation[],
    unsettled: () => db.prepare("SELECT * FROM obligations WHERE state IN ('RESERVED', 'PAYMENT_UNKNOWN') ORDER BY updated_at").all() as Obligation[],

    // The single atomic gate before any external side effect: exactly one caller, among all processes sharing this
    // ledger file, wins, and gets the attempt id that every later write must present.
    reserve(key: string, rail: Rail, digest: string): string | undefined {
      const attempt = randomUUID();
      const at = now();
      const r = db
        .prepare("UPDATE obligations SET state = 'RESERVED', rail = ?, attempt_id = ?, reserved_at = ?, approval_digest = ?, detail = NULL, updated_at = ? WHERE key = ? AND state = 'OPEN'")
        .run(rail, attempt, at, digest, at, key);
      if (r.changes !== 1) return undefined;
      db.prepare("INSERT INTO history (key, at, attempt_id, from_state, to_state, detail) VALUES (?, ?, ?, 'OPEN', 'RESERVED', ?)").run(key, at, attempt, rail);
      return attempt;
    },
    // Only the attempt holding a live reservation may start a side effect.
    owns: (key: string, attempt: string) =>
      Boolean(db.prepare("SELECT 1 FROM obligations WHERE key = ? AND attempt_id = ? AND state = 'RESERVED'").get(key, attempt)),
    // Compare-and-set on both state and attempt; a caller that lost the obligation is told, never silently ignored.
    // Every move is appended to the history, and a report Airi is owed is queued in the same transaction.
    transition(
      key: string,
      attempt: string,
      from: ObligationState,
      to: ObligationState,
      detail?: string,
      report?: Omit<PendingReport, 'obligation' | 'attempt_id' | 'status' | 'at'>,
      payment?: { ref: string; observed?: ProviderPayment },
    ) {
      if (!ALLOWED[from].includes(to)) throw new Error(`ILLEGAL_TRANSITION ${from}->${to}`);
      const at = now();
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = db
          .prepare(
            "UPDATE obligations SET state = ?, detail = ?, attempt_id = CASE WHEN ? = 'OPEN' THEN NULL ELSE attempt_id END, rail = CASE WHEN ? = 'OPEN' THEN NULL ELSE rail END, updated_at = ? WHERE key = ? AND state = ? AND attempt_id = ?",
          )
          .run(to, detail ?? null, to, to, at, key, from, attempt);
        if (r.changes !== 1) throw new LostOwnership(key);
        db.prepare('INSERT INTO history (key, at, attempt_id, from_state, to_state, detail) VALUES (?, ?, ?, ?, ?, ?)').run(key, at, attempt, from, to, detail ?? null);
        // A bill from the accounting system that becomes PAID owes that system one payment record, written now in
        // the same transaction with a stable id and its exact content. Its content comes from what the person approved
        // and what the provider paid, never from the bill as re-imported later: a refresh cannot rewrite the books. It
        // is postable only if the provider's own reading of the payment settles exactly that; otherwise a person
        // reviews it, whatever the obligation's outcome was.
        if (to === 'PAID' && db.prepare('SELECT 1 FROM bills WHERE key = ?').get(key)) {
          const o = get(key)!;
          const approved = o.approval_digest ? approval(o.approval_digest)?.terms : undefined;
          const recordId = `horos-payment-${createHash('sha256').update(`${key}|${attempt}`).digest('hex').slice(0, 24)}`;
          const providerRef = payment?.ref ?? '';
          const payload = approved && paymentRecord(recordId, attempt, approved, providerRef, at);
          const entry = { record_id: recordId, attempt_id: attempt, provider_ref: providerRef, payload: JSON.stringify(payload ?? null), settlement: payment?.observed ? JSON.stringify(payment.observed) : null };
          const problems = entryProblems(entry, o, approved, at);
          db.prepare('INSERT INTO accounting (key, record_id, attempt_id, provider_ref, payload, settlement, status, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING').run(
            key,
            entry.record_id,
            entry.attempt_id,
            entry.provider_ref,
            entry.payload,
            entry.settlement,
            problems.length ? 'NEEDS_REVIEW' : 'PENDING',
            problems.length ? `not sent: ${problems.join(', ')}` : null,
            at,
          );
        }
        if (report) {
          db.prepare("INSERT INTO reports (mandate_id, obligation, attempt_id, result, reason, status, at) VALUES (?, ?, ?, ?, ?, 'PENDING', ?) ON CONFLICT(mandate_id) DO NOTHING").run(
            report.mandate_id,
            key,
            attempt,
            report.result,
            report.reason,
            at,
          );
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    // Imports a bill as read from the accounting system. The first import fixes its money terms; a later read that
    // changes them is recorded as a change for review and never rewrites the payable or any decision already made.
    importBill(key: string, bill: { amount: number; currency: string; vendorId: string; vendorName: string; invoiceNumber: string }, amountCents: number) {
      const at = now();
      const json = JSON.stringify(bill);
      const existing = db.prepare('SELECT bill FROM bills WHERE key = ?').get(key) as { bill: string } | undefined;
      if (!existing) {
        db.prepare("INSERT INTO obligations (key, amount_cents, currency, state, updated_at) VALUES (?, ?, ?, 'OPEN', ?) ON CONFLICT(key) DO NOTHING").run(key, amountCents, bill.currency, at);
        db.prepare('INSERT INTO bills (key, bill, first_seen, last_seen, current) VALUES (?, ?, ?, ?, ?)').run(key, json, at, at, json);
        return 'NEW' as const;
      }
      const before = JSON.parse(existing.bill) as typeof bill;
      // A renamed vendor is a change too: the name is part of what the approver reads.
      const moved = (['amount', 'currency', 'vendorId', 'vendorName', 'invoiceNumber'] as const).filter((f) => before[f] !== bill[f]);
      db.prepare('UPDATE bills SET last_seen = ?, changed = ?, current = ? WHERE key = ?').run(at, moved.length ? JSON.stringify({ fields: moved, now: bill }) : null, json, key);
      return moved.length ? ('CHANGED' as const) : ('UNCHANGED' as const);
    },
    // Bills of one entity only: one entity's queue never shows another's.
    bills: (entity: string) =>
      (
        db.prepare("SELECT b.key, b.bill, b.current, b.first_seen, b.last_seen, b.changed, o.state FROM bills b JOIN obligations o ON o.key = b.key WHERE substr(b.key, 1, length(?) + 1) = ? || '/' ORDER BY b.key").all(entity, entity) as {
          key: string;
          bill: string;
          current: string | null;
          first_seen: string;
          last_seen: string;
          changed: string | null;
          state: ObligationState;
        }[]
      ).map((r) => ({ ...r, bill: JSON.parse(r.bill), current: JSON.parse(r.current ?? r.bill), changed: r.changed ? JSON.parse(r.changed) : null })),
    // A person's verification of who a bill pays, valid only for the bill version and vendor record it was made on.
    addReview: (r: { key: string; billVersion: string; vendorId: string; destination: string; decision: string; by: string; evidence: string }) =>
      void db
        .prepare('INSERT INTO reviews (key, bill_version, vendor_id, destination, decision, by, evidence, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(r.key, r.billVersion, r.vendorId, r.destination, r.decision, r.by, r.evidence, now()),
    reviews: (key: string) =>
      db.prepare('SELECT * FROM reviews WHERE key = ? ORDER BY at, rowid').all(key) as { key: string; bill_version: string; vendor_id: string; destination: string; decision: string; by: string; evidence: string; at: string }[],
    history: (key: string) => db.prepare('SELECT * FROM history WHERE key = ? ORDER BY at, rowid').all(key) as HistoryEntry[],
    pendingReports: () => db.prepare("SELECT * FROM reports WHERE status != 'REPORTED' ORDER BY at").all() as PendingReport[],
    report: (mandateId: string) => db.prepare('SELECT * FROM reports WHERE mandate_id = ?').get(mandateId) as PendingReport | undefined,
    markReport: (mandateId: string, status: string) => void db.prepare('UPDATE reports SET status = ?, at = ? WHERE mandate_id = ?').run(status, now(), mandateId),
    // A mandate pays at most one attempt: its one-time credential and its result belong to that attempt.
    mandateUsed: (mandateId: string) => Boolean(db.prepare("SELECT 1 FROM operations WHERE kind = 'MANDATE' AND external_id = ?").get(mandateId)),
    // Written before each external call and after its answer, and only by the attempt that holds a live reservation:
    // once reconcile has parked or released the obligation, the owner's next write fails before its next side effect,
    // and a crash or lost response leaves exactly this attempt's request ids to reconcile.
    record(attempt: string, op: Omit<Operation, 'at' | 'attempt_id'>) {
      const r = db
        .prepare(
          `INSERT INTO operations (request_id, obligation, attempt_id, rail, kind, external_id, status, detail, at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM obligations WHERE key = ? AND attempt_id = ? AND state = 'RESERVED')
           ON CONFLICT(request_id) DO UPDATE SET external_id = COALESCE(excluded.external_id, external_id), status = excluded.status, detail = excluded.detail, at = excluded.at
           WHERE operations.attempt_id = excluded.attempt_id`,
        )
        .run(op.request_id, op.obligation, attempt, op.rail, op.kind, op.external_id, op.status, op.detail, now(), op.obligation, attempt);
      if (r.changes !== 1) throw new LostOwnership(op.obligation);
    },
    operations: (key: string, attempt?: string) =>
      (attempt
        ? db.prepare('SELECT * FROM operations WHERE obligation = ? AND attempt_id = ? ORDER BY at, rowid').all(key, attempt)
        : db.prepare('SELECT * FROM operations WHERE obligation = ? ORDER BY at, rowid').all(key)) as Operation[],

    // Every card is written down before it is requested, so a crash at any point leaves a list of what to close.
    card(requestId: string, label: string, cardId: string | null, status: string) {
      db.prepare(
        `INSERT INTO cards (request_id, card_id, label, status, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET card_id = COALESCE(excluded.card_id, card_id), status = excluded.status, at = excluded.at`,
      ).run(requestId, cardId, label, status, now());
    },
    openCards: () => db.prepare("SELECT * FROM cards WHERE status != 'CLOSED' ORDER BY at").all() as IssuedCard[],

    setting: (name: string) => (db.prepare('SELECT value FROM settings WHERE name = ?').get(name) as { value: string } | undefined)?.value,
    setSetting(name: string, value: string | null) {
      if (value === null) db.prepare('DELETE FROM settings WHERE name = ?').run(name);
      else db.prepare('INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
    },
    // One account-wide run at a time: a second run would change remote auth under the first.
    lock: (name: string, owner: string) =>
      db.prepare('INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO NOTHING').run(name, owner).changes === 1,
    unlock: (name: string, owner: string) => void db.prepare('DELETE FROM settings WHERE name = ? AND value = ?').run(name, owner),

    // Approvals are insert-only: changed terms produce a new digest and need a new approval.
    saveApproval(terms: ApprovalTerms, approvedBy: string): SavedApproval {
      const digest = approvalDigest(terms);
      db.prepare('INSERT INTO approvals (digest, obligation, terms, approved_by, approved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(digest) DO NOTHING').run(
        digest,
        terms.obligation,
        JSON.stringify(terms),
        approvedBy,
        now(),
      );
      return approval(digest)!;
    },
    latestApproval(key: string): SavedApproval | undefined {
      const row = db.prepare('SELECT digest FROM approvals WHERE obligation = ? ORDER BY approved_at DESC, rowid DESC LIMIT 1').get(key) as { digest: string } | undefined;
      return row ? approval(row.digest) : undefined;
    },
    // Runs fn in one write transaction: either all of it is stored or none of it.
    atomically<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    accounting: (key?: string) =>
      (key ? db.prepare('SELECT * FROM accounting WHERE key = ?').all(key) : db.prepare('SELECT * FROM accounting ORDER BY at').all()) as AccountingRecord[],
    // Compare-and-set on status, so two workers can never both move the same record.
    setAccounting(key: string, from: AccountingStatus, to: AccountingStatus, detail: string | null) {
      return db.prepare('UPDATE accounting SET status = ?, detail = ?, at = ? WHERE key = ? AND status = ?').run(to, detail, now(), key, from).changes === 1;
    },
    close: () => db.close(),
  };
}

export type Ledger = ReturnType<typeof openLedger>;
