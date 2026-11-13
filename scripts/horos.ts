import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as awx from '../src/airwallex.ts';
import { approvalFor, createApprovalStore } from '../src/authorize.ts';
import { Aborted, cardSession, closeAllCards, rememberRemoteAuth, restoreRemoteAuth } from '../src/cards.ts';
import { openLedger, type ObligationState } from '../src/ledger.ts';
import { approvalDigest, approvalTerms, assessClaim, cardControls, obligationKey, onDecline, toCents, type Invoice } from '../src/policy.ts';
import { reconcileCardPayment, type CardPaymentState } from '../src/reconcile.ts';
import { startAuthServer } from '../src/server.ts';
import { provenUnpaid, settle } from '../src/settle.ts';
import { hiddenSurchargePct, invoice as demoInvoice, policy, vendor } from '../src/demo-data.ts';

const PORT = Number(process.env.HOROS_PORT ?? 8787);
const DB_FILE = process.env.HOROS_DB ?? 'data/horos.db';
const READY_STREAK = 3;
const RUN_LOCK = 'account_run_lock';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round2 = (n: number) => Math.round(n * 100) / 100;
// An abort must reach the top of the run; every other failure is just recorded.
const soft = (e: unknown) => {
  if (e instanceof Aborted) throw e;
  return (e as Error).message;
};

const USAGE = `usage (from horos/, with --env-file=.env):
  scripts/horos.ts doctor
      Read-only health check: Airwallex login, USD balance, cardholder, remote auth config, Airi session.
  scripts/horos.ts run <https-tunnel-url>
      Plays the supplier-fraud scenario on the live sandbox and writes runs/receipt-<ts>.json.
      Needs a tunnel forwarding the url to localhost:${PORT} (for example: ngrok http ${PORT}).
      Exit 0 only when every check passes; 1 when a check fails or the run is stopped; 2 when cleanup is unconfirmed.
  scripts/horos.ts reconcile
      Settles every obligation left RESERVED or PAYMENT_UNKNOWN from what Airwallex recorded.
  scripts/horos.ts cleanup
      After a crash: closes every card Horos created, then restores the remote auth setting from before the run.
      Refuses while the run holding the lock is still alive.
  scripts/horos.ts resolve <obligation> <PAID|OPEN> "<reason>"
      A person's decision on an EXCEPTION or PAYMENT_UNKNOWN obligation, recorded with their reason.`;

// The phishing email: new bank details plus a "payment portal" that clears as a lookalike merchant.
const phishingEmail = {
  from: 'accounts@tessaline-billing.example',
  claim: {
    vendorName: vendor.name,
    newIban: 'US-ACH-026009593-8810023341',
    portalUrl: 'https://pay.tessaline-billing.example/inv/4417',
  },
  lookalikeDescriptor: 'TESSALLNE SYSTEMS',
};

async function doctor() {
  const checks: Record<string, unknown> = {};
  let healthy = true;
  for (const name of ['AWX_CLIENT_ID', 'AWX_API_KEY', 'AWX_REMOTE_AUTH_SECRET']) checks[name] = Boolean(process.env[name]);
  try {
    checks.usdAvailable = (await awx.balance('USD')).available_amount;
    checks.cardholder = await awx.firstReadyCardholder();
    const config = await awx.issuingConfig();
    const ra = config.remote_auth_settings ?? config.remote_auth;
    checks.remoteAuth = ra ? { enabled: ra.enabled, url: ra.url, default_action: ra.default_action } : 'not configured';
    const active = await awx.activeCards();
    checks.activeCards = active.has_more ? `${active.items.length}+` : active.items.length;
  } catch (e) {
    checks.airwallex = (e as Error).message;
    healthy = false;
  }
  try {
    const who = JSON.parse(execFileSync('airi-cli', ['auth', 'whoami'], { encoding: 'utf8' }));
    checks.airi = { authenticated: who.authenticated, client: who.client_name, expires: who.session_expires };
  } catch (e) {
    checks.airi = (e as Error).message.split('\n')[0];
  }
  console.log(JSON.stringify(checks, null, 2));
  process.exit(healthy ? 0 : 1);
}

