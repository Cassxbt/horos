import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalDigest, approvalTerms, cardControls } from '../src/policy.ts';
import { checkMandate, type AiriMandate } from '../src/vic.ts';
import { invoice, policy, vendor } from '../src/demo-data.ts';

const now = new Date('2026-11-10T12:00:00Z');
const terms = approvalTerms(invoice, vendor, cardControls(invoice, vendor, policy, now), policy);
const digest = approvalDigest(terms);

// Shaped like the saved live mandate mdt_nlpdhwf6cho13dzi0y0.
const mandate = (over: Partial<AiriMandate> = {}): AiriMandate => ({
  mandateId: 'mdt_1',
  status: 'READY',
  protocolType: 'VIC',
  expiresAt: '2026-11-10T12:15:00Z',
  merchantInfo: { name: 'Tessaline Systems Inc.', url: 'https://pay.tessaline.example', country: 'US' },
  orderInfo: { currency: 'USD', totalAmount: '186.40', description: `Pay invoice INV-4417 to vendor VND-0192. Approval digest ${digest.slice(0, 12)}` },
  ...over,
});

test('a mandate that matches the saved approval passes', () => {
  assert.deepEqual(checkMandate(mandate(), terms, digest, now), { ok: true, findings: [] });
});

test('each mismatch between the passkey-approved mandate and the AP approval is refused', () => {
  const cases: [Partial<AiriMandate>, string][] = [
    [{ status: 'COMPLETED' }, 'MANDATE_STATUS_COMPLETED'],
    [{ protocolType: 'TAP' }, 'NOT_VIC'],
    [{ expiresAt: '2026-11-10T11:59:00Z' }, 'MANDATE_EXPIRED'],
    [{ merchantInfo: { name: 'Tessaline', url: 'https://pay.tessaline-billing.example' } }, 'MERCHANT_URL_NOT_APPROVED_PORTAL'],
    [{ merchantInfo: { name: 'Tessaline', url: 'http://pay.tessaline.example' } }, 'MERCHANT_URL_NOT_APPROVED_PORTAL'],
    [{ orderInfo: { ...mandate().orderInfo, totalAmount: '186.41' } }, 'AMOUNT_MISMATCH'],
    [{ orderInfo: { ...mandate().orderInfo, totalAmount: 'abc' } }, 'AMOUNT_MISMATCH'],
    [{ orderInfo: { ...mandate().orderInfo, totalAmount: '186.404' } }, 'AMOUNT_MISMATCH'],
    [{ orderInfo: { ...mandate().orderInfo, totalAmount: '1.864e2' } }, 'AMOUNT_MISMATCH'],
    [{ orderInfo: { ...mandate().orderInfo, totalAmount: ' 186.40' } }, 'AMOUNT_MISMATCH'],
    [{ orderInfo: { ...mandate().orderInfo, currency: 'EUR' } }, 'CURRENCY_MISMATCH'],
    [{ merchantInfo: { name: 'Another Merchant LLC', url: 'https://pay.tessaline.example' } }, 'MERCHANT_NAME_NOT_APPROVED_SUPPLIER'],
    [{ orderInfo: { ...mandate().orderInfo, description: 'Pay invoice INV-4417' } }, 'APPROVAL_DIGEST_NOT_IN_MANDATE'],
  ];
  for (const [over, finding] of cases) {
    const r = checkMandate(mandate(over), terms, digest, now);
    assert.equal(r.ok, false, finding);
    assert.ok(r.findings.includes(finding), `${finding}: ${r.findings}`);
  }
});

test('a mandate is refused once the AP approval window has passed, even if the mandate is fresh', () => {
  const later = new Date('2026-12-10T12:00:00Z');
  const r = checkMandate(mandate({ expiresAt: '2026-12-10T12:15:00Z' }), terms, digest, later);
  assert.deepEqual(r.findings, ['APPROVAL_EXPIRED']);
});

test('"186.4" and "186.40" are the same approved amount', () => {
  assert.equal(checkMandate(mandate({ orderInfo: { ...mandate().orderInfo, totalAmount: '186.4' } }), terms, digest, now).ok, true);
});

test('no mandate found means no payment', () => {
  assert.deepEqual(checkMandate(undefined, terms, digest, now), { ok: false, findings: ['MANDATE_NOT_FOUND'] });
});
