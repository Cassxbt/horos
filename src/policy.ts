import { createHash } from 'node:crypto';

export type Vendor = {
  id: string;
  name: string;
  iban: string;
  portalDomain: string;
  merchantDescriptor: string;
  // The acquirer's merchant identifier for this supplier, only when it comes from a verified onboarding source.
  acceptorId?: string;
  mcc: string;
  currency: string;
};

export type Invoice = {
  id: string;
  entityId: string;
  vendorId: string;
  amount: number;
  currency: string;
  dueDate: string;
};

export type BankChangeClaim = {
  vendorName: string;
  newIban?: string;
  portalUrl?: string;
};

export type Policy = { version: string; surchargeCapPct: number; paymentWindowHours: number };

export type CardControls = {
  allowed_transaction_count: 'SINGLE' | 'MULTIPLE';
  allowed_merchant_categories: string[];
  allowed_currencies: string[];
  active_to: string;
  transaction_limits: { currency: string; limits: { amount: number; interval: 'ALL_TIME' }[] };
};

// Everything the gate enforces is in here, so changing any of it changes the digest the approver signed.
export type ApprovalTerms = {
  obligation: string;
  invoiceId: string;
  vendorId: string;
  vendorName: string;
  amount: number;
  currency: string;
  merchantDescriptor: string;
  acceptorId: string | null;
  mcc: string;
  portalDomain: string;
  expiresAt: string;
  policyVersion: string;
  // The version of the source bill the approver saw; null for an invoice not imported from accounting.
  sourceVersion: string | null;
  // The verification this approval rests on, the exact checkout address it names, and the Airwallex account that will
  // take the payment. Replacing any of them needs a fresh approval.
  verificationId: string | null;
  destination: string | null;
  paymentAccount: string | null;
  contextHash: string;
  controls: CardControls;
};

const normalizeIban = (iban: string) => iban.replace(/\s+/g, '').toUpperCase();

export const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const WIRE_HOLD_FINDINGS = ['VENDOR_NAME_MISMATCH', 'IBAN_MISSING', 'IBAN_DIFFERS_FROM_VENDOR_MASTER'];

// A bank-change claim releases the wire only when it names the vendor on file and repeats the account on file.
export function assessClaim(claim: BankChangeClaim, vendor: Vendor) {
  const findings: string[] = [];
  if (normalizeName(claim.vendorName ?? '') !== normalizeName(vendor.name)) findings.push('VENDOR_NAME_MISMATCH');
  const iban = normalizeIban(claim.newIban ?? '');
  if (!iban) findings.push('IBAN_MISSING');
  else if (iban !== normalizeIban(vendor.iban)) findings.push('IBAN_DIFFERS_FROM_VENDOR_MASTER');
  if (claim.portalUrl && !checkPortal(claim.portalUrl, vendor).allowed) {
    findings.push('PORTAL_NOT_IN_VENDOR_MASTER');
  }
  return { holdWire: findings.some((f) => WIRE_HOLD_FINDINGS.includes(f)), findings };
}

