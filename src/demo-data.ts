import type { Invoice, Policy, Vendor } from './policy.ts';

export const vendor: Vendor = {
  id: 'VND-0192',
  name: 'Tessaline Systems Inc.',
  iban: 'US-ACH-021000021-4417009921',
  portalDomain: 'pay.tessaline.example',
  merchantDescriptor: 'TESSALINE SYSTEMS INC',
  mcc: '5045',
  currency: 'USD',
};

// Under US$200 so the same invoice also fits the Airi test card's per-transaction limit.
export const invoice: Invoice = {
  id: 'INV-4417',
  entityId: 'sandbox',
  vendorId: vendor.id,
  amount: 186.4,
  currency: 'USD',
  dueDate: '2026-11-20',
};

export const policy: Policy = { version: 'ap-policy-1', surchargeCapPct: 3, paymentWindowHours: 72 };

export const hiddenSurchargePct = 3.4;
