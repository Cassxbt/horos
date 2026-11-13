import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessClaim,
  cardControls,
  approvalTerms,
  approvalDigest,
  checkPortal,
  onDecline,
  validMoney,
  type Vendor,
  type Invoice,
  type ApprovalTerms,
} from '../src/policy.ts';

const vendor: Vendor = {
  id: 'VND-0192',
  name: 'Kessler Komponenten GmbH',
  iban: 'DE89370400440532013000',
  portalDomain: 'pay.kessler-komponenten.de',
  merchantDescriptor: 'KESSLER KOMPONENTEN GMBH',
  mcc: '5045',
  currency: 'EUR',
};

const invoice: Invoice = {
  id: 'INV-4417',
  entityId: 'entity-1',
  vendorId: 'VND-0192',
  amount: 4800,
  currency: 'EUR',
  dueDate: '2026-11-20',
};

const policy = { version: 'p1', surchargeCapPct: 3, paymentWindowHours: 72 };
const approvedAt = new Date('2026-11-10T09:30:00Z');

test('a new IBAN in an email holds the wire', () => {
  const r = assessClaim({ vendorName: vendor.name, newIban: 'LT601010012345678901' }, vendor);
  assert.equal(r.holdWire, true);
  assert.ok(r.findings.includes('IBAN_DIFFERS_FROM_VENDOR_MASTER'));
});

test('IBAN comparison ignores spacing and case', () => {
  const r = assessClaim({ vendorName: vendor.name, newIban: 'de89 3704 0044 0532 0130 00' }, vendor);
  assert.equal(r.holdWire, false);
  assert.deepEqual(r.findings, []);
});

test('a bank-change claim with no usable account number still holds the wire', () => {
  for (const newIban of [undefined, '', '   ']) {
    const r = assessClaim({ vendorName: vendor.name, newIban }, vendor);
    assert.equal(r.holdWire, true, JSON.stringify(newIban));
    assert.ok(r.findings.includes('IBAN_MISSING'));
  }
});

test('a claim in another vendor name holds the wire even with the master IBAN', () => {
  const r = assessClaim({ vendorName: 'Kessler Components Ltd', newIban: vendor.iban }, vendor);
  assert.equal(r.holdWire, true);
  assert.deepEqual(r.findings, ['VENDOR_NAME_MISMATCH']);
});

test('vendor name comparison ignores case, spacing and punctuation only', () => {
  const r = assessClaim({ vendorName: 'kessler  komponenten gmbh.', newIban: vendor.iban }, vendor);
  assert.equal(r.holdWire, false);
});

test('card controls refuse an unparseable due date', () => {
  for (const dueDate of ['not-a-date', '2026-13-40', '20261120', '']) {
    assert.throws(() => cardControls({ ...invoice, dueDate }, vendor, policy), /INVALID_DUE_DATE/, dueDate);
  }
});

test('a portal link off the vendor master domain is flagged', () => {
  const r = assessClaim(
    { vendorName: vendor.name, portalUrl: 'https://pay.kessler-komponenten-de.com/inv/4417' },
    vendor,
  );
  assert.ok(r.findings.includes('PORTAL_NOT_IN_VENDOR_MASTER'));
});

test('card controls cap lifetime spend at invoice plus surcharge cap', () => {
  const c = cardControls(invoice, vendor, policy, approvedAt);
  assert.equal(c.allowed_transaction_count, 'SINGLE');
  assert.deepEqual(c.allowed_merchant_categories, ['5045']);
  assert.deepEqual(c.allowed_currencies, ['EUR']);
  assert.equal(c.active_to, '2026-11-13T09:30:00+0000');
  assert.deepEqual(c.transaction_limits, {
    currency: 'EUR',
    limits: [{ amount: 4944, interval: 'ALL_TIME' }],
  });
});

test('the cap rounds down to the cent, never up', () => {
  const c = cardControls({ ...invoice, amount: 1234.57 }, vendor, policy);
  assert.equal(c.transaction_limits.limits[0].amount, 1271.6);
});

test('card controls refuse an invoice in a currency the vendor does not bill in', () => {
  assert.throws(() => cardControls({ ...invoice, currency: 'USD' }, vendor, policy), /CURRENCY_MISMATCH/);
});