async function reconcileAll() {
  const ledger = openLedger(DB_FILE);
  const results = [];
  for (const o of ledger.unsettled()) results.push(await settle(ledger, o.key).catch((e) => ({ obligation: o.key, error: (e as Error).message })));
  console.log(JSON.stringify(results, null, 2));
  // 3 means something is still unresolved and nothing may pay it yet, the same as from airi-pay.
  // Settles payments only. Its exit code still discloses everything outstanding: 1 an error, 3 a payment unresolved
  // (no rail may pay it), 4 an exception waiting for a person, 2 a result Airi has not yet received (run
  // airi-pay.ts reconcile to deliver it), 0 nothing outstanding.
  const unresolved = ledger.unsettled().length > 0;
  const exceptions = ledger.inState('EXCEPTION');
  const reports = ledger.pendingReports();
  console.log(JSON.stringify({ exceptions: exceptions.map((o) => o.key), undeliveredReports: reports.map((r) => r.mandate_id) }, null, 2));
  process.exit(results.some((r) => 'error' in r) ? 1 : unresolved ? 3 : exceptions.length ? 4 : reports.length ? 2 : 0);
}

// A person's decision on an exception or an unknown payment, after reading its remediation: the recorded outcome
// is theirs, with their reason, and nothing else can move the obligation out of those states. Closing the invoice is
// not the same as booking it: the accounting entry follows the provider's own reading of the payment, so a person
// can close a short-paid invoice without the books recording the approved amount.
async function resolve(key: string, to: string, reason: string) {
  const ledger = openLedger(DB_FILE);
  const o = ledger.get(key);
  if (!o || !o.attempt_id || !['EXCEPTION', 'PAYMENT_UNKNOWN'].includes(o.state) || !['PAID', 'OPEN'].includes(to) || !reason) {
    console.error('usage: horos.ts resolve <obligation> <PAID|OPEN> "<reason>"  (only an EXCEPTION or PAYMENT_UNKNOWN obligation)');
    process.exit(1);
  }
  // Reopening lets another attempt pay, so it needs the provider's proof that this one moved no money and never can:
  // a charge that succeeded, may still succeed, or cannot be read keeps the invoice closed, whatever the person decides.
  if (to === 'OPEN') {
    const check = await provenUnpaid(ledger, key);
    if (!check.unpaid) {
      console.error(`not reopened: the provider does not prove this attempt unpaid; resolve PAID if it paid, or run reconcile when the provider is readable\n${JSON.stringify(check.evidence)}`);
      process.exit(1);
    }
  }
  const ops = ledger.operations(key, o.attempt_id);
  // A VIC attempt's mandate is owed a result once a person decides; airi-pay reconcile sends it.
  const mandateId = ops.filter((op) => op.kind === 'MANDATE').at(-1)?.external_id;
  const report = mandateId ? ({ mandate_id: mandateId, result: to === 'PAID' ? 'SUCCEEDED' : 'DECLINED', reason: to === 'OPEN' ? `resolved by operator: ${reason}` : null } as const) : undefined;
  const ref = to === 'PAID' ? ops.filter((op) => op.kind === 'INTENT_CREATE' && op.external_id).at(-1)?.external_id : undefined;
  const intent = ref ? await awx.getPaymentIntent(ref).catch(() => undefined) : undefined;
  const payment = ref ? { ref, observed: intent && { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency } } : undefined;
  ledger.transition(key, o.attempt_id, o.state, to as 'PAID' | 'OPEN', `resolved by operator: ${reason}`, report, payment);
  const accounting = ledger.accounting(key)[0];
  console.log(JSON.stringify({ obligation: ledger.get(key), accounting }, null, 2));
  if (accounting?.status === 'NEEDS_REVIEW') console.error(`invoice closed; its accounting entry is held for review, not booked: ${accounting.detail}`);
  process.exit(0);
}

