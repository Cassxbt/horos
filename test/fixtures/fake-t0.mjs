// Loaded with --import: a fake T:0. GET /v1/vendor-bills serves FAKE_T0_PAGE (FAKE_T0_FAIL makes it fail). Reads are
// counted per process, so a test can change the source at a chosen point of a payment: FAKE_T0_PAGE_FROM=<n>:<file>
// serves that file from the nth read on, FAKE_T0_FAIL_FROM=<n> fails every read from the nth on, and
// FAKE_T0_SLOW_FROM=<n>:<ms> makes each read from the nth on take <ms>: the process clock moves on by that much, so
// a test can reach an expiry hours away without waiting for it.
// POST /v1/records and GET /v1/payments keep records in FAKE_T0_STORE, shared across processes, following T:0's
// documented contract: an identical resubmission is a duplicate, and a record is readable only after "processing".
// FAKE_T0_MODE injects: lose-ack (stored, then the response is lost), reject (422), busy (409), not-yet-visible
// (accepted but not yet readable), mismatch (read back with another amount), malformed (read back with no data),
// ack-empty and ack-zero (a 202 whose counters do not account for the record).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const real = globalThis.fetch;
const mode = process.env.FAKE_T0_MODE ?? '';
const store = process.env.FAKE_T0_STORE;
const load = () => (store && existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { records: {}, posts: 0, duplicates: 0 });
const keep = (s) => store && writeFileSync(store, JSON.stringify(s));
const [laterFrom, laterPage] = (process.env.FAKE_T0_PAGE_FROM ?? '').split(':');
const [slowFrom, slowMs] = (process.env.FAKE_T0_SLOW_FROM ?? '').split(':');
let reads = 0;
let elapsed = 0;
if (slowFrom) {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [RealDate.now() + elapsed]));
    }
    static now() {
      return RealDate.now() + elapsed;
    }
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname !== 'api.t0.ai') return real(url, opts);
  if (u.pathname === '/v1/vendor-bills') {
    reads++;
    if (slowFrom && reads >= Number(slowFrom)) elapsed += Number(slowMs);
    if (process.env.FAKE_T0_FAIL || (process.env.FAKE_T0_FAIL_FROM && reads >= Number(process.env.FAKE_T0_FAIL_FROM))) throw new Error('injected T:0 network failure');
    const page = laterPage && reads >= Number(laterFrom) ? laterPage : process.env.FAKE_T0_PAGE;
    return Response.json(JSON.parse(readFileSync(page, 'utf8')));
  }
  if (u.pathname === '/v1/records' && opts.method === 'POST') {
    if (mode === 'reject') return Response.json({ detail: 'injected: record refused' }, { status: 422 });
    if (mode === 'busy') return Response.json({ detail: 'CAPI36' }, { status: 409 });
    if (mode === 'ack-empty') return Response.json({}, { status: 202 });
    if (mode === 'ack-zero') return Response.json({ received: 0, inserted: 0, duplicates: 0 }, { status: 202 });
    const s = load();
    s.posts++;
    let inserted = 0;
    let duplicates = 0;
    for (const r of JSON.parse(opts.body)) {
      const prior = s.records[r.id.externalId];
      if (prior && JSON.stringify(prior) === JSON.stringify(r)) duplicates++;
      else (s.records[r.id.externalId] = r), inserted++;
    }
    s.duplicates += duplicates;
    keep(s);
    if (mode === 'lose-ack') throw new Error('injected: T:0 stored the record but the response was lost');
    return Response.json({ received: inserted + duplicates, inserted, duplicates }, { status: 202 });
  }
  if (u.pathname === '/v1/payments') {
    const r = load().records[u.searchParams.get('platform_object_ids')];
    if (!r || mode === 'not-yet-visible') return Response.json({ data: [], next_cursor: null });
    if (mode === 'malformed') return Response.json({ data: [{ id: r.id, links: r.links }], next_cursor: null });
    const data = mode === 'mismatch' ? { ...r.data, amount: r.data.amount + 1 } : r.data;
    return Response.json({ data: [{ id: r.id, data, links: r.links }], next_cursor: null });
  }
  throw new Error(`fake T:0: unexpected ${opts.method ?? 'GET'} ${u.pathname}`);
};