test('approval digest changes when any bound term changes', () => {
  const base = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy, approvedAt), policy);
  const d = approvalDigest(base);
  assert.equal(d, approvalDigest({ ...base }));
  for (const change of [
    { amount: 4801 },
    { currency: 'USD' },
    { vendorId: 'VND-0193' },
    { vendorName: 'Kessler Components Ltd' },
    { obligation: 'entity-2/INV-4417' },
    { merchantDescriptor: 'ATTACKER SHOP' },
    { acceptorId: 'MID-1' },
    { mcc: '5999' },
    { expiresAt: '2030-01-01T00:00:00+0000' },
    { policyVersion: 'p2' },
    { contextHash: 'other' },
    { portalDomain: 'pay.kessler-komponenten-de.com' },
    { controls: { ...base.controls, allowed_transaction_count: 'MULTIPLE' } },
  ] as Partial<ApprovalTerms>[]) {
    assert.notEqual(approvalDigest({ ...base, ...change }), d, JSON.stringify(change));
  }
});

test('the approval binds the vendor master as it was: a changed descriptor changes the digest', () => {
  const terms = (v: Vendor) => approvalTerms(invoice, v, cardControls(invoice, v, policy, approvedAt), policy);
  assert.notEqual(approvalDigest(terms({ ...vendor, merchantDescriptor: 'ATTACKER SHOP' })), approvalDigest(terms(vendor)));
  assert.notEqual(approvalDigest(terms({ ...vendor, iban: 'LT601010012345678901' })), approvalDigest(terms(vendor)));
});

test('an invoice that names another vendor is refused, not rebound to this one', () => {
  const other = { ...invoice, vendorId: 'VND-9999' };
  assert.throws(() => cardControls(other, vendor, policy), /INVOICE_VENDOR_MISMATCH/);
  assert.throws(() => approvalTerms(other, vendor, cardControls(invoice, vendor, policy), policy), /INVOICE_VENDOR_MISMATCH/);
});

test('an overdue invoice still gets a card valid for the payment window, not its past due date', () => {
  const c = cardControls({ ...invoice, dueDate: '2026-03-01' }, vendor, policy, approvedAt);
  assert.equal(c.active_to, '2026-11-13T09:30:00+0000');
});

test('card controls refuse an out-of-range policy', () => {
  for (const change of [{ surchargeCapPct: -1 }, { surchargeCapPct: 50 }, { surchargeCapPct: Number.NaN }, { paymentWindowHours: 0 }, { paymentWindowHours: 24 * 365 }]) {
    assert.throws(() => cardControls(invoice, vendor, { ...policy, ...change }), /INVALID_POLICY/, JSON.stringify(change));
  }
});

test('card controls refuse sub-cent amounts and non-cent currencies', () => {
  assert.throws(() => cardControls({ ...invoice, amount: 186.404 }, vendor, policy), /INVALID_AMOUNT/);
  assert.throws(() => cardControls({ ...invoice, currency: 'JPY' }, { ...vendor, currency: 'JPY' }, policy), /INVALID_AMOUNT/);
});

test('approval digest does not depend on key order', () => {
  const base = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy), policy);
  const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
  assert.equal(approvalDigest(reordered), approvalDigest(base));
});

test('checkout is allowed only on the exact vendor master host over https', () => {
  assert.equal(checkPortal('https://pay.kessler-komponenten.de/checkout/INV-4417', vendor).allowed, true);
  for (const url of [
    'https://pay.kessler-komponenten-de.com/checkout/INV-4417',
    'https://pay.kessler-komponenten.de.evil.io/checkout',
    'https://evil.io/pay.kessler-komponenten.de',
    'http://pay.kessler-komponenten.de/checkout',
    'https://pay.kessIer-komponenten.de/checkout',
    'https://pay.kеssler-komponenten.de/checkout',
    'https://pay.kessler-komponenten.de:8443/checkout',
    'https://user:pass@pay.kessler-komponenten.de/checkout',
    'not a url',
  ]) {
    assert.equal(checkPortal(url, vendor).allowed, false, url);
  }
});

test('an over-cap decline closes the card, never retries, and escalates', () => {
  const a = onDecline('LIMIT_EXCEEDED');
  assert.equal(a.closeCard, true);
  assert.equal(a.retry, false);
  assert.equal(a.escalate, true);
  assert.ok(a.options.length >= 2);
});

test('an unknown decline also stops and escalates', () => {
  const a = onDecline('SOMETHING_NEW');
  assert.equal(a.closeCard, true);
  assert.equal(a.retry, false);
  assert.equal(a.escalate, true);
});

test('card controls refuse an invoice amount that is not a positive number', () => {
  for (const amount of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 0.001]) {
    assert.throws(() => cardControls({ ...invoice, amount }, vendor, policy), /INVALID_AMOUNT/, String(amount));
  }
});

test('only supported two-decimal currencies can become a payable', () => {
  assert.equal(validMoney(100, 'USD'), true);
  for (const currency of ['ZZZ', 'JPY', 'XOF', 'usd', '']) assert.equal(validMoney(100, currency), false, currency);
});
