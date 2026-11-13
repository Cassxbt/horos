import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEmail } from '../src/email.ts';

// Builds the judge site from evidence only: the replays, the live provider records in evidence/, and the supplier
// emails with Claude's recorded readings. The narration is written here; every number and identifier is read.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const load = (p: string) => JSON.parse(readFileSync(here(p), 'utf8'));
const replay = load('./replay.json');
const attacks = load('./attacks.json');
const evaluation = load('./eval.json');
const queue = load('../evidence/t0-queue-live-2026-11-12.json');
const vic = load('../evidence/vic-payment-live-2026-11-10.json');
const vicReadback = load('../evidence/vic-readback-2026-11-13.json');
const live = load('../evidence/slack-bill-live-2026-11-13.json');
const liveStep = (name: string) => live.steps.find((x: { step: string }) => x.step === name);
const livePaid = liveStep('passkey and payment');
const liveSettled = live.readback.observations.at(-1);
const issuing = load('../evidence/issuing-run-live-2026-11-11.json');
const readings = ['bank-change', 'remittance', 'forwarded-unclear'].map((n) => ({ name: n, ...load(`./emails/${n}.reading.json`) }));
const bankEmail = parseEmail(readFileSync(here('./emails/bank-change.eml'), 'utf8'));
const testCount = readdirSync(here('../test'))
  .filter((f) => f.endsWith('.test.ts'))
  .reduce((n, f) => n + (readFileSync(here(`../test/${f}`), 'utf8').match(/^test\(/gm) ?? []).length, 0);
const s = replay.story;
const OUT = here('../site');

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const words = (html: string) => html.replace(/(<em>[^<]*<\/em>|[^\s<]+)/g, '<span class="w">$1</span>');
const lines = (...ls: string[]) => ls.map((l) => `<span class="line-mask"><span>${l}</span></span>`).join('');
const passed = issuing.checks.filter((c: { pass: boolean }) => c.pass).length;
const heldAttacks = attacks.attacks.filter((a: { result: { confirms: number } }) => a.result.confirms === 0).length;
const tokens = readings.reduce((n, r) => n + r.usage.input_tokens + r.usage.output_tokens, 0);

function markedBody(body: string, passage: string) {
  const m = new RegExp(passage.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')).exec(body);
  return m ? `${esc(body.slice(0, m.index))}<mark>${esc(m[0])}</mark>${esc(body.slice(m.index + m[0].length))}` : esc(body);
}

const PAGES = [
  ['index', 'Overview'],
  ['case', 'The case'],
  ['judges', 'Judges'],
  ['proof', 'Proof'],
  ['how', 'How it works'],
] as const;

function layout(slug: (typeof PAGES)[number][0], title: string, description: string, body: string) {
  const nav = PAGES.filter(([p]) => p !== 'index')
    .map(([p, label]) => `<a class="link" href="${p}.html"${p === slug ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#0a0b09">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230a0b09'/%3E%3Ccircle cx='16' cy='16' r='5' fill='%2374dbb0'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/site.css">
<script>document.documentElement.classList.add('js');setTimeout(function(){if(!window.__horosReady)document.documentElement.classList.remove('js')},2500);</script>
</head>
<body>
<div class="progress" aria-hidden="true"></div>
<div class="grain" aria-hidden="true"></div>
<nav class="nav" aria-label="Site"><a class="brand" href="index.html"><i aria-hidden="true"></i>HOROS</a>${nav}<span class="run">npm run demo</span></nav>
<main>
${body}
</main>
<div class="wrap"><footer class="foot"><span>Horos · accounts-payable agent on Airwallex, built for the Agentic Banking hackathon by cassxbt · <a href="https://github.com/Cassxbt/horos">source</a></span><span>Built from <code>demo/replay.json</code>, <code>demo/attacks.json</code> and <code>evidence/</code> · rebuild with <code>npm run demo</code></span></footer></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js" defer></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js" defer></script>
<script src="https://cdn.jsdelivr.net/npm/lenis@1.1.13/dist/lenis.min.js" defer></script>
<script src="assets/site.js" defer></script>
</body>
</html>
`;
}

// Every claim links to the file it was built from; the files are published beside the pages.
const raw = (path: string, label = path) => `<a class="raw" href="evidence/${path}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;

const next = (href: string, label: string) => `<div class="wrap"><a class="next" href="${href}" data-reveal><span><span class="eyebrow">Next</span><br><span class="serif">${label}</span></span><span class="arrow" aria-hidden="true">→</span></a></div>`;
const chip = (kind: 'live' | 'recorded' | 'replay' | 'pending') =>
  `<span class="chip ${{ live: 'green', recorded: 'amber', replay: '', pending: 'red' }[kind]}">${{ live: 'Live sandbox', recorded: 'Recorded Claude output', replay: 'Replay on fakes', pending: 'Not run yet' }[kind]}</span>`;

// Overview
const overview = layout(
  'index',
  'Horos · stops the payment an email tries to move',
  'Horos is an accounts-payable agent on Airwallex: Claude reads the supplier email, a fixed policy holds the payment, and money moves only through a verified checkout with a single-use Visa credential.',
  `
<section class="hero split-hero wrap">
  <div>
    <span class="eyebrow" data-intro>Accounts-payable agent · Airwallex Agentic Banking</span>
    <h1>${lines('An email asked', 'to move the money.', '<em>Horos stopped it.</em>')}</h1>
    <p class="lede" data-intro>Supplier bank-change fraud works because an email can redirect a payment someone already approved. Horos reads that email with Claude, holds the payment the moment the payee is in question, and pays only through a checkout a person verified, with a single-use Visa credential.</p>
    <div class="actions" data-intro><a class="btn" href="case.html">See the case <span class="arrow">→</span></a><a class="btn ghost" href="judges.html">See the attacks <span class="arrow">→</span></a></div>
  </div>
  <div class="scene" aria-label="The supplier email, the approved payment it tried to redirect, and Horos's decision">
    <div class="glow" aria-hidden="true"></div>
    <div class="card mailcard"><div class="from">${esc(bankEmail.from)}<br>${esc(bankEmail.subject)}</div><p><mark>${esc(s.email.reading.passage)}</mark></p></div>
    <div class="card paycard"><span class="eyebrow">Approved checkout · replay</span><div class="amt">${esc(s.preview.amount)}</div><div class="row"><span>Invoice</span><b class="mono">INV-20250201-1234</b></div><div class="row"><span>Approved by</span><b>${esc(s.approval.approvedBy)}</b></div><div class="row"><span>Confirmations sent</span><b class="mono">${s.heldTotals.confirms}</b></div><div class="stamp"><big>Stopped</big>held for review</div></div>
    <div class="card policycard"><span class="eyebrow">Claude read · policy decided</span><div class="chips">${s.email.decision.reasons.map((r: string) => `<span class="chip red">${esc(r.toLowerCase().replace(/_/g, ' '))}</span>`).join('')}<span class="chip amber">${esc(s.email.decision.signals.join(' · ').toLowerCase().replace(/_/g, ' '))}</span></div></div>
  </div>
  <div class="scroll-cue eyebrow" aria-hidden="true"><span></span>Scroll</div>
</section>

<section class="band"><div class="wrap">
  <p class="statement">${words('Approval is not the dangerous moment. <em>Payment</em> is. Horos re-checks everything an approval rested on, at the instant before money moves.')}</p>
</div></section>

<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>01</b> / mechanism</span><div><h2 data-reveal>One gate, <em>four hands</em></h2><p data-reveal>The model reads. Fixed rules decide. The executor re-checks the world. The network pays once. No single part can move money on its own.</p></div></div>
  <div class="mech">
    <div class="ai spot" data-reveal><span class="who">Claude</span><h3>Reads the email</h3><p>As untrusted data, never as instructions. It must quote, word for word, the passage its verdict rests on.</p><span class="tag">Can add a hold. Never remove one.</span></div>
    <div class="spot" data-reveal><span class="who">Policy</span><h3>Decides</h3><p>The quote must be in the email. Bank-detail patterns hold on their own. Nothing in an email can set a payee or approve a payment.</p><span class="tag">Deterministic</span></div>
    <div class="spot" data-reveal><span class="who">Executor</span><h3>Re-checks</h3><p>At the start, after the one-time credential is issued, and just before confirming: the bill in T:0, the approval, the destination, the mandate's time left.</p><span class="tag">Three fresh reads</span></div>
    <div class="spot" data-reveal><span class="who">Visa · Airwallex</span><h3>Pays once</h3><p>A single-use Airi credential for the exact merchant, amount and approval. At most one payment per bill, on either rail.</p><span class="tag">Airi VIC · Airwallex checkout</span></div>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>02</b> / evidence</span><div><h2 data-reveal>Numbers you can <em>rebuild</em></h2><p data-reveal>Each figure is read from a file in the repository when this site is built.</p></div></div>
  <div class="figures">
    <div data-reveal><div class="n"><span data-count="0" data-from="${attacks.attacks.length}">0</span></div><p>confirmations sent in ${heldAttacks} of ${attacks.attacks.length} attacks. The other one is the original payment, booked once.</p><span class="src mono eyebrow">demo/attacks.json</span></div>
    <div data-reveal><div class="n"><span data-count="${testCount}">${testCount}</span></div><p>tests, each fix mutation-checked: reverted until a named test failed.</p><span class="src mono eyebrow">npm test</span></div>
    <div data-reveal><div class="n"><span data-count="${passed}">${passed}</span><small>/${issuing.checks.length}</small></div><p>checks on a live Airwallex sandbox run, from card controls to the wallet balance.</p><span class="src mono eyebrow">evidence/issuing-run</span></div>
    <div data-reveal><div class="n"><span data-count="${vic.airwallex.amount.toFixed(2)}">${money(vic.airwallex.amount)}</span><small>USD</small></div><p>paid with a single-use Visa Intelligent Commerce credential from Airi.</p><span class="src mono eyebrow">evidence/vic-payment</span></div>
  </div>
</div></section>

<div class="marquee" aria-label="Invariants"><div class="track">${[...Array(2)].map(() => ['Claude can add a hold, never remove one', 'Unknown is held, never paid', 'Approve once, re-check at payment', 'At most one payment per bill', 'Nothing in an email changes the payee', 'Every refusal names its reason'].map((t) => `<span>${t}</span>`).join('')).join('')}</div></div>

<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>03</b> / built on</span><div><h2 data-reveal>Each sponsor <em>does a job</em></h2><p data-reveal>Remove any one and a check disappears.</p></div></div>
  <div class="stack">
    <article class="spot" data-reveal><span class="eyebrow">Airwallex</span><h3>Issuing, remote authorization, checkout</h3><p>Horos answers each card authorization itself, and pays supplier checkouts through Payment Acceptance.</p></article>
    <article class="spot" data-reveal><span class="eyebrow">Visa · Airi</span><h3>Intelligent Commerce credential</h3><p>A passkey-approved, single-use credential, bound to one mandate that must match the approval.</p></article>
    <article class="spot" data-reveal><span class="eyebrow">T:0</span><h3>The accounting system of record</h3><p>Every bill, open or paid, read fresh before each payment. One payment record owed back, never two.</p></article>
    <article class="spot" data-reveal><span class="eyebrow">Claude</span><h3>Reads what changed</h3><p>${esc(readings[0].model)} reads the supplier's email and cites its evidence. It never holds the pen on a payment.</p></article>
  </div>
</div></section>

<section class="cta wrap"><h2 data-reveal>Watch it <em>refuse.</em></h2><div class="actions" data-reveal><a class="btn" href="judges.html">See the attacks <span class="arrow">→</span></a><a class="btn ghost" href="proof.html">See the proof <span class="arrow">→</span></a></div></section>
`,
);

// The case
const why: Record<string, string> = {
  BANK_DETAILS_CHANGE_CLAIMED: 'Claude read a request to move payments',
  BANK_DETAIL_SIGNALS: 'bank-detail pattern in the text',
  UNCLEAR: 'Claude could not rule out a change to where payments go',
};
// The same approved bill, three emails: what each one's words, the bank-detail rules and Claude contributed, and what
// the approved checkout then did. Read from the replay; nothing here is computed in the page.
type Compared = { email: { email: { from: string; subject: string }; reading: { kind: string; passage: string }; decision: { outcome: string; reasons: string[]; signals: string[] } }; credentials: number; confirms: number };
const compared: [string, string, Compared][] = [
  ['routine', 'Routine notice', { email: replay.controls.remittance.email, credentials: replay.controls.remittance.credentialFetches, confirms: replay.controls.remittance.confirms }],
  ['unclear', 'Unclear forward', { email: replay.controls.forwarded.email, credentials: replay.controls.forwarded.credentialFetches, confirms: replay.controls.forwarded.confirms }],
  ['bank', 'Bank change', { email: s.email, credentials: s.heldTotals.credentialFetches, confirms: s.heldTotals.confirms }],
];
const contribution = (c: Compared) =>
  c.email.decision.outcome !== 'HOLD'
    ? 'Claude found no request to change anything, and no rule fired. The approved payment went ahead.'
    : c.email.decision.signals.length
      ? 'A bank-detail rule fired on its own, and Claude read the same request. Either would have held it.'
      : 'No bank-detail rule fired. The hold rests on Claude’s reading alone, and on the passage it quoted.';
const compare = `
  <div class="compare" data-tabs>
    <div class="tabs" role="tablist" aria-label="Three emails about the same approved bill">${compared.map(([id, label, c], n) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${n === 1}" tabindex="${n === 1 ? 0 : -1}"><span>${esc(label)}</span><i class="${c.email.decision.outcome === 'HOLD' ? 'red' : 'green'}">${c.email.decision.outcome === 'HOLD' ? 'held' : 'paid'}</i></button>`).join('')}</div>
    ${compared
      .map(
        ([id, label, c]) => `<article class="cpanel" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}">
      <div class="quote">
        <span class="eyebrow">${esc(label)} · ${esc(c.email.email.from)}</span>
        <h3>${esc(c.email.email.subject)}</h3>
        <p class="serif">“${esc(c.email.reading.passage)}”</p>
        <p class="note">${contribution(c)}</p>
      </div>
      <dl class="kv">
        <dt>Bank-detail rules</dt><dd>${c.email.decision.signals.length ? c.email.decision.signals.map((x) => `<span class="chip amber">${esc(x)}</span>`).join(' ') : '<span class="dim">none fired</span>'}</dd>
        <dt>Claude read</dt><dd class="mono">${esc(c.email.reading.kind.replace(/_/g, ' '))}</dd>
        <dt>Policy</dt><dd>${c.email.decision.outcome === 'HOLD' ? `<span class="chip red">held</span> ${c.email.decision.reasons.map((r) => esc(why[r] ?? r)).join(' · ')}` : '<span class="chip green">noted, no hold</span>'}</dd>
        <dt>Approved checkout</dt><dd><b class="big ${c.confirms ? 'green' : 'red'}">${c.confirms}</b> confirmation${c.confirms === 1 ? '' : 's'}, <b class="big">${c.credentials}</b> card credential${c.credentials === 1 ? '' : 's'}</dd>
      </dl>
    </article>`,
      )
      .join('')}
  </div>`;
const casePage = layout(
  'case',
  'The case · Horos',
  'An approved USD 100 supplier payment, an email asking to move the money, and the checkout Horos refused to confirm.',
  `
<section class="hero sub wrap">
  <div>
    <span class="eyebrow" data-intro>Case file · INV-20250201-1234 · ${esc(s.preview.amount)}</span>
    <h1>${lines('Approved.', 'Then the supplier', '<em>asked to move it.</em>')}</h1>
    <p class="lede" data-intro>A real bill from the T:0 accounting sandbox, a person's approval, and a bank-change email read by Claude. Scroll through what Horos did. Every value is replayed by the real Horos commands.</p>
    <div class="chips" data-intro>${chip('replay')}${chip('recorded')}</div>
  </div>
  <aside class="panel" data-intro>
    <span class="eyebrow">Outcome</span>
    <ol class="tl">
      <li><b>Approved</b><span>by ${esc(s.approval.approvedBy)}, to the verified checkout</span></li>
      <li class="stop"><b>Email arrives</b><span>Claude: ${esc(s.email.reading.kind.replace(/_/g, ' ').toLowerCase())}</span></li>
      <li class="stop"><b>Stopped</b><span>${s.heldTotals.confirms} confirmations, ${s.heldTotals.credentialFetches} credentials, twice</span></li>
      <li><b>Released by a person</b><span>old approval refused, new one given</span></li>
      <li class="paid"><b>Paid once</b><span>${s.totals.confirms} confirmation, Airi told SUCCEEDED</span></li>
    </ol>
  </aside>
</section>

<section class="band live-strip"><div class="wrap">
  <div class="band-head"><span class="index"><b>Live</b> · ${esc(day(livePaid.at))}</span><div><h2 data-reveal>Then it ran <em>live</em>, on this bill</h2><p data-reveal>The same sequence, on the live Airwallex, Airi and T:0 sandboxes, with Claude reading the email live. The payee is the team's <a class="link" href="checkout/slack.html">sandbox checkout standing in for Slack</a>, not Slack; the email is one we wrote.</p></div></div>
  <p class="outcome" data-reveal><span>First mandate <b class="no">denied</b></span><i aria-hidden="true">→</i><span>replacement <b>completed</b></span><i aria-hidden="true">→</i><span>Airwallex <b>${esc(liveSettled.latestAttempt.status.toLowerCase())}</b> USD ${money(liveSettled.amount)}</span><i aria-hidden="true">→</i><span>T:0 write <b class="wait">pending</b></span></p>
  <dl class="kv" data-reveal>
    <dt>Verified</dt><dd>by ${esc(liveStep('verified').by)}, ${esc(liveStep('verified').destination)}</dd>
    <dt>Approved</dt><dd>${esc(live.bill.amount)} by ${esc(liveStep('approved').by)}, digest <span class="mono">${esc(liveStep('approved').digest.slice(0, 12))}</span></dd>
    <dt>Claude, live</dt><dd><span class="mono">${esc(liveStep('supplier email read live').reading.kind)}</span>: “${esc(liveStep('supplier email read live').reading.passage)}”</dd>
    <dt>Checkout</dt><dd><span class="chip red">${esc(liveStep('approved checkout attempted').refused)}</span> 0 credentials, no payment intent</dd>
    <dt>Released</dt><dd>${esc(liveStep('verified again, after the email').by)} verified again; the old approval was refused as <span class="mono">${esc(liveStep('old approval retried').refused)}</span></dd>
    <dt>Paid once</dt><dd><span class="chip green">${esc(livePaid.state)}</span> USD ${money(livePaid.airwallex.amount)}, Airwallex <span class="mono">${esc(livePaid.airwallex.paymentIntentId)}</span> ${esc(livePaid.airwallex.status)}, Airi <span class="mono">${esc(livePaid.mandateId)}</span> ${esc(livePaid.airiResult.split(' ')[0])}; attempt ${esc(liveSettled.latestAttempt.status)} at ${esc(liveSettled.at.slice(11, 16))} UTC</dd>
    <dt>Received by</dt><dd>${esc(liveStep('approved').receivedBy.replace(/, read from.*$/, ''))}</dd>
  </dl>
  <p class="links" style="margin-top:18px">${raw('slack-bill-live-2026-11-13.json', 'The full record')}</p>
</div></section>

<section class="band" style="padding-top:60px"><div class="wrap story">
  <div class="sticky">
    <div class="mail">
      <div class="bar" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="head"><b>From</b> ${esc(bankEmail.from)}<br><b>Subject</b> ${esc(bankEmail.subject)}<br><b>Date</b> ${esc(bankEmail.date)}</div>
      <pre>${markedBody(bankEmail.body, s.email.reading.passage)}</pre>
    </div>
    <div class="verdict-card"><b>Claude read</b><span class="k">${esc(s.email.reading.kind.replace(/_/g, ' '))}</span><b>Policy</b><span class="k">${esc(s.email.decision.reasons.join(' · '))}</span></div>
  </div>
  <div class="steps">
    <article class="step" data-act="approved">
      <span class="eyebrow">01 · Verified, then approved</span>
      <h3>A person confirms the supplier and approves exactly what is shown</h3>
      <p>The approval binds the amount, the bill's version, the verified checkout and the Airwallex account that receives the money.</p>
      <dl class="kv"><dt>Checkout</dt><dd class="mono">${esc(s.preview.destination)}</dd><dt>Receives</dt><dd>${esc(s.preview.receivedBy.replace(/, read from.*$/, ''))} <span style="color:var(--dim)">(the replay's fake account)</span></dd><dt>Approved by</dt><dd>${esc(s.approval.approvedBy)}</dd><dt>Digest</dt><dd class="mono">${esc(s.approval.digest.slice(0, 24))}…</dd></dl>
    </article>
    <article class="step" data-act="email">
      <span class="eyebrow">02 · The email arrives</span>
      <h3>“…and all future payments, to our new account”</h3>
      <p>Claude (<span class="mono">${esc(s.email.model)}</span>) reads it as untrusted data and must quote the passage it relied on, word for word. The quote is checked against the email before it counts.</p>
      <p style="color:var(--ink)">${esc(s.email.reading.summary)}</p>
    </article>
    <article class="step" data-act="policy">
      <span class="eyebrow">03 · The policy decides</span>
      <h3>Held, for two independent reasons</h3>
      <div class="chips" style="margin-bottom:18px">${s.email.decision.reasons.map((r: string) => `<span class="chip red">${esc(why[r] ?? r)}</span>`).join('')}${s.email.decision.signals.map((x: string) => `<span class="chip amber">${esc(x)}</span>`).join('')}</div>
      <div class="terminal"><div><span class="ok">before</span> ${esc(s.queueBefore.replace(/\s+/g, ' '))}</div><div><span class="no">after </span> ${esc(s.queueAfter.replace(/\s+/g, ' '))}</div></div>
    </article>
    <article class="step stop" data-act="held">
      <span class="eyebrow">04 · The approved checkout</span>
      <h3>Tried twice. Refused twice.</h3>
      <div class="checkout">
        <div class="stamp"><big>Stopped</big>${s.heldTotals.confirms} confirmations</div>
        <ol style="margin:0;padding-left:18px;color:var(--muted);max-width:30em">${s.attempts.map((a: { when: string; refused: string }) => `<li style="margin:6px 0">${esc(a.when)}: <span class="mono" style="color:var(--red)">${esc(a.refused)}</span></li>`).join('')}</ol>
        <div class="tally"><div><span data-count="0" data-from="9">${s.heldTotals.confirms}</span><small>confirmations</small></div><div><span data-count="0" data-from="3">${s.heldTotals.credentialFetches}</span><small>card credentials</small></div><div><span data-count="0" data-from="5">${s.heldTotals.providerCalls}</span><small>payment calls</small></div></div>
      </div>
    </article>
    <article class="step" data-act="release">
      <span class="eyebrow">05 · Release</span>
      <h3>Only a person can release it, with a new approval</h3>
      <p>They confirm the supplier through a contact they already trust, never the one in the email. That verification postdates the email, and it invalidates the old approval.</p>
      <div class="terminal"><div><span class="cmd">$ queue.ts verify</span> <span class="ok">vendor and destination re-verified</span></div><div><span class="cmd">$ airi-pay.ts pay</span> <span class="no">${esc(s.release.stale.refused)}</span></div><div><span class="cmd">$ airi-pay.ts approve</span> <span class="ok">new digest ${esc(s.release.reapproval.digest.slice(0, 12))}</span></div></div>
    </article>
    <article class="step paid" data-act="paid">
      <span class="eyebrow">06 · Paid once</span>
      <h3>One confirmation, one result to Airi</h3>
      <dl class="kv"><dt>State</dt><dd style="color:var(--green)">${esc(s.release.payment.state)}</dd><dt>Confirmations</dt><dd>${s.totals.confirms} in total</dd><dt>Airi told</dt><dd class="mono">${esc(s.totals.airiResults.join(', '))}</dd></dl>
    </article>
  </div>
</div></section>

<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>Compare</b> · replay</span><div><h2 data-reveal>Same bill, <em>three emails</em></h2><p data-reveal>One approved USD 100 bill. Each email was read once, live, by Claude, and is replayed here through the real commands. Switch between them to see what the rules caught, what only Claude caught, and what the checkout then did.</p></div></div>
  ${compare}
</div></section>
${next('judges.html', 'See the attacks')}
`,
);

// Judges
const attackCard = (a: { id: string; title: string; attack: string; result: { said: string; confirms: number; charges: number; credentials: number }; note?: string }, i: number) => `
  <article class="attack spot" data-reveal>
    <header><span class="num">${String(i + 1).padStart(2, '0')}</span>${a.result.confirms === 0 ? '<span class="chip red">held · 0 confirmations</span>' : '<span class="chip amber">one payment, the original</span>'}</header>
    <h3>${esc(a.title)}</h3>
    <p class="threat">${esc(a.attack)}</p>
    <div class="said">${esc(a.result.said)}</div>
    ${a.note ? `<p class="note">${esc(a.note)}.</p>` : ''}
    <div class="counts"><div><span data-count="${a.result.confirms}" data-from="${a.result.confirms ? 0 : 6}">${a.result.confirms}</span><small>confirmations</small></div><div><span data-count="${a.result.charges}" data-from="${a.result.charges ? 0 : 4}">${a.result.charges}</span><small>charges</small></div><div><span data-count="${a.result.credentials}">${a.result.credentials}</span><small>credentials</small></div></div>
  </article>`;
const judges = layout(
  'judges',
  'Judges · Horos',
  'Eight attempts to make Horos pay what it should not, each run against the real commands with counts taken from the providers.',
  `
<section class="hero sub wrap">
  <div>
    <span class="eyebrow" data-intro>For judges · run it yourself</span>
    <h1>${lines('Eight ways to', 'make <em>Horos pay.</em>')}</h1>
    <p class="lede" data-intro>Each attack runs the real Horos commands in a fresh directory, against stand-ins for Airwallex, Airi and T:0. The counts come from the stand-ins' own records, not from Horos's report.</p>
    <div class="chips" data-intro>${chip('replay')}</div>
  </div>
  <aside class="panel" data-intro>
    <span class="eyebrow">Run it yourself</span>
    <div class="terminal" style="margin-top:16px"><div><span class="cmd">$ cd horos &amp;&amp; npm install</span></div><div><span class="cmd">$ npm run demo</span></div><div><span class="ok">  replays the case and every attack,</span></div><div><span class="ok">  rebuilds this site</span></div><div><span class="cmd">$ npm test</span></div><div><span class="ok">  ${testCount} tests</span></div></div>
    <div class="mini"><div><span data-count="${heldAttacks}">${heldAttacks}</span><small>of ${attacks.attacks.length} held at zero</small></div><div><span data-count="${testCount}">${testCount}</span><small>tests</small></div></div>
    <p class="links" style="margin-top:18px">${raw('attacks.json', 'Raw results: attacks.json')}<a class="raw" href="https://github.com/Cassxbt/horos" target="_blank" rel="noopener">Source ↗</a></p>
  </aside>
</section>
<section class="band" style="padding-top:60px"><div class="wrap">
  <div class="attacks">
    ${attacks.attacks.map(attackCard).join('')}
  </div>
  <div class="attacks" style="margin-top:14px">
    <article class="attack control spot" data-reveal><header><span class="num">Control</span><span class="chip green">paid once</span></header><h3>Nothing wrong</h3><p class="threat">The same approved bill, no email and no change anywhere.</p><div class="said">${esc(attacks.control.said)}</div><div class="counts"><div><span data-count="${attacks.control.confirms}">${attacks.control.confirms}</span><small>confirmation</small></div><div><span data-count="${attacks.control.charges}">${attacks.control.charges}</span><small>charge</small></div><div><span data-count="${attacks.control.credentials}">${attacks.control.credentials}</span><small>credential</small></div></div></article>
    <article class="attack spot" data-reveal><header><span class="num">Rule</span></header><h3>What a refusal means</h3><p class="threat">A refusal before the credential asks Airi for nothing. After it, the intent is cancelled before anything is confirmed. Anything Horos cannot prove stays held, never paid.</p><p class="note">Generated ${esc(day(attacks.generatedAt))} · <span class="mono">demo/attacks.json</span></p></article>
  </div>
</div></section>
${next('proof.html', 'See the proof')}
`,
);

// Proof
const proof = layout(
  'proof',
  'Proof · Horos',
  'What ran against the live sandbox, what Claude read, what is a replay, and what has not been run yet.',
  `
<section class="hero sub wrap">
  <div>
    <span class="eyebrow" data-intro>Proof</span>
    <h1>${lines('What is real,', '<em>and what is not yet.</em>')}</h1>
    <p class="lede" data-intro>Honesty has more than two states. Every item is labelled by where its evidence comes from. Nothing here claims a check that did not run.</p>
  </div>
  <aside class="panel" data-intro>
    <span class="eyebrow">Four kinds of evidence</span>
    <dl class="key">
      <dt>${chip('live')}</dt><dd>Run against the live Airwallex, Airi or T:0 sandbox, and recorded.</dd>
      <dt>${chip('recorded')}</dt><dd>A live call to Claude, saved with the exact email it read.</dd>
      <dt>${chip('replay')}</dt><dd>The real Horos commands against stand-in providers. Rerun it yourself.</dd>
      <dt>${chip('pending')}</dt><dd>Planned, and not claimed until it has run.</dd>
    </dl>
  </aside>
</section>
<section class="band" style="padding-top:60px"><div class="wrap ledger">
  <article class="entry spot" data-reveal>
    <div>${chip('live')}<p class="when" style="margin-top:14px">${esc(day(livePaid.at))}</p></div>
    <div><h3>The case, live: the USD 100 Slack bill</h3><p>The same bill as the case, end to end on the live sandboxes. A person verified and approved it; Claude read the bank-change email live and the policy held it; the approved checkout was refused before any credential; the person verified again; the old approval was refused as stale; a new approval and one passkey paid it once. The checkout is the team's <a class="link" href="checkout/slack.html">sandbox checkout standing in for Slack</a>, not Slack, and the email is one we wrote.</p>
      <ul class="checks">${live.steps.map((x: { step: string; refused?: string; state?: string }) => `<li><span aria-hidden="true">${x.refused ? '×' : '✓'}</span>${esc(x.step)}${x.refused ? `: <span class="mono">${esc(x.refused)}</span>` : x.state ? `: <span class="mono">${esc(x.state)}</span>` : ''}</li>`).join('')}</ul>
      <div class="ids"><code>${esc(livePaid.mandateId)}</code><code>${esc(livePaid.airwallex.paymentIntentId)}</code><code>${esc(livePaid.airwallex.status)}</code><code>attempt ${esc(liveSettled.latestAttempt.status)}</code><code>Airi ${esc(livePaid.airiResult.split(' ')[0])}</code></div><p class="links">${raw('slack-bill-live-2026-11-13.json')}</p></div>
    <div class="amount">${money(livePaid.airwallex.amount)}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('live')}<p class="when" style="margin-top:14px">${esc(day(vic.at))}</p></div>
    <div><h3>The first Visa Intelligent Commerce payment</h3><p>Invoice ${esc(vic.invoice)} paid at an Airwallex checkout with a single-use Airi ${esc(vic.airi.protocolType)} credential (${esc(vic.airi.tokenType)}), approved by passkey. Airi was told the result. Read back from Airwallex on ${esc(day(vicReadback.at))}: the payment attempt is ${esc(vicReadback.latestAttempt.status.toLowerCase())}.</p>
      <div class="ids"><code>${esc(vic.airi.mandateId)}</code><code>${esc(vic.airwallex.paymentIntentId)}</code><code>${esc(vic.airwallex.status)}</code><code>attempt ${esc(vicReadback.latestAttempt.status)}</code></div><p class="links">${raw('vic-payment-live-2026-11-10.json')} ${raw('vic-readback-2026-11-13.json')}</p></div>
    <div class="amount">${money(vic.airwallex.amount)}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('live')}<p class="when" style="margin-top:14px">${esc(day(issuing.startedAt))}</p></div>
    <div><h3>An issued card that asks Horos first</h3><p>Airwallex calls Horos on every authorization. The wallet moved by exactly the clearings Horos reconciled: USD ${money(issuing.wallet.totalDrop)} down, USD ${money(issuing.wallet.reconciledClearings)} reconciled.</p>
      <ul class="checks">${issuing.checks.map((c: { pass: boolean; check: string }) => `<li><span aria-hidden="true">${c.pass ? '✓' : '×'}</span>${esc(c.check)}</li>`).join('')}</ul>
      <p style="margin-top:16px;font-size:13px">On 3 of 8 recorded live runs, Airwallex logged MALFORMED_RESPONSE in 0 ms for one charge that never reached Horos. It was declined by default, and the check refuses to credit Horos. This is the latest run that completed cleanly.</p><p class="links">${raw('issuing-run-live-2026-11-11.json')}</p></div>
    <div class="amount">${passed}/${issuing.checks.length}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('live')}<p class="when" style="margin-top:14px">${esc(day(queue.at))}</p></div>
    <div><h3>The accounting queue, read from T:0</h3><p>Every bill for entity <span class="mono">${esc(queue.entity)}</span>, read only. ${queue.rows.length} open bills: two Dell bills held as possible duplicates, Slack bills waiting for a person because two vendor records share the name.</p><p class="links">${raw('t0-queue-live-2026-11-12.json')}</p></div>
    <div class="amount">${queue.rows.length}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('recorded')}<p class="when" style="margin-top:14px">${esc(day(readings[0].at))}</p></div>
    <div><h3>Claude's readings of three emails</h3><p>Live calls to <span class="mono">${esc(readings[0].model)}</span>, recorded with the email's SHA-256 so a replay can only use a reading of that exact email. ${tokens.toLocaleString('en-US')} tokens in total.</p>
      <div class="ids">${readings.map((r) => `<code>${esc(r.name)} → ${esc(JSON.parse(r.raw).kind)}</code>`).join('')}</div><p class="links">${readings.map((r) => raw(`emails/${r.name}.eml`, `${r.name}.eml`) + raw(`emails/${r.name}.reading.json`, 'reading')).join('')}</p></div>
    <div class="amount">${readings.length}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('recorded')}<p class="when" style="margin-top:14px">${esc(day(evaluation.generatedAt))}</p></div>
    <div><h3>Twelve emails, labelled before Claude read them</h3><p>Four ordinary receipts, four real changes to where payments go, four ambiguous messages. We wrote them and their expected outcome first, then Claude read each once and the policy decided. ${evaluation.summary.falseHolds} false holds, ${evaluation.summary.missedHolds} missed. The ${evaluation.summary.heldWithoutPattern} ambiguous ones were held on Claude's reading alone: no bank-detail pattern appears in them. A small set we wrote ourselves, not a measured error rate.</p>
      <table class="eval"><thead><tr><th>Email</th><th>Expected</th><th>Claude read</th><th>Decision</th></tr></thead><tbody>${evaluation.rows.map((r: { name: string; subject: string; expected: string; kind: string; outcome: string; agrees: boolean }) => `<tr><td>${esc(r.subject)}</td><td class="mono">${esc(r.expected)}</td><td class="mono">${esc(r.kind.replace(/_/g, ' ').toLowerCase())}</td><td><span class="chip ${r.outcome === 'HOLD' ? 'red' : 'green'}">${esc(r.outcome.toLowerCase())}</span>${r.agrees ? '' : ' <span class="chip amber">disagrees</span>'}</td></tr>`).join('')}</tbody></table>
      <p class="links">${raw('eval.json')}${raw('emails/eval/labels.json', 'labels.json')}</p></div>
    <div class="amount">${evaluation.summary.agree}/${evaluation.summary.emails}</div>
  </article>
  <article class="entry spot" data-reveal>
    <div>${chip('replay')}<p class="when" style="margin-top:14px">${esc(day(attacks.generatedAt))}</p></div>
    <div><h3>The case and eight attacks, replayed</h3><p>The real Horos commands against stand-ins for Airwallex, Airi and T:0. Counts come from the stand-ins' records. Anyone can rerun them with <span class="mono">npm run demo</span>.</p><p class="links">${raw('replay.json')}${raw('attacks.json')}</p></div>
    <div class="amount">${attacks.attacks.length + 1}</div>
  </article>
  <article class="entry pending" data-reveal>
    <div>${chip('pending')}</div>
    <div><h3>The payment record written back to T:0: not run yet</h3><p>Horos prepares exactly one record and will say “accepted by T:0, awaiting processing” only when T:0's acknowledgement counts that record. Confirmation after T:0's nightly processing waits on how T:0 exposes it.</p></div>
    <div class="amount">—</div>
  </article>
</div></section>
${next('how.html', 'How it works')}
`,
);

// How it works
const node = (x: number, y: number, w: number, title: string, sub: string, kind = '') =>
  `<g class="node ${kind}"><rect x="${x}" y="${y}" width="${w}" height="58" rx="12"/><text x="${x + 16}" y="${y + 25}">${title}</text><text class="sub" x="${x + 16}" y="${y + 43}">${sub}</text></g>`;
const how = layout(
  'how',
  'How it works · Horos',
  'AI understands the email. Deterministic code decides whether money moves.',
  `
<section class="hero sub wrap">
  <div>
    <span class="eyebrow" data-intro>How it works</span>
    <h1>${lines('AI understands.', '<em>Code decides.</em>')}</h1>
    <p class="lede" data-intro>Claude is the only part that reads language, and the only part that can never release money. Everything that lets a payment through is deterministic, journaled and re-checked at the moment of payment.</p>
  </div>
  <aside class="panel" data-intro>
    <span class="eyebrow">The one rule</span>
    <p class="serif" style="font-size:34px;line-height:1.1;margin:16px 0 18px">A model can add a reason to hold. It can never remove one.</p>
    <div class="chips"><span class="chip amber">claude reads</span><span class="chip green">policy decides</span><span class="chip green">executor re-checks</span><span class="chip">visa pays once</span></div>
  </aside>
</section>
<section class="band" style="padding-top:40px"><div class="wrap">
  <div class="flow" data-reveal>
    <svg viewBox="0 0 1100 420" role="img" aria-label="Supplier email to Claude to policy; T:0 bills to the queue; both into the ledger; the executor re-checks T:0 and pays through Airi and Airwallex; one record back to T:0.">
      <path class="wire" d="M190 79 C230 79 230 79 270 79"/><path class="pulse" d="M190 79 C230 79 230 79 270 79"/>
      <path class="wire" d="M440 79 C480 79 480 79 520 79"/>
      <path class="wire" d="M190 239 C350 239 380 239 520 239"/><path class="pulse" d="M190 239 C350 239 380 239 520 239"/>
      <path class="wire" d="M600 108 C600 150 600 180 600 210"/><path class="pulse red" d="M600 108 C600 150 600 180 600 210"/>
      <path class="wire" d="M690 239 C730 239 730 239 770 239"/><path class="pulse" d="M690 239 C730 239 730 239 770 239"/>
      <path class="wire" d="M940 225 C990 190 990 120 960 108"/>
      <path class="wire" d="M940 253 C990 290 990 340 960 352"/>
      <path class="wire" d="M855 268 C855 300 300 330 110 268" stroke-dasharray="4 6"/>
      ${node(20, 50, 170, 'Supplier email', 'untrusted text')}
      ${node(270, 50, 170, 'Claude', 'reads · quotes', 'ai')}
      ${node(520, 50, 170, 'Email policy', 'can only add holds', 'gate')}
      ${node(20, 210, 170, 'T:0 bills', 'every status')}
      ${node(520, 210, 170, 'Queue + ledger', 'one payment per bill', 'gate')}
      ${node(770, 210, 170, 'Executor', 're-reads T:0 ×3', 'gate')}
      ${node(790, 50, 170, 'Airi · Visa', 'single-use credential')}
      ${node(790, 330, 170, 'Airwallex', 'checkout · cards')}
      <text x="430" y="320" fill="#605d54" font-family="Geist Mono" font-size="11">one payment record back to T:0</text>
    </svg>
  </div>
</div></section>
<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>01</b> / the line</span><div><h2 data-reveal>Where the model <em>stops</em></h2></div></div>
  <div class="split">
    <article class="spot" data-reveal><span class="eyebrow" style="color:var(--amber)">Claude does</span><h3>Read and cite</h3><ul><li><b>Classifies</b> a supplier email: bank-detail change, routine, or unclear.</li><li><b>Quotes</b> the exact passage, which must appear in the email to count.</li><li><b>Explains</b> in one sentence for the AP lead.</li><li><b>Fails closed</b>: unreachable or unparseable means held.</li><li><b>Earns its place</b>: of ${evaluation.summary.emails} labelled emails, the ${evaluation.summary.heldWithoutPattern} ambiguous ones were caught by its reading alone.</li></ul></article>
    <article class="spot" data-reveal><span class="eyebrow" style="color:var(--green)">Code decides</span><h3>Everything that moves money</h3><ul><li><b>Holds</b> on bank-detail patterns whatever the model says: IBANs checked by their check digits.</li><li><b>Binds</b> each approval to amount, bill version, destination and receiving account.</li><li><b>Re-reads</b> T:0 before reserving and before confirming.</li><li><b>Reconciles</b> only from the provider's own records.</li></ul></article>
  </div>
</div></section>
<section class="band"><div class="wrap">
  <div class="band-head"><span class="index"><b>02</b> / invariants</span><div><h2 data-reveal>Rules the tests <em>enforce</em></h2><p data-reveal>${testCount} tests. Each fix was reverted until a named test failed.</p></div></div>
  <ol class="invariants">
    <li data-reveal><div><b>One bill, one payment</b><span>A single ledger reservation covers both rails. A second attempt is refused while the first is unresolved.</span></div></li>
    <li data-reveal><div><b>Unknown is not paid</b><span>A lost response or an unreadable provider leaves the bill unresolved, and an email still being read, or unreadable, holds it. Each case is a named test.</span></div></li>
    <li data-reveal><div><b>Approvals expire on change</b><span>A new bill version, destination, verification or receiving account makes the old approval stale.</span></div></li>
    <li data-reveal><div><b>Authority must outlast the call</b><span>The mandate and approval must have a minute left after the last read, or nothing is confirmed.</span></div></li>
    <li data-reveal><div><b>Duplicates stay held</b><span>A copy of the invoice Horos has once seen keeps the other held after it is paid, voided or dropped from T:0, until a person decides.</span></div></li>
    <li data-reveal><div><b>The books follow the provider</b><span>An accounting record is sent only when the provider settled exactly what was approved.</span></div></li>
  </ol>
</div></section>
<section class="cta wrap"><h2 data-reveal>See it <em>stop a payment.</em></h2><div class="actions" data-reveal><a class="btn" href="case.html">The case <span class="arrow">→</span></a><a class="btn ghost" href="index.html">Overview <span class="arrow">→</span></a></div></section>
`,
);

mkdirSync(`${OUT}/assets`, { recursive: true });
rmSync(`${OUT}/evidence`, { recursive: true, force: true });
cpSync(here('../evidence'), `${OUT}/evidence`, { recursive: true });
cpSync(here('./emails'), `${OUT}/evidence/emails`, { recursive: true });
for (const f of ['replay.json', 'attacks.json', 'eval.json']) copyFileSync(here(`./${f}`), `${OUT}/evidence/${f}`);
for (const f of ['site.css', 'site.js']) copyFileSync(here(`./site/${f}`), `${OUT}/assets/${f}`);
for (const [slug, html] of [['index', overview], ['case', casePage], ['judges', judges], ['proof', proof], ['how', how]] as const) writeFileSync(`${OUT}/${slug}.html`, html);

// The address a person verifies as where the live USD 100 Slack bill is paid. It is ours, and it says so: the payment
// is an Airwallex sandbox checkout on the team's own account, standing in for the supplier. Served from a subfolder,
// so links resolve from the site root.
const checkout = layout(
  'index',
  'Sandbox checkout · Horos',
  'The team-controlled Airwallex sandbox checkout that stands in for Slack Technologies, Inc. in the Horos demo. Not Slack.',
  `
<section class="hero sub wrap">
  <div>
    <span class="eyebrow">Checkout · stand-in for Slack Technologies, Inc.</span>
    <h1>${lines('A sandbox checkout,', '<em>not Slack.</em>')}</h1>
    <p class="lede">This address is the checkout a person verifies before Horos may pay the USD 100 T:0 sandbox bill INV-20250201-1234 from Slack Technologies, Inc. A payment made here is an Airwallex Payment Acceptance intent on the Horos team's own sandbox account, paid with a single-use Visa Intelligent Commerce credential from Airi. No real money moves, and nothing reaches Slack.</p>
    <div class="chips">${chip('live')}<span class="chip">sandbox only</span><span class="chip">team-controlled</span></div>
    <p class="lede" style="margin-top:28px"><a class="link" href="proof.html">What has run, and what has not →</a></p>
  </div>
</section>
`,
).replace('<head>\n', '<head>\n<base href="/">\n<meta name="robots" content="noindex">\n');
mkdirSync(`${OUT}/checkout`, { recursive: true });
writeFileSync(`${OUT}/checkout/slack.html`, checkout);
console.log(`saved ${OUT}: index, case, judges, proof, how (${testCount} tests counted)`);