function validDueDate(dueDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false;
  const parsed = new Date(`${dueDate}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(dueDate);
}

// Two-decimal currencies the Airwallex issuing simulator accepts (its list, minus JPY). Anything else, including a
// syntactically valid placeholder such as ZZZ, cannot become a payable.
export const SUPPORTED_CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'AUD', 'CAD', 'HKD', 'SGD', 'NZD', 'CHF', 'CNY']);

export const toCents = (amount: number) => Math.round(amount * 100);

export function validMoney(amount: number, currency: string) {
  return (
    typeof amount === 'number' &&
    Number.isFinite(amount) &&
    toCents(amount) > 0 &&
    Math.abs(toCents(amount) - amount * 100) < 1e-6 &&
    SUPPORTED_CURRENCIES.has(currency)
  );
}

// The accounting identity of a payable: the entity and the bill's own id. The vendor is a link on the bill, not part of
// its identity, so re-linking a bill in the accounting system can never create a second payable for it.
export const obligationKey = (invoice: Invoice) => `${invoice.entityId}/${invoice.id}`;

// Airwallex takes card expiry as yyyy-MM-ddTHH:mm:ss+0000.
const networkTime = (d: Date) => `${d.toISOString().slice(0, 19)}+0000`;

export function cardControls(invoice: Invoice, vendor: Vendor, policy: Policy, approvedAt = new Date()): CardControls {
  if (invoice.vendorId !== vendor.id) throw new Error('INVOICE_VENDOR_MISMATCH');
  if (invoice.currency !== vendor.currency) throw new Error('CURRENCY_MISMATCH');
  if (!validDueDate(invoice.dueDate)) throw new Error('INVALID_DUE_DATE');
  if (!validMoney(invoice.amount, invoice.currency)) throw new Error('INVALID_AMOUNT');
  const { surchargeCapPct, paymentWindowHours } = policy;
  if (!Number.isFinite(surchargeCapPct) || surchargeCapPct < 0 || surchargeCapPct > 10) throw new Error('INVALID_POLICY');
  if (!Number.isFinite(paymentWindowHours) || paymentWindowHours <= 0 || paymentWindowHours > 24 * 14) throw new Error('INVALID_POLICY');
  // Integer cents so the cap can never round above what the approver saw.
  const cents = toCents(invoice.amount);
  const capCents = Math.floor((cents * (100 + surchargeCapPct)) / 100);
  // A fresh window from approval, not the due date: an overdue bill must still get a card that works.
  const expires = new Date(approvedAt.getTime() + paymentWindowHours * 3_600_000);
  return {
    allowed_transaction_count: 'SINGLE',
    allowed_merchant_categories: [vendor.mcc],
    allowed_currencies: [invoice.currency],
    active_to: networkTime(expires),
    transaction_limits: {
      currency: invoice.currency,
      limits: [{ amount: capCents / 100, interval: 'ALL_TIME' }],
    },
  };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

export type ApprovalBasis = { sourceVersion: string | null; verificationId: string | null; destination: string | null; paymentAccount: string | null };
const NO_BASIS: ApprovalBasis = { sourceVersion: null, verificationId: null, destination: null, paymentAccount: null };

export function approvalTerms(invoice: Invoice, vendor: Vendor, controls: CardControls, policy: Policy, basis: ApprovalBasis = NO_BASIS): ApprovalTerms {
  if (invoice.vendorId !== vendor.id) throw new Error('INVOICE_VENDOR_MISMATCH');
  return {
    obligation: obligationKey(invoice),
    invoiceId: invoice.id,
    vendorId: vendor.id,
    vendorName: vendor.name,
    amount: invoice.amount,
    currency: invoice.currency,
    merchantDescriptor: vendor.merchantDescriptor,
    acceptorId: vendor.acceptorId ?? null,
    mcc: vendor.mcc,
    portalDomain: vendor.portalDomain,
    expiresAt: controls.active_to,
    policyVersion: policy.version,
    ...basis,
    contextHash: sha256({ invoice, vendor }),
    controls,
  };
}

export const approvalDigest = (terms: ApprovalTerms) => sha256(terms);

export function checkPortal(url: string, vendor: Pick<Vendor, 'portalDomain'>) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'INVALID_URL' };
  }
  if (parsed.protocol !== 'https:') return { allowed: false, reason: 'NOT_HTTPS' };
  if (parsed.username || parsed.password || parsed.port) return { allowed: false, reason: 'UNEXPECTED_CREDENTIALS_OR_PORT' };
  if (parsed.hostname !== vendor.portalDomain) return { allowed: false, reason: 'HOST_NOT_IN_VENDOR_MASTER' };
  return { allowed: true, reason: 'HOST_MATCHES_VENDOR_MASTER' };
}

export function onDecline(reason: string) {
  // Any decline ends this card: a retry on a single-invoice card can only mean paying terms nobody approved.
  const options =
    reason === 'LIMIT_EXCEEDED'
      ? ['Ask the supplier to waive the surcharge', 'Approve a new card at the higher amount', 'Pay by wire to the account on the vendor master']
      : ['Review the decline with the supplier', 'Pay by wire to the account on the vendor master'];
  return { closeCard: true, retry: false, escalate: true, reason, options };
}
