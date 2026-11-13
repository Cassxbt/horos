// Loaded with --import into a script under test. Replaces fetch with an in-process Airwallex sandbox that applies
// card controls, calls the script's own remote-auth endpoint with a signed v2 payload, and keeps a ledger shaped like
// the live one. FAKE_AWX_MODE injects one failure; FAKE_SIGNAL_AT=<path fragment>:<n> sends SIGINT to the script on
// the nth matching call; FAKE_AWX_LATENCY adds real delay per call. Timers are shortened so scripted waits take
// milliseconds. On exit, the ids of cards still ACTIVE are logged. The payment executor also reads T:0, so the fake
// T:0 is loaded first and its calls pass through.
import './fake-t0.mjs';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';

const realFetch = globalThis.fetch;
const realTimeout = globalThis.setTimeout;
// Scripted pauses shrink to 20 ms; bounded waits of 10 s or more keep a tenth, so they still outlast FAKE_SLOW calls.
globalThis.setTimeout = (fn, ms, ...args) => realTimeout(fn, (ms ?? 0) >= 10_000 ? ms / 10 : Math.min(ms ?? 0, 20), ...args);

const mode = process.env.FAKE_AWX_MODE ?? 'ok';
const port = process.env.HOROS_PORT;
const secret = process.env.AWX_REMOTE_AUTH_SECRET ?? '';
const remoteAuth = { enabled: false, url: '', default_action: 'DECLINED', version: 2 };
const cards = new Map();
const txns = [];
const intents = new Map();
const seenRequests = new Map();
let balance = 10_000;
let creates = 0;
let lagged = 0;
const pad = (name) => (name.length >= 25 ? name.slice(0, 25) : name + '_'.repeat(25 - name.length));
const [signalPath, signalAt] = (process.env.FAKE_SIGNAL_AT ?? '').split(':');
let signalCount = 0;
const latency = Number(process.env.FAKE_AWX_LATENCY ?? 0);
// FAKE_SLOW=<path fragment>:<ms> holds matching calls before the fake acts on them, so a call can still be in flight
// when cleanup starts. Calls still pending at exit are logged: the real provider would complete them unseen.
const [slowPath, slowMs] = (process.env.FAKE_SLOW ?? '').split(':');
const storeFile = process.env.FAKE_PA_STORE;
const saveIntent = (intent) => storeFile && appendFileSync(storeFile, JSON.stringify(intent) + '\n');
const storedIntent = (id) =>
  storeFile && existsSync(storeFile)
    ? readFileSync(storeFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((i) => i.id === id).at(-1)
    : undefined;
// The shared store first: another process (pay vs reconcile) may have changed the intent since this one read it.
const intentById = (id) => storedIntent(id) ?? intents.get(id);
// An API error the provider answers with an HTTP status, as opposed to an injected network failure (a thrown Error).
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const pending = new Set();
process.on('exit', () => log({ activeAtExit: [...cards.values()].filter((c) => c.card_status === 'ACTIVE').map((c) => c.card_id), pendingAtExit: [...pending] }));
const log = (entry) => process.env.FAKE_AWX_LOG && appendFileSync(process.env.FAKE_AWX_LOG, JSON.stringify(entry) + '\n');

async function askHoros(card, amount, currency, mcc, merchant, ids, type) {
  const nonce = `${Date.now()}.${randomUUID().slice(0, 8)}`;
  const body = {
    version: 2,
    card_id: card.card_id,
    card_transaction_event_id: randomUUID(),
    card_transaction_id: ids.transaction,
    card_transaction_lifecycle_id: ids.lifecycle,
    transaction_type: type,
    transaction_amount: amount,
    transaction_currency: currency,
    merchant: { id: 'fake-merchant-id', name: pad(merchant), category_code: mcc },
    merchant_id: 'fake-merchant-id',
    acquiring_institution_id: 'fake-acquirer',
  };
  const controller = new AbortController();
  // Airwallex's own window for a remote-auth answer; a shorter one turned a busy test machine into false declines.
  const timer = realTimeout(() => controller.abort(), 2500);
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/remote-auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nonce': nonce, 'x-signature': createHmac('sha256', secret).update(nonce).digest('base64') },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const answer = await res.json();
    return { status: answer.response_status, reason: answer.status_reason, timedOut: false };
  } catch {
    return { status: remoteAuth.default_action, reason: 'TIMEOUT', timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}

function authorize(body) {
  const card = cards.get(body.card_id);
  const ids = { transaction: randomUUID(), lifecycle: randomUUID() };
  const fail = (reason, ra) => {
    txns.push({ transaction_id: randomUUID(), card_id: body.card_id, transaction_type: 'AUTHORIZATION', status: 'FAILED', failure_reason: reason, transaction_amount: -body.transaction_amount, transaction_currency: body.transaction_currency, card_transaction_data: { card_transaction_id: ids.transaction, card_transaction_lifecycle_id: ids.lifecycle }, merchant: { name: pad(body.merchant_info ?? 'AIRPRO'), category_code: body.merchant_category_code }, remote_auth: ra });
    return { card_transaction_id: ids.transaction, card_transaction_lifecycle_id: ids.lifecycle, type: 'AUTHORIZATION', process_result: 'DECLINED', failure_reason: reason };
  };
  return (async () => {
    if (!card || card.card_status !== 'ACTIVE') return fail('CARD_CLOSED');
    // decline-payment: the network declines the invoice payment card (created_by ends in the approval digest).
    if (mode === 'decline-payment' && /:[0-9a-f]{12}$/.test(card.created_by)) return fail('TRANSACTION_BLOCKED');
    const c = card.authorization_controls;
    const limit = c.transaction_limits.limits[0].amount;
    if (!c.allowed_currencies.includes(body.transaction_currency)) return fail('CURRENCY_NOT_ALLOWED');
    if (!c.allowed_merchant_categories.includes(body.merchant_category_code)) return fail('MCC_NOT_ALLOWED');
    if (Math.round((card.spent + body.transaction_amount) * 100) > Math.round(limit * 100)) return fail('LIMIT_EXCEEDED');
    let ra;
    // config-lag: the first two authorizations after enabling skip remote auth, as observed live after a config write.
    // lag-gate / lag-gate-stuck: the first charge on the gate-test card skips remote auth, as seen live once.
    const lagging = (mode === 'config-lag' && ++lagged <= 2) || (mode.startsWith('lag-gate') && /:gate-test$/.test(card.created_by) && ++lagged === 1);
    if (remoteAuth.enabled && !lagging) {
      const answer = await askHoros(card, body.transaction_amount, body.transaction_currency, body.merchant_category_code, body.merchant_info ?? 'AIRPRO', ids, body.single_phase ? 'CLEARING' : 'AUTHORIZATION');
      ra = { response_status: answer.status, status_reason: answer.reason, default_action_used: answer.timedOut, timed_out: answer.timedOut, duration: 1 };
      if (answer.status !== 'AUTHORIZED') return fail('REMOTE_AUTH_DECLINED', ra);
    }
    card.spent += body.transaction_amount;
    if (body.single_phase) {
      balance = Math.round((balance - body.transaction_amount) * 100) / 100;
      if (c.allowed_transaction_count === 'SINGLE') card.card_status = 'CLOSED';
    }
    txns.push({ transaction_id: randomUUID(), card_id: body.card_id, transaction_type: body.single_phase ? 'CLEARING' : 'AUTHORIZATION', status: body.single_phase ? 'APPROVED' : 'PENDING', transaction_amount: -body.transaction_amount, transaction_currency: body.transaction_currency, card_transaction_data: { card_transaction_id: ids.transaction, card_transaction_lifecycle_id: ids.lifecycle }, merchant: { name: pad(body.merchant_info ?? 'AIRPRO'), category_code: body.merchant_category_code, identifier: 'fake-merchant-id' }, remote_auth: ra });
    return { card_transaction_id: ids.transaction, card_transaction_lifecycle_id: ids.lifecycle, type: 'AUTHORIZATION', process_result: 'APPROVED' };
  })();
}

const hang = () => new Promise(() => {});

async function route(method, path, query, body) {
  if (path.endsWith('/authentication/login')) return { token: 'fake-token' };
  if (path === '/api/v1/issuing/config') return { remote_auth_settings: { ...remoteAuth } };
  if (path === '/api/v1/issuing/config/update') {
    if (mode === 'config-update-fails' && body.remote_auth.enabled === false) throw new Error('injected config update failure');
    Object.assign(remoteAuth, body.remote_auth);
    return { remote_auth_settings: { ...remoteAuth } };
  }
  // FAKE_AWX_ACCOUNT names the account these fake credentials act for.
  if (path === '/api/v1/account') return { id: process.env.FAKE_AWX_ACCOUNT ?? 'acct_fake_A', status: 'ACTIVE', account_details: { business_details: { business_name: 'Fake Sandbox Business' } } };
  if (path === '/api/v1/issuing/cardholders') {
    if (mode === 'cardholder-fails') throw new ApiError(503, 'service_unavailable', 'injected cardholder lookup failure');
    return { items: [{ cardholder_id: 'holder-1', status: 'READY' }] };
  }
  if (path === '/api/v1/balances/current') return [{ currency: 'USD', available_amount: balance, total_amount: balance }];
  if (path === '/api/v1/issuing/cards/create') {
    // Live: a repeated request_id is refused with 400 invalid_argument; it never returns the original card.
    if (seenRequests.has(body.request_id)) throw new ApiError(400, 'invalid_argument', 'The provided ID is already associated with a previous request');
    const card = { card_id: `card-${++creates}`, card_status: 'ACTIVE', cardholder_id: body.cardholder_id, created_by: body.created_by, nick_name: body.nick_name, authorization_controls: body.authorization_controls, created_at: new Date().toISOString(), spent: 0 };
    cards.set(card.card_id, card);
    seenRequests.set(body.request_id, card);
    if (mode === 'lost-create' && creates === 1) throw new Error('injected lost create response');
    return card;
  }
  if (path === '/api/v1/issuing/cards' && method === 'GET') {
    const from = Date.parse(query.get('from_created_at') ?? '1970-01-01');
    const nick = query.get('nick_name');
    return {
      has_more: false,
      items: [...cards.values()].filter((c) => c.card_status === (query.get('card_status') ?? c.card_status) && Date.parse(c.created_at) >= from && (!nick || c.nick_name === nick)),
    };
  }
  let m = path.match(/^\/api\/v1\/issuing\/cards\/([^/]+)\/update$/);
  if (m) {
    if (mode === 'close-fails') throw new Error('injected close failure');
    const card = cards.get(m[1]);
    card.card_status = body.card_status;
    return card;
  }
  m = path.match(/^\/api\/v1\/issuing\/cards\/([^/]+)$/);
  if (m) {
    if (!cards.has(m[1])) throw new ApiError(404, 'not_found', 'card not found');
    return cards.get(m[1]);
  }
  if (path === '/api/v1/simulation/issuing/create') return authorize(body);
  m = path.match(/card_transaction_lifecycles\/([^/]+)\/capture$/);
  if (m) {
    if (mode === 'capture-throws') throw new Error('injected capture failure');
    if (mode === 'capture-hangs') return hang();
    const auth = txns.find((t) => t.card_transaction_data.card_transaction_lifecycle_id === m[1] && t.status === 'PENDING');
    if (mode === 'declined-capture' || !auth) return { card_transaction_id: 'capture', type: 'CLEARING', process_result: 'DECLINED' };
    const amount = body.transaction_amount ?? -auth.transaction_amount;
    Object.assign(auth, { transaction_type: 'CLEARING', status: 'APPROVED', transaction_amount: -amount, remote_auth: undefined, transaction_id: randomUUID() });
    balance = Math.round((balance - amount) * 100) / 100;
    const card = cards.get(auth.card_id);
    if (card.authorization_controls.allowed_transaction_count === 'SINGLE') card.card_status = 'CLOSED';
    return { card_transaction_id: auth.card_transaction_data.card_transaction_id, type: 'CLEARING', process_result: 'APPROVED' };
  }
  m = path.match(/card_transaction_lifecycles\/([^/]+)\/reverse$/);
  if (m && mode === 'lag-gate-stuck') return { card_transaction_id: 'reversal', type: 'REVERSAL_AUTH', process_result: 'DECLINED' };
  if (m) {
    const auth = txns.find((t) => t.card_transaction_data.card_transaction_lifecycle_id === m[1] && t.status === 'PENDING');
    if (auth) {
      auth.status = 'REVERSED';
      cards.get(auth.card_id).spent += auth.transaction_amount;
    }
    return { card_transaction_id: 'reversal', type: 'REVERSAL_AUTH', process_result: auth ? 'APPROVED' : 'DECLINED' };
  }
  if (path === '/api/v1/issuing/transactions') {
    // FAKE_PAGE_SIZE forces small pages so the paging loop is exercised.
    const size = Number(process.env.FAKE_PAGE_SIZE ?? query.get('page_size') ?? 100);
    const page = Number(query.get('page_num') ?? 0);
    const all = txns.filter((t) => t.card_id === query.get('card_id'));
    return { has_more: (page + 1) * size < all.length, items: all.slice(page * size, (page + 1) * size) };
  }
  if (path === '/api/v1/pa/payment_intents/create') {
    const intent = { id: `int_${randomUUID().slice(0, 8)}`, status: 'REQUIRES_PAYMENT_METHOD', amount: body.amount, currency: body.currency, merchant_order_id: body.merchant_order_id };
    intents.set(intent.id, intent);
    saveIntent(intent);
    return intent;
  }
  m = path.match(/payment_intents\/([^/]+)\/confirm$/);
  if (m) {
    const intent = intentById(m[1]);
    if (intent.status === 'CANCELLED') throw new ApiError(400, 'invalid_status_for_operation', `The PaymentIntent status CANCELLED is invalid for operation confirm.`);
    // confirm-http-decline: the issuer declines and Airwallex answers with HTTP 400; the intent stays confirmable.
    if (mode === 'confirm-http-decline') {
      intent.latest_payment_attempt = { id: 'att_1', status: 'FAILED' };
      saveIntent(intent);
      throw new ApiError(400, 'issuer_declined', 'The card issuer declined this payment.');
    }
    // confirm-retryable: the card is refused and the intent waits for another payment method (still confirmable).
    if (mode === 'confirm-retryable') {
      intent.latest_payment_attempt = { id: 'att_1', status: 'FAILED' };
      saveIntent(intent);
      return { ...intent };
    }
    intent.status = 'SUCCEEDED';
    if (mode === 'charged-other-amount') intent.amount = 1;
    intent.latest_payment_attempt = { id: 'att_1', status: 'SETTLED' };
    intents.set(intent.id, intent);
    saveIntent(intent);
    // confirm-response-amount: the provider charged the approved amount but its confirm response says otherwise.
    if (mode === 'confirm-response-amount') return { ...intent, amount: 1 };
    if (mode === 'confirm-lost' || mode === 'provider-down-after-confirm') throw new Error('injected lost confirm response after payment');
    if (mode === 'kill-after-confirm') process.kill(process.pid, 'SIGKILL');
    // steal-after-confirm: a concurrent reconcile settles the obligation while this process is still confirming.
    // It runs the real reconciler against the same ledger file, as a second process would.
    if (mode === 'steal-after-confirm') {
      const { openLedger } = await import('../../src/ledger.ts');
      const { settle } = await import('../../src/settle.ts');
      const ledger = openLedger(process.env.HOROS_DB ?? 'data/horos.db');
      for (const o of ledger.unsettled()) await settle(ledger, o.key, Date.now() + 10 * 60_000);
      ledger.close();
    }
    return intent;
  }
  m = path.match(/payment_intents\/([^/]+)\/cancel$/);
  if (m && mode === 'provider-down-after-confirm') throw new Error('injected: provider unreachable');
  if (m) {
    const intent = intentById(m[1]);
    if (intent.status === 'SUCCEEDED' || intent.status === 'CANCELLED') throw new ApiError(400, 'invalid_status_for_operation', `The PaymentIntent status ${intent.status} is invalid for operation cancel.`);
    intent.status = 'CANCELLED';
    intents.set(intent.id, intent);
    saveIntent(intent);
    return intent;
  }
  m = path.match(/payment_intents\/([^/]+)$/);
  if (m && mode === 'provider-down-after-confirm' && intentById(m[1])?.status === 'SUCCEEDED') throw new Error('injected: provider unreachable');
  // kill-on-readback: the process dies after the confirmation was journaled, before the outcome is committed.
  if (m && mode === 'kill-on-readback' && intentById(m[1])?.status === 'SUCCEEDED') process.kill(process.pid, 'SIGKILL');
  if (m && intentById(m[1])) return intentById(m[1]);
  throw new Error(`fake airwallex: unexpected ${method} ${path}`);
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'api.t0.ai') return realFetch(url, opts);
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  log({ method, path: u.pathname, body });
  if (signalPath && u.pathname.includes(signalPath) && ++signalCount === Number(signalAt)) process.kill(process.pid, 'SIGINT');
  if (latency) await new Promise((r) => realTimeout(r, latency));
  // The provider is still working on a slow call; a script that exits now leaves it to finish after the sweep.
  pending.add(u.pathname);
  if (slowPath && u.pathname.includes(slowPath)) await new Promise((r) => realTimeout(r, Number(slowMs)));
  let data;
  try {
    data = await route(method, u.pathname, u.searchParams, body);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return new Response(JSON.stringify({ code: e.code, message: e.message }), { status: e.status });
  } finally {
    pending.delete(u.pathname);
  }
  return new Response(JSON.stringify(data), { status: 200 });
};