// The lock holds the run id and its process id; a run whose process is gone can be cleaned up, a live one cannot.
// A lock whose process cannot be checked counts as live: cleanup never overrides what it cannot verify.
const lockHolderAlive = (lock: string) => {
  const pid = Number(lock.split(':')[1]);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// After a crash: closes the cards in Horos's own inventory (never a broad sweep), restores the saved remote auth
// setting, and releases the run lock only when both are confirmed.
async function cleanup() {
  const ledger = openLedger(DB_FILE);
  const lock = ledger.setting(RUN_LOCK);
  if (lock && lockHolderAlive(lock)) {
    console.error(`run ${lock} may still be running; stop it first (Ctrl-C runs the same cleanup)`);
    process.exit(1);
  }
  let cards = await closeAllCards(ledger);
  // Read the inventory again: nothing may have appeared while the first pass ran.
  if (cards.allClosed && ledger.openCards().length) cards = await closeAllCards(ledger);
  const current = await awx.issuingConfig();
  const url = (current.remote_auth_settings ?? current.remote_auth)?.url ?? 'https://invalid.example/remote-auth';
  const remoteAuth = cards.allClosed ? await restoreRemoteAuth(ledger, url) : 'NOT_RESTORED: cards still open';
  const clean = cards.allClosed && ledger.openCards().length === 0 && typeof remoteAuth === 'object' && remoteAuth.restored;
  if (clean && lock) ledger.unlock(RUN_LOCK, lock);
  console.log(JSON.stringify({ cards, remoteAuth, runLock: clean ? 'released' : lock ?? 'none' }, null, 2));
  process.exit(clean ? 0 : 2);
}

async function run(publicUrl: string) {
  mkdirSync('runs', { recursive: true });
  mkdirSync('data', { recursive: true });
  const ledger = openLedger(DB_FILE);
  const startedAt = Date.now();
  const logFile = `runs/auth-log-${startedAt}.jsonl`;
  const receiptFile = `runs/receipt-${startedAt}.json`;
  const runId = `run-${startedAt}:${process.pid}`;
  // Remote auth is one account-wide setting: two runs at once would change it under each other.
  if (!ledger.lock(RUN_LOCK, runId)) {
    console.error(`another run holds the account lock (${ledger.setting(RUN_LOCK)}); if it crashed, run \`horos.ts cleanup\``);
    process.exit(1);
  }
  let secret = process.env.AWX_REMOTE_AUTH_SECRET ?? '';
  let answering = true;
  // Every armed card is bound to its ledger attempt, checked at network time.
  const store = createApprovalStore((obligation, attempt) => ledger.owns(obligation, attempt));
  const server = startAuthServer({ store, secret: () => secret, port: PORT, host: '127.0.0.1', logFile, answering: () => answering });

  // Each demo run pays its own copy of the invoice, so a rerun can never clear a real paid lock.
  const invoice: Invoice = { ...demoInvoice, entityId: `${demoInvoice.entityId}:demo-${startedAt}` };
  const key = obligationKey(invoice);
  const receipt: Record<string, unknown> = {
    startedAt: new Date(startedAt).toISOString(),
    obligation: key,
    invoice,
    vendor: { ...vendor, iban: `on file, ending ${vendor.iban.slice(-4)}` },
  };
  const checks: { check: string; pass: boolean; detail?: unknown }[] = [];
  const check = (name: string, pass: boolean, detail?: unknown) => void checks.push({ check: name, pass, detail });

  // Nothing has changed yet, so a failure here releases the lock and stops.
  let holder: string;
  try {
    receipt.remoteAuthBeforeRun = await rememberRemoteAuth(ledger);
    holder = await awx.firstReadyCardholder();
  } catch (e) {
    ledger.unlock(RUN_LOCK, runId);
    console.error(`could not start: ${(e as Error).message}`);
    process.exit(1);
  }
  const cards = cardSession(ledger, holder);

  // The only way out of a run. Remote auth is what stops an issued card from paying anyone inside its card controls,
  // so it is restored only after nothing new can start, in-flight calls have settled, and every card reads CLOSED.
  let completed = false;
  // Latched on the first signal, even one arriving while cleanup is already running, and read at exit.
  let interrupted: string | undefined;
  let ending: Promise<never> | undefined;
  const end = () =>
    (ending ??= (async () => {
      try {
        await finishRun();
      } catch (e) {
        // A failure while finishing (for example the receipt cannot be written) must still end the process; remote
        // auth is left as cleanup found it, and `horos.ts cleanup` can finish the job.
        console.error(`run did not finish cleanly: ${(e as Error).message}`);
        process.exit(2);
      }
      process.exit(2);
    })());
  const finishRun = async () => {
      if (interrupted) console.error(`${interrupted}: stopping, closing cards, then restoring remote authorization`);
      cards.stop();
      const drained = await cards.drain(15_000);
      const closed = await closeAllCards(ledger).catch((e) => ({ allClosed: false, cards: [], error: (e as Error).message }));
      receipt.cleanup = { drained, ...closed };
      let clean = drained && closed.allClosed;
      if (!clean) {
        receipt.incident = drained
          ? 'Not every card could be confirmed CLOSED: remote authorization left on with default DECLINED. Run `horos.ts cleanup`.'
          : 'A call was still in flight when cleanup ran: remote authorization left on with default DECLINED. Run `horos.ts cleanup`.';
      } else {
        const restored = await restoreRemoteAuth(ledger, `${publicUrl}/remote-auth`);
        receipt.remoteAuthAfterRun = restored.readBack;
        if (restored.error) receipt.restoreError = restored.error;
        clean = restored.restored;
      }
      check('every card closed and remote auth restored to its previous setting', clean, receipt.remoteAuthAfterRun);
      if (clean) ledger.unlock(RUN_LOCK, runId);
      receipt.aborted = interrupted;
      receipt.checks = checks;
      receipt.unsignedRequestsRejected = server.unsignedRejected();
      receipt.ledger = { obligation: ledger.get(key), operations: ledger.operations(key) };
      receipt.authLog = logFile;
      receipt.finishedAt = new Date().toISOString();
      writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
      console.log(JSON.stringify(receipt, null, 2));
      console.log(`saved ${receiptFile}`);
      await server.stop();
      if (interrupted && !receipt.aborted) {
        receipt.aborted = `${interrupted} (during final cleanup)`;
        writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
      }
      ledger.close();
      process.exit(!clean ? 2 : completed && !interrupted && checks.every((c) => c.pass) ? 0 : 1);
  };
  const interrupt = (why: string) => {
    interrupted ??= why;
    void end();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => interrupt(signal));
  process.on('uncaughtException', (e) => interrupt(`uncaught ${e.message}`));
  process.on('unhandledRejection', (e) => interrupt(`unhandled ${(e as Error)?.message ?? e}`));

  // Gate cards journal each charge like the payment does, so recovery knows a charge was sent even if its answer is lost.
  const gateOf = new Map<string, { key: string; attempt: string }>();
  const attempt = async (label: string, cardId: string, amount: number, merchant: string, singlePhase = false) => {
    let result: awx.SimulatedTransaction | undefined;
    let error: string | undefined;
    const gate = gateOf.get(cardId);
    const chargeId = randomUUID();
    const journalGate = (status: string, lifecycle: string | null) =>
      gate && ledger.record(gate.attempt, { request_id: chargeId, obligation: gate.key, rail: 'ISSUED_CARD', kind: 'AUTHORIZATION', external_id: lifecycle, status, detail: label });
    journalGate('SENT', null);
    try {
      result = await cards.charge(cardId, { amount, currency: invoice.currency, mcc: vendor.mcc, merchantInfo: merchant, singlePhase });
    } catch (e) {
      error = soft(e);
    }
    journalGate(result?.process_result ?? 'NO_RESPONSE', result?.card_transaction_lifecycle_id ?? null);
    const horos = result && server.log.find((entry) => entry.transactionId === result.card_transaction_id);
    return {
      label,
      merchant,
      amount,
      network: result?.process_result ?? 'ERROR',
      reason: result?.failure_reason ?? error,
      transactionId: result?.card_transaction_id,
      lifecycleId: result?.card_transaction_lifecycle_id,
      horos: horos
        ? { decision: horos.decision, transactionType: horos.transactionType, signed: horos.signed, serverMs: horos.ms, merchantId: horos.merchantId }
        : 'not called',
    };
  };
  const horosReason = (a: Awaited<ReturnType<typeof attempt>>) => {
    if (typeof a.horos === 'string') return a.horos;
    return typeof a.horos.decision === 'string' ? a.horos.decision : a.horos.decision.status_reason;
  };
  // Poll the provider ledger until the payment is decided; dual-message clearing lands there, not at remote auth.
  const reconcile = async (cardId: string, lifecycleId: string) => {
    let state: CardPaymentState = { state: 'PAYMENT_UNKNOWN', reason: 'NOT_READ', notes: [] };
    for (let i = 0; i < 6 && state.state === 'PAYMENT_UNKNOWN'; i++) {
      if (i) await sleep(2000);
      const items = await awx.cardTransactions(cardId).then((r) => r.items, () => undefined);
      if (items) state = reconcileCardPayment(items, { lifecycleId, amount: invoice.amount, currency: invoice.currency, merchantDescriptor: vendor.merchantDescriptor });
    }
    return state;
  };
  // Gate tests pay their own ledger obligations on their own cards, so every money movement in the run is in the
  // ledger, and none of them can touch the invoice.
  const gateCard = async (suffix: string) => {
    const gateInvoice = { ...invoice, id: `${invoice.id}~${suffix}` };
    const controls = cardControls(gateInvoice, vendor, policy);
    const terms = approvalTerms(gateInvoice, vendor, controls, policy);
    const gateKey = obligationKey(gateInvoice);
    ledger.open(gateKey, toCents(gateInvoice.amount), gateInvoice.currency);
    const saved = ledger.saveApproval(terms, 'gate test');
    const attempt = ledger.reserve(gateKey, 'ISSUED_CARD', saved.digest);
    if (!attempt) throw new Error(`OBLIGATION_NOT_OPEN ${gateKey}`);
    // Journaled like the payment, so a crash mid-test leaves reconcile the card to check.
    const createId = randomUUID();
    const op = { request_id: createId, obligation: gateKey, rail: 'ISSUED_CARD' as const, kind: 'CARD_CREATE', detail: null };
    ledger.record(attempt, { ...op, external_id: null, status: 'SENT' });
    const card = await cards.issue(`${invoice.id}:${suffix}`, controls, createId);
    ledger.record(attempt, { ...op, external_id: card.card_id, status: 'CREATED' });
    store.arm(approvalFor(card.card_id, terms, saved.digest, attempt));
    gateOf.set(card.card_id, { key: gateKey, attempt });
    return { ...card, key: gateKey, attempt };
  };
  // Reverses an approved hold; true only on the provider's confirmation.
  const release = (a: { lifecycleId?: string }) =>
    a.lifecycleId ? awx.simulateReversal(a.lifecycleId).then((r) => r.process_result === 'APPROVED', () => false) : Promise.resolve(false);
  // A gate closes OPEN only when every attempt has a known ending: declined, or approved and its hold released. An
  // attempt whose outcome never came back is treated like any uncertain charge and keeps the gate blocked.
  const closeGate = async (gate: { key: string; attempt: string }, attempts: { network: string; lifecycleId?: string }[]) => {
    const released = await Promise.all(attempts.filter((a) => a.network === 'APPROVED').map(release));
    const unknown = attempts.filter((a) => a.network !== 'APPROVED' && a.network !== 'DECLINED').length;
    settleGate(gate, unknown === 0 && released.every(Boolean) ? 'OPEN' : 'PAYMENT_UNKNOWN', { attempts: attempts.length, holdsReleased: released, unknownOutcomes: unknown });
  };
  const settleGate = (gate: { key: string; attempt: string }, to: ObligationState, evidence: unknown) =>
    to !== 'RESERVED' && ledger.transition(gate.key, gate.attempt, 'RESERVED', to, JSON.stringify(evidence));
  const retire = async (cardId: string) => {
    store.disarm(cardId);
    await awx.closeCard(cardId).catch(() => undefined);
    return awx.getCard(cardId).then((c) => c.card_status === 'CLOSED', () => false);
  };
  const toLedger: Record<CardPaymentState['state'], ObligationState> = { PAID: 'PAID', EXCEPTION: 'EXCEPTION', NOT_PAID: 'OPEN', PAYMENT_UNKNOWN: 'PAYMENT_UNKNOWN' };

  try {
    const assessment = assessClaim(phishingEmail.claim, vendor);
    receipt.email = { from: phishingEmail.from, claim: phishingEmail.claim, ...assessment, wire: assessment.holdWire ? 'HELD' : 'RELEASED' };
    check('bank-change email holds the wire', assessment.holdWire, assessment.findings);

    const controls = cardControls(invoice, vendor, policy);
    const terms = approvalTerms(invoice, vendor, controls, policy);
    const digest = approvalDigest(terms);
    receipt.approval = {
      terms,
      digest,
      approvedBy: 'operator (simulated in this run)',
      counterparty: terms.acceptorId ? 'ACCEPTOR_ID_BOUND' : 'DESCRIPTOR_ONLY: the payee is matched by network name, MCC and amount, not by a verified merchant id',
    };
    ledger.open(key, toCents(invoice.amount), invoice.currency);
    ledger.saveApproval(terms, 'operator (simulated in this run)');

    const config = await awx.updateRemoteAuth({ enabled: true, url: `${publicUrl}/remote-auth`, default_action: 'DECLINED', new_shared_secret: !secret });
    const settings = config.remote_auth_settings ?? config.remote_auth;
    if (settings?.shared_secret) {
      secret = settings.shared_secret;
      appendFileSync('.env', `\nAWX_REMOTE_AUTH_SECRET=${secret}\n`);
    }
    receipt.remoteAuth = { enabled: settings?.enabled, url: settings?.url, default_action: settings?.default_action };
    const walletBefore = await awx.balance(invoice.currency);

    // Readiness: Airwallex applies the config unevenly for a while after the write (live: a charge cleared on card
    // controls alone, and later one probe answered while the next charge never reached Horos). An unarmed $1 card
    // must be answered by Horos several times in a row before any armed card exists.
    const probeCard = await cards.issue(`${invoice.id}:readiness-probe`, {
      ...controls,
      allowed_transaction_count: 'MULTIPLE',
      transaction_limits: { currency: invoice.currency, limits: [{ amount: 1, interval: 'ALL_TIME' }] },
    });
    const probes = [];
    let answered = 0;
    for (let i = 0; i < 15 && answered < READY_STREAK; i++) {
      const p = await attempt('readiness probe on an unarmed card', probeCard.card_id, 1, vendor.merchantDescriptor);
      // A probe that slipped through holds $1 until it is reversed; that reversal is evidence, not a best effort.
      const released = p.network === 'APPROVED' ? await release(p) : true;
      probes.push({ network: p.network, horos: horosReason(p), released });
      answered = horosReason(p) === 'UNKNOWN_CARD' && p.network === 'DECLINED' ? answered + 1 : 0;
      if (answered < READY_STREAK) await sleep(answered ? 1000 : 3000);
    }
    receipt.readiness = probes;
    const ready = answered >= READY_STREAK;
    check('Horos answers authorizations before any armed card exists', ready, `${probes.length} probe(s)`);
    check('every readiness probe that slipped through was released', probes.every((p) => p.released), probes);
    if (!ready) throw new Error('REMOTE_AUTH_NOT_READY');
    await retire(probeCard.card_id);

    const gate = await gateCard('gate-test');
    const gateAttempts = [
      await attempt('phishing portal (lookalike merchant), invoice amount', gate.card_id, invoice.amount, phishingEmail.lookalikeDescriptor),
      await attempt('real supplier, above invoice but inside card cap', gate.card_id, 190, vendor.merchantDescriptor),
      await attempt('real supplier, hidden surcharge above card cap', gate.card_id, round2(invoice.amount * (1 + hiddenSurchargePct / 100)), vendor.merchantDescriptor),
    ];
    await retire(gate.card_id);
    // Config lag can let a gate charge through on card controls alone; its hold is released before the test closes.
    await closeGate(gate, gateAttempts);
    receipt.gateTest = { note: 'gate test on its own card and approval; not a payment of the invoice', cardId: gate.card_id, attempts: gateAttempts };
    check('lookalike merchant refused by Horos', gateAttempts[0].network === 'DECLINED' && horosReason(gateAttempts[0]) === 'MERCHANT_MISMATCH');
    check('above-invoice charge inside the card cap refused by Horos', gateAttempts[1].network === 'DECLINED' && horosReason(gateAttempts[1]) === 'AMOUNT_EXCEEDS_APPROVAL');
    check('surcharge above the card cap refused by card controls', gateAttempts[2].network === 'DECLINED' && gateAttempts[2].reason === 'LIMIT_EXCEEDED');

    // The payment: one reserved obligation, one card, one charge.
    const owner = ledger.reserve(key, 'ISSUED_CARD', digest);
    if (!owner) throw new Error(`OBLIGATION_NOT_OPEN ${ledger.get(key)?.state}`);
    const journal = (requestId: string, kind: string, externalId: string | null, status: string, detail: string | null = null) =>
      ledger.record(owner, { request_id: requestId, obligation: key, rail: 'ISSUED_CARD', kind, external_id: externalId, status, detail });
    const createId = randomUUID();
    journal(createId, 'CARD_CREATE', null, 'SENT');
    const card = await cards.issue(`${invoice.id}:${digest.slice(0, 12)}`, controls, createId).catch((e) => {
      // Any card that create may have made is unarmed, in the inventory, and closed by cleanup before reconcile.
      ledger.transition(key, owner, 'RESERVED', 'PAYMENT_UNKNOWN', `card create failed: ${(e as Error).message}`);
      throw e;
    });
    journal(createId, 'CARD_CREATE', card.card_id, 'CREATED');
    store.arm(approvalFor(card.card_id, terms, digest, owner));

    const authId = randomUUID();
    journal(authId, 'AUTHORIZATION', null, 'SENT');
    const payment = await attempt('real supplier, invoice amount', card.card_id, invoice.amount, vendor.merchantDescriptor);
    journal(authId, 'AUTHORIZATION', payment.lifecycleId ?? null, payment.network, payment.reason ?? null);
    let settled: CardPaymentState | undefined;
    let decline: ReturnType<typeof onDecline> | undefined;
    if (payment.network === 'APPROVED' && payment.lifecycleId) {
      const captureId = randomUUID();
      journal(captureId, 'CAPTURE', payment.lifecycleId, 'SENT');
      const capture = await cards.capture(payment.lifecycleId, vendor.merchantDescriptor).then(
        (c) => ({ result: c.process_result, error: undefined as string | undefined }),
        (e) => ({ result: 'ERROR', error: soft(e) }),
      );
      journal(captureId, 'CAPTURE', payment.lifecycleId, capture.result, capture.error ?? null);
      settled = await reconcile(card.card_id, payment.lifecycleId);
      ledger.transition(key, owner, 'RESERVED', toLedger[settled.state], JSON.stringify(settled));
      receipt.capture = capture;
    } else if (payment.network === 'DECLINED') {
      // The decline policy, executed: close the card, never retry, hand the decision to a person. The invoice
      // reopens only once the card reads back CLOSED.
      decline = onDecline(payment.reason ?? 'UNKNOWN');
      const closed = await retire(card.card_id);
      ledger.transition(key, owner, 'RESERVED', closed ? 'OPEN' : 'PAYMENT_UNKNOWN', `declined: ${payment.reason}; escalated${closed ? '' : '; card not confirmed closed'}`);
    } else {
      ledger.transition(key, owner, 'RESERVED', 'PAYMENT_UNKNOWN', `authorization outcome unknown: ${payment.reason}`);
    }
    receipt.payment = { cardId: card.card_id, attempt: payment, reconciliation: settled, decline };
    check('invoice marked PAID only from a matching provider clearing', ledger.get(key)?.state === 'PAID' && settled?.state === 'PAID', settled ?? decline);

    const replay = await attempt('replay: second charge on the paid card', card.card_id, invoice.amount, vendor.merchantDescriptor);
    // Airwallex closes a single-use card once it clears, so this replay is refused by the network (CARD_CLOSED). Horos's
    // own once-only refusal (APPROVAL_ALREADY_USED) is shown live by the concurrent duplicates below.
    check('replay on the paid card refused (card closed by Airwallex after clearing)', replay.network === 'DECLINED', replay.reason);
    // The same reservation airi-pay.ts makes before a VIC checkout, on the same ledger. Asked only once the card
    // has paid: on an open invoice it would rightly succeed and hold the invoice for a checkout that never comes.
    if (ledger.get(key)?.state === 'PAID') {
        check('the shared ledger refuses the VIC rail for the obligation the card paid', !ledger.reserve(key, 'VIC_CHECKOUT', digest));
    }
    receipt.afterPayment = { replay, obligationState: ledger.get(key)?.state };
    await retire(card.card_id);

    // A single-message charge authorizes and clears in one request, so it reaches Horos as a CLEARING.
    const single = await gateCard('single-message-test');
    const singleCharge = await attempt('single-message charge at the invoice amount', single.card_id, invoice.amount, vendor.merchantDescriptor, true);
    const singleState = singleCharge.lifecycleId ? await reconcile(single.card_id, singleCharge.lifecycleId) : undefined;
    await retire(single.card_id);
    settleGate(single, toLedger[singleState?.state ?? 'PAYMENT_UNKNOWN'], singleState);
    receipt.singleMessageTest = { note: 'gate test: authorization and clearing in one message', cardId: single.card_id, attempt: singleCharge, reconciliation: singleState };
    const singleType = typeof singleCharge.horos === 'object' ? singleCharge.horos.transactionType : undefined;
    check(
      'a single-message charge reaches Horos as a CLEARING, is approved, and reconciles PAID',
      singleCharge.network === 'APPROVED' && horosReason(singleCharge) === 'MATCHES_APPROVAL' && singleType === 'CLEARING' && singleState?.state === 'PAID',
      { transactionType: singleType, reconciliation: singleState?.state },
    );

    // The network lets a merchant clear more than was authorized; only reconciliation can catch it.
    const over = await gateCard('overcapture-test');
    const overAuth = await attempt('authorization at the invoice amount', over.card_id, invoice.amount, vendor.merchantDescriptor);
    let overcapture: Record<string, unknown> = { authorization: overAuth };
    if (overAuth.network === 'APPROVED' && overAuth.lifecycleId) {
      const c = await cards.capture(overAuth.lifecycleId, vendor.merchantDescriptor, 190).then(
        (r) => ({ result: r.process_result }),
        (e) => ({ result: 'ERROR', error: soft(e) }),
      );
      overcapture = { ...overcapture, capture: { amount: 190, ...c }, reconciliation: await reconcile(over.card_id, overAuth.lifecycleId) };
    }
    await retire(over.card_id);
    settleGate(over, toLedger[(overcapture.reconciliation as CardPaymentState | undefined)?.state ?? 'PAYMENT_UNKNOWN'], overcapture.reconciliation);
    receipt.overcaptureTest = { note: 'gate test: a clearing above the approved authorization', cardId: over.card_id, ...overcapture };
    const overState = overcapture.reconciliation as CardPaymentState | undefined;
    check('a clearing above the approval is flagged as an exception with a remediation', overState?.state === 'EXCEPTION' && overState.reason === 'CLEARED_ABOVE_APPROVAL', overState);

    // Three identical charges fired concurrently (Airwallex delivers them to Horos one after another): exactly one may pass.
    const race = await gateCard('race-test');
    const raceAttempts = await Promise.all(
      [1, 2, 3].map((n) => attempt(`duplicate charge ${n} of 3, fired concurrently`, race.card_id, invoice.amount, vendor.merchantDescriptor)),
    );
    const reversals = [];
    for (const a of raceAttempts.filter((r) => r.network === 'APPROVED' && r.lifecycleId)) {
      const r = await awx.simulateReversal(a.lifecycleId!).catch((e) => ({ error: (e as Error).message }));
      reversals.push({ lifecycleId: a.lifecycleId, result: 'process_result' in r ? r.process_result : r.error });
    }
    await retire(race.card_id);
    const raceUnknown = raceAttempts.some((a) => a.network !== 'APPROVED' && a.network !== 'DECLINED');
    settleGate(race, !raceUnknown && reversals.every((r) => r.result === 'APPROVED') ? 'OPEN' : 'PAYMENT_UNKNOWN', { reversals, unknownAttempts: raceUnknown });
    const approvedRace = raceAttempts.filter((a) => a.network === 'APPROVED').length;
    receipt.race = { note: 'gate test; the one approved hold is reversed', cardId: race.card_id, approved: approvedRace, attempts: raceAttempts, reversals };
    check('concurrent duplicates: exactly one authorized', approvedRace === 1);
    check('race hold released', reversals.length === 1 && reversals[0].result === 'APPROVED', reversals);

    // Fail closed: a fresh, armed card while Horos stops answering. Airwallex must apply default_action DECLINED.
    const outageCard = await gateCard('outage-test');
    answering = false;
    const outage = await attempt('Horos stops answering (simulated outage), real supplier, invoice amount', outageCard.card_id, invoice.amount, vendor.merchantDescriptor);
    answering = true;
    await retire(outageCard.card_id);
    await closeGate(outageCard, [outage]);
    receipt.outage = { note: 'gate test', cardId: outageCard.card_id, ...outage };
    check('Horos silent: Airwallex declines by default', outage.network === 'DECLINED' && horosReason(outage) === 'NO_RESPONSE', outage.reason);

    await sleep(6000);
    const walletAfter = await awx.balance(invoice.currency);
    const clearedCents = [settled, singleState, overState].reduce((sum, s) => sum + (s && 'clearedCents' in s ? s.clearedCents : 0), 0);
    const drop = round2(walletBefore.total_amount - walletAfter.total_amount);
    receipt.wallet = { currency: invoice.currency, totalBefore: walletBefore.total_amount, totalAfter: walletAfter.total_amount, totalDrop: drop, reconciledClearings: clearedCents / 100 };
    check('wallet moved by exactly the reconciled clearings', toCents(drop) === clearedCents, { drop, reconciled: clearedCents / 100 });

    receipt.airwallexLedger = Object.fromEntries(
      await Promise.all(
        [gate.card_id, card.card_id, single.card_id, over.card_id, race.card_id, outageCard.card_id].map(async (id) => [
          id,
          (await awx.cardTransactions(id)).items.map((t) => ({
            transactionId: t.transaction_id,
            lifecycleId: t.card_transaction_data?.card_transaction_lifecycle_id,
            type: t.transaction_type,
            status: t.status,
            amount: t.transaction_amount,
            merchant: t.merchant?.name,
            merchantMcc: t.merchant?.category_code,
            merchantIdentifier: t.merchant?.identifier,
            failureReason: t.failure_reason,
            remoteAuth: t.remote_auth,
          })),
        ]),
      ),
    );
    completed = true;
  } catch (e) {
    if (!(e instanceof Aborted) && !interrupted) {
      receipt.error = (e as Error).message;
      check('run completed', false, (e as Error).message);
    }
  }
  await end();
}

const [command, arg] = process.argv.slice(2);
if (command === 'doctor') await doctor();
else if (command === 'run' && arg?.startsWith('https://')) await run(arg.replace(/\/$/, ''));
else if (command === 'reconcile') await reconcileAll();
else if (command === 'cleanup') await cleanup();
else if (command === 'resolve') await resolve(arg, process.argv[4], process.argv[5]);
else {
  console.error(USAGE);
  process.exit(command ? 1 : 0);
}
