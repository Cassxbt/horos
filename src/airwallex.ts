import { randomUUID } from 'node:crypto';
import type { CardControls } from './policy.ts';
import type { LedgerTransaction } from './reconcile.ts';

const BASE = process.env.AWX_BASE_URL ?? 'https://api-demo.airwallex.com';
// Every call is bounded, so a silent service cannot hold a cleanup or a recovery open indefinitely.
const REQUEST_TIMEOUT_MS = 20_000;

export class AirwallexError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, path: string) {
    super(`Airwallex ${status} on ${path}: ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

let session: { token: string; expiresAt: number } | undefined;

async function token() {
  if (session && session.expiresAt > Date.now()) return session.token;
  const res = await fetch(`${BASE}/api/v1/authentication/login`, {
    method: 'POST',
    headers: { 'x-client-id': must('AWX_CLIENT_ID'), 'x-api-key': must('AWX_API_KEY') },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok) throw new AirwallexError(res.status, body, '/authentication/login');
  // Tokens live 30 minutes; refresh early so a long demo never hits an expiry mid-payment.
  session = { token: body.token, expiresAt: Date.now() + 25 * 60_000 };
  return session.token;
}

function must(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new AirwallexError(res.status, json, path);
  return json as T;
}

export type Card = { card_id: string; card_status: string; authorization_controls: CardControls };

export type SimulatedTransaction = {
  card_transaction_id: string;
  card_transaction_lifecycle_id: string;
  type: string;
  process_result: 'APPROVED' | 'DECLINED';
  failure_reason?: string;
};

export type Balance = { currency: string; available_amount: number; total_amount: number };

// The account the credentials in use act for: the merchant that will receive a checkout this process creates.
// The account a checkout pays into, as the provider reports it. An approval binds to its id, so a missing, blank or
// malformed id is refused here, before anything can be previewed or approved against it.
export const currentAccount = async () => {
  const a = await call<{ id?: unknown; account_details?: { business_details?: { business_name?: string } }; nickname?: string }>('GET', '/account');
  if (typeof a.id !== 'string' || !/^acct_[A-Za-z0-9_-]+$/.test(a.id)) throw new Error('ACCOUNT_IDENTITY_INVALID: Airwallex did not return a usable account id');
  return { id: a.id, name: a.account_details?.business_details?.business_name ?? a.nickname ?? '' };
};

export const firstReadyCardholder = async () => {
  const { items } = await call<{ items: { cardholder_id: string; status: string }[] }>('GET', '/issuing/cardholders');
  const holder = items.find((h) => h.status === 'READY');
  if (!holder) throw new Error('No READY cardholder on this account');
  return holder.cardholder_id;
};

// The card list can be filtered by nick name but never shows request_id, so the nick name carries the request id:
// a create whose response was lost can be found exactly, without sweeping other cards. A repeated request_id is
// refused with 400 invalid_argument (checked live), so replaying a create never returns the original card.
export const nickNameFor = (requestId: string) => `horos-${requestId}`;

export const cardsByNickName = async (nickName: string) =>
  (await call<{ items: { card_id: string; card_status: string }[] }>('GET', `/issuing/cards?nick_name=${encodeURIComponent(nickName)}&page_size=10`)).items;

export const issueCard = (cardholderId: string, controls: CardControls, createdBy: string, requestId: string) =>
  call<Card>('POST', '/issuing/cards/create', {
    request_id: requestId,
    cardholder_id: cardholderId,
    created_by: createdBy,
    nick_name: nickNameFor(requestId),
    form_factor: 'VIRTUAL',
    is_personalized: true,
    program: { purpose: 'COMMERCIAL' },
    authorization_controls: controls,
  });

export const getCard = (cardId: string) => call<Card>('GET', `/issuing/cards/${cardId}`);

// One page only: used for the read-only health check, which reports the count as at most 200.
export const activeCards = async () =>
  (await call<{ items: { card_id: string }[]; has_more: boolean }>('GET', '/issuing/cards?card_status=ACTIVE&page_size=200'));

export const closeCard = (cardId: string) =>
  call<Card>('POST', `/issuing/cards/${cardId}/update`, { card_status: 'CLOSED' });

// Sandbox stand-in for the supplier's card terminal. merchant_info must be omitted or a string: an object returns 400.
// single_phase sends one message that authorizes and clears together, which is judged by remote auth as a CLEARING.
export const simulateAuthorization = (
  cardId: string,
  charge: { amount: number; currency: string; mcc: string; merchantInfo: string; singlePhase?: boolean },
) =>
  call<SimulatedTransaction>('POST', '/simulation/issuing/create', {
    card_id: cardId,
    transaction_amount: charge.amount,
    transaction_currency: charge.currency,
    merchant_category_code: charge.mcc,
    merchant_info: charge.merchantInfo,
    ...(charge.singlePhase ? { single_phase: true } : {}),
  });

// The builder guide's /simulation/issuing/{id}/capture path returns 400 on this API version.
// Without merchant_info the simulator books the clearing under a generic "AIRPRO_TX_GENERATOR" merchant.
// transaction_amount below the authorization is a documented partial capture. Above it is undocumented, but the
// sandbox cleared it and debited the wallet when tried live on Nov 10.
export const simulateCapture = (lifecycleId: string, merchantInfo?: string, amount?: number) =>
  call<SimulatedTransaction>('POST', `/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/capture`, {
    ...(merchantInfo ? { merchant_info: merchantInfo } : {}),
    ...(amount === undefined ? {} : { transaction_amount: amount }),
  });

// Closing a card does not release a pending authorization; reversing it does.
export const simulateReversal = (lifecycleId: string) =>
  call<SimulatedTransaction>('POST', `/simulation/issuing/card_transaction_lifecycles/${lifecycleId}/reverse`, {});

export const balance = async (currency: string) => {
  const all = await call<Balance[]>('GET', '/balances/current');
  const found = all.find((b) => b.currency === currency);
  if (!found) throw new Error(`No ${currency} balance`);
  return found;
};

export type RemoteAuthSettings = {
  enabled: boolean;
  url?: string;
  default_action?: 'AUTHORIZED' | 'DECLINED';
  version?: number;
  shared_secret?: string;
};

export const issuingConfig = () =>
  call<{ remote_auth_settings?: RemoteAuthSettings; remote_auth?: RemoteAuthSettings }>('GET', '/issuing/config');

// The shared secret comes back only when a new one is requested, so callers must save it immediately.
export const updateRemoteAuth = (settings: RemoteAuthSettings & { new_shared_secret?: boolean }) =>
  call<{ remote_auth_settings?: RemoteAuthSettings; remote_auth?: RemoteAuthSettings }>('POST', '/issuing/config/update', {
    remote_auth: { version: 2, ...settings },
  });

export type PaymentIntent = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  merchant_order_id: string;
  latest_payment_attempt?: { id: string; status: string; payment_method?: { card?: { brand?: string; last4?: string } } };
};

export type CardDetails = { number: string; expiry_month: string; expiry_year: string; cvc: string; name: string };

export const createPaymentIntent = (amount: number, currency: string, merchantOrderId: string, requestId: string) =>
  call<PaymentIntent>('POST', '/pa/payment_intents/create', {
    request_id: requestId,
    amount,
    currency,
    merchant_order_id: merchantOrderId,
  });

export const confirmPaymentIntent = (intentId: string, card: CardDetails, requestId: string) =>
  call<PaymentIntent>('POST', `/pa/payment_intents/${intentId}/confirm`, {
    request_id: requestId,
    payment_method: { type: 'card', card },
    payment_method_options: { card: { auto_capture: true } },
  });

// Cancelling an unconfirmed intent means a confirm still in flight can no longer charge it. Airwallex refuses to
// cancel an intent that is already cancelled (invalid_status_for_operation), which is checked live.
export const cancelPaymentIntent = (intentId: string, reason: string) =>
  call<PaymentIntent>('POST', `/pa/payment_intents/${intentId}/cancel`, { request_id: randomUUID(), cancellation_reason: reason });

export const getPaymentIntent = (intentId: string) => call<PaymentIntent>('GET', `/pa/payment_intents/${intentId}`);

// Every page: a reconciliation that saw only the first page could take a partial history for the whole one.
export async function cardTransactions(cardId: string) {
  const items: LedgerTransaction[] = [];
  for (let page = 0; ; page++) {
    const r = await call<{ items: LedgerTransaction[]; has_more: boolean }>('GET', `/issuing/transactions?card_id=${cardId}&page_num=${page}&page_size=100`);
    items.push(...r.items);
    if (!r.has_more) return { items };
    if (page > 50) throw new Error('TRANSACTION_HISTORY_TOO_LONG');
  }
}
