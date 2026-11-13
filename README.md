<div align="center">

<img src="assets/cover.png" alt="An email asked to move the money. Horos stopped it." width="100%" />

&nbsp;

[![CI](https://github.com/Cassxbt/horos/actions/workflows/ci.yml/badge.svg)](https://github.com/Cassxbt/horos/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-237%20passing-74dbb0)
![Airwallex](https://img.shields.io/badge/Airwallex-Issuing%20%C2%B7%20Payment%20Acceptance-e9b44c)
![Visa](https://img.shields.io/badge/Visa%20Intelligent%20Commerce-via%20Airi-e9b44c)
![Claude](https://img.shields.io/badge/Claude-opus--5.5-ece7da)
[![Live](https://img.shields.io/badge/live-horos--rosy.vercel.app-74dbb0)](https://horos-rosy.vercel.app)

### Approve once. Re-check when the money moves. An email can stop a payment, never send one.

Supplier bank-change fraud works **after** the approval. The invoice is real and a person approved it correctly. Then an email "from the supplier" asks for this and all future payments to go to a new account. Most AP tools answer one question: *was this invoice approved?* Horos answers the harder one: **is everything the approval rested on still true at the moment of payment?**

**[ Live site ↗ ](https://horos-rosy.vercel.app)** · **[ The case ↗ ](https://horos-rosy.vercel.app/case.html)** · **[ Attacks ↗ ](https://horos-rosy.vercel.app/judges.html)** · **[ Proof ↗ ](https://horos-rosy.vercel.app/proof.html)** · **[ Judge it in 90 seconds ](#judge-it-in-90-seconds)** · **[ hackathon.md ](hackathon.md)**

</div>

## ▶ Demo

Video: link added at submission.

> A USD 100 Slack bill is verified and approved. Then an email arrives asking to send it, and all future payments, to a new account. Claude reads it and quotes the sentence; a fixed policy holds every bill from that supplier; the approved checkout is refused with no card credential issued. A person re-verifies the supplier through a contact they already trust and approves again, and the bill is paid once, through Airwallex, with a single-use Visa credential from Airi.

## Contents

- [The problem I set out to solve](#the-problem-i-set-out-to-solve)
- [What Horos does](#what-horos-does)
- [Judge it in 90 seconds](#judge-it-in-90-seconds)
- [Live sandbox proof](#live-sandbox-proof)
- [Architecture](#architecture)
- [How Horos uses Airwallex, Visa, T:0 and Claude](#how-horos-uses-airwallex-visa-t0-and-claude)
- [Success and refusal](#success-and-refusal)
- [What Claude adds over rules](#what-claude-adds-over-rules)
- [The refusal vocabulary](#the-refusal-vocabulary)
- [Engineering decisions](#engineering-decisions)
- [What's real vs pending: the honesty table](#whats-real-vs-pending-the-honesty-table)
- [Run it live](#run-it-live) · [Tests](#tests) · [Layout](#layout)

## The problem I set out to solve

An approval is a decision made once, about facts that keep moving. Between approval and payment the bill can be paid elsewhere, a duplicate can turn up, the mandate can expire, and the supplier's "new bank details" can arrive by email. A payment agent that only checks *approved: yes* will faithfully pay the fraudster.

So I treated **"the facts behind the approval changed"** as a first-class state, next to approved and paid. The model's job is narrow: read the unstructured evidence, the supplier's email, and say what it asks for, in its own quoted words. Code decides what that means. Only a person can release a hold.

## What Horos does

1. **Import.** Reads every bill for the entity from T:0, open or already paid. Possible duplicates, and bills whose vendor name is shared by two vendor records, go to a person.
2. **Verify, then approve.** A person verifies who the bill pays and through which checkout, then approves exactly what Horos shows. The approval binds the amount, the bill version, the verified destination and the Airwallex account that receives the money.
3. **Read the email.** `scripts/email.ts` records the email as pending, and holding payment, *before* Claude reads it. Claude classifies it and must quote the passage it relied on; the quote must appear in the email. Bank-detail patterns hold whatever the model says. Claude can add a reason to hold and can never remove one: once any reading of an email holds, no later or concurrent reading of it releases the hold.
4. **Re-check.** `scripts/airi-pay.ts` re-reads T:0 three times: at the start, after the passkey, and just before confirming. It refuses if anything the approval rested on changed, and requires the mandate and the approval to outlast the confirm call.
5. **Pay once.** Confirms one Airwallex checkout with a single-use Visa Intelligent Commerce credential from Airi. Horos pays a bill at most once, across both of its rails.
6. **Book.** The paid bill owes T:0 exactly one payment record, sent only when the provider settled exactly what was approved.

## Judge it in 90 seconds

**In the browser.** Open [the case](https://horos-rosy.vercel.app/case.html) and scroll to *Same bill, three emails*. Switch between a routine notice, an unclear forward and a bank change for the same approved bill. Each shows which rules fired, what Claude read, and how many confirmations the checkout sent.

**On your machine, no keys:**

```bash
git clone https://github.com/Cassxbt/horos && cd horos
npm install
npm test        # 237 tests, about a minute
npm run demo    # replays the case, 8 attacks and a 12-email evaluation, then rebuilds site/
```

`npm run demo` runs the real Horos commands against stand-ins for Airwallex, Airi and T:0, using Claude readings recorded from live calls. It writes `demo/replay.json`, `demo/attacks.json` and `demo/eval.json`, rebuilds every page of the site from them, and fails if any evaluation email disagrees with its label. [CI](https://github.com/Cassxbt/horos/actions/workflows/ci.yml) runs the typecheck, the tests and the demo on every push.

## Live sandbox proof

```bash
curl -s https://horos-rosy.vercel.app/evidence/vic-readback-2026-11-13.json
# "invoice": "INV-4417", "status": "SUCCEEDED", "amount": 186.4, "currency": "USD",
# "latestAttempt": { "id": "att_sgpvdzck4ho13kioxtt_ki6bak", "status": "SETTLED" }
```

| Run | What happened | Evidence |
|---|---|---|
| **Visa Intelligent Commerce payment**, INV-4417, USD 186.40 | Airi mandate `mdt_nlpdhwf6cho13dzi0y0` (VIC, DPAN) confirmed Airwallex intent `int_sgpvdzck4ho13ki6bak`; SUCCEEDED reported to Airi. Read back from Airwallex on 13 Nov: **settled**. | [`vic-payment-live-2026-11-10.json`](evidence/vic-payment-live-2026-11-10.json) · [`vic-readback-2026-11-13.json`](evidence/vic-readback-2026-11-13.json) |
| **Issued card, Horos answering remote authorization** | 15 of 15 checks. Horos declined the lookalike merchant and the over-invoice amount at authorization; the wallet's drop equals the reconciled clearings. | [`issuing-run-live-2026-11-11.json`](evidence/issuing-run-live-2026-11-11.json) |
| **T:0 queue**, read-only | 8 open bills triaged from the live T:0 sandbox, including the USD 100 Slack bill in the case. | [`t0-queue-live-2026-11-12.json`](evidence/t0-queue-live-2026-11-12.json) |

## Architecture

```mermaid
flowchart LR
  subgraph Evidence
    T0[(T:0 bills and vendors)]
    Mail[Supplier email] --> Claude[Claude reads and quotes]
  end
  subgraph Decision["Decision, in code"]
    Policy[Fixed policy and bank-detail rules]
    Queue[Queue and ledger: holds, approvals, one reservation per bill]
  end
  subgraph Person
    Verify[Verify supplier and checkout] --> Approve[Approve the exact payment]
    Passkey[Passkey on the Airi mandate]
  end
  subgraph Money
    Airi[Airi: single-use VIC credential] --> PA[Airwallex checkout: confirm, cancel, read back]
    Issuing[Airwallex Issuing: remote authorization]
  end
  T0 --> Queue
  Claude --> Policy --> Queue
  Approve --> Queue
  Queue -- re-reads T:0 three times --> Airi
  Passkey --> Airi
  Queue --> Issuing
  PA -- settlement --> Book[One payment record owed to T:0]
```

Authority narrows at every hop. Claude can only add a hold. The policy cannot set a payee. The executor pays only what a person approved, to the destination a person verified, while T:0 still says the bill is owed.

## How Horos uses Airwallex, Visa, T:0 and Claude

| Sponsor | Calls Horos makes | Role in the critical path | Without it |
|---|---|---|---|
| **Airwallex Payment Acceptance** | `POST /pa/payment_intents/create`, `…/{id}/confirm`, `…/{id}/cancel`, `GET /pa/payment_intents/{id}` (`src/airwallex.ts`, `src/vic.ts`) | The supplier checkout Horos confirms, cancels when the final check fails, and reads back to settle | No payment to finalize or verify |
| **Airwallex Issuing**, remote authorization | `POST /issuing/cards/create`, `/issuing/config/update`, `GET /issuing/transactions`; Airwallex calls Horos's signed endpoint on every authorization (`src/server.ts`, `src/authorize.ts`, `src/reconcile.ts`) | Horos decides each card authorization itself and reconciles only from Airwallex's clearings | No live decision at the card network |
| **Visa Intelligent Commerce via Airi** | `airi-cli mandate create`, `get-credential`, `result` (`scripts/airi-pay.ts`) | A passkey-approved, single-use credential for one mandate, which must match the approval: merchant, path, amount, expiry and digest | No agent-safe card credential |
| **T:0** | `GET /v1/vendor-bills`, `GET /v1/payments`, `POST /v1/records` (`src/t0.ts`, `src/accounting.ts`) | The accounting system of record, read fresh before each payment and owed one payment record back | No source of truth to re-check |
| **Claude** (`claude-opus-5-5`) | Messages API with JSON schema output (`src/email.ts`) | Reads supplier emails as untrusted data and cites the passage it relied on | Ambiguous emails go unseen |

## Success and refusal

From [`demo/attacks.json`](demo/attacks.json), regenerated by `npm run demo`. The counts come from the stand-in providers' own records.

| Attack | Horos | Confirms / charges |
|---|---|---|
| Supplier email asks to move the money, after approval | `BILL_HOLD_FOR_REVIEW` | 0 / 0 |
| Claude is persuaded the email is routine (the IBAN is still in it) | `BILL_HOLD_FOR_REVIEW` | 0 / 0 |
| Bill paid elsewhere in T:0 while the passkey prompt is open | `ELIGIBILITY_CHANGED:BILL_WITHDRAWN` | 0 / 0 |
| Duplicate copy of the invoice paid first | `BILL_HOLD_FOR_REVIEW` | 0 / 0 |
| Mandate expires during the last read before confirming | intent cancelled, `MANDATE_EXPIRED` | 0 / 0 |
| Operator tries to retry a payment whose acknowledgement was lost | reopen refused, second mandate refused | 1 / 1, the original only |
| Mandate for another path on the verified host | `MERCHANT_URL_NOT_VERIFIED_DESTINATION` | 0 / 0 |
| Old approval used after the destination was re-verified | `APPROVAL_STALE` | 0 / 0 |
| **Control:** nothing wrong | `PAID` | 1 / 1 |

## What Claude adds over rules

| | |
|---|---|
| **12 / 12** | labelled emails where Horos's decision matches the label written before any model read them |
| **4 / 4** | ordinary receipts noted, not held, including "ACH cleared" and "wire arrived" |
| **4 / 4** | real changes of destination held: an IBAN, US routing numbers, a new payment link, and a change with no numbers at all |
| **4 / 4** | ambiguous emails held on Claude's reading alone, with no bank-detail pattern in them |

From [`demo/eval.json`](demo/eval.json): four ordinary receipts, four real changes of destination and four ambiguous messages, each read once by `claude-opus-5-5` and recorded beside the email. The bank-change email in the case also trips the rules. The forward that only asks *who to speak to about where the payment goes* is caught by Claude alone. That is the case for the model.

## The refusal vocabulary

Every refusal is a code, and every held bill names the person's next step. An operator, or another agent, branches on the code.

| Stage | Codes |
|---|---|
| Email | `BANK_DETAILS_CHANGE_CLAIMED` · `BANK_DETAIL_SIGNALS` · `PAYMENT_METHOD_CHANGE` · `REMIT_ELSEWHERE` · `UNCLEAR` · `PASSAGE_NOT_IN_EMAIL` · `MODEL_OUTPUT_INVALID` · `READING_IN_PROGRESS` |
| Queue | `EXACT_DUPLICATE` · `POSSIBLE_DUPLICATE` · `VENDOR_NAME_SHARED` · `CHANGED_IN_SOURCE` · `SOURCE_CONFLICT` · `NOT_IN_LATEST_IMPORT` · `NEEDS_VENDOR_VERIFICATION` |
| Payment | `BILL_HOLD_FOR_REVIEW` · `ELIGIBILITY_CHANGED:*` · `APPROVAL_STALE` · `APPROVAL_ALREADY_USED` · `MANDATE_DOES_NOT_MATCH_APPROVAL` · `MERCHANT_URL_NOT_VERIFIED_DESTINATION` · `MANDATE_EXPIRED` |
| Card authorization | `MERCHANT_MISMATCH` · `MCC_MISMATCH` · `AMOUNT_EXCEEDS_APPROVAL` · `CLEARED_TO_OTHER_MERCHANT` · `CLEARED_ABOVE_APPROVAL` |
| Books | `NO_PROVIDER_SETTLEMENT` · `SETTLEMENT_IS_ANOTHER_PAYMENT` · `SENT_UNACKNOWLEDGED` |

## Engineering decisions

**Hold before reading.** The email is on record, holding payment, before Claude is asked. A payment started while Claude reads, a crash or a slow answer all meet the hold.

**A hold is latched.** Each reading resolves only its own pending record. A second reading of the same email that calls it routine cannot release the first one's hold, whichever finishes first. Only a person's verification made after the email releases it, and that verification invalidates the old approval.

**Unknown is not paid.** A payment whose outcome is unknown stays unknown until the provider proves it either way. A person can reopen a bill only on proof that nothing moved, and never one the provider shows succeeded.

**Re-read the source, not a cache.** The executor re-reads T:0 at the start, after the passkey and just before confirming. The mandate and the approval must outlast the confirm call itself.

**Book only what settled.** The T:0 entry is built from the provider's settlement, compared field by field with the approval, and sent once. A lost acknowledgement is recorded as `SENT_UNACKNOWLEDGED`, never retried blind.

**Every fix is mutation-checked.** Each fix was reverted until a named test failed.

## What's real vs pending: the honesty table

| Capability | Status |
|---|---|
| Visa Intelligent Commerce payment through Airi and Airwallex | **Real.** Live sandbox, INV-4417, USD 186.40, settled. |
| Issued card with Horos answering remote authorization | **Real.** Live sandbox, 15/15 checks. |
| T:0 bill and vendor reads | **Real.** Live sandbox, read-only. |
| Claude's email readings | **Real.** Recorded live calls, replayed with no key. |
| The case, attacks and evaluation | **Replay** of the real commands on stand-in providers. The supplier checkout is a team-controlled sandbox checkout standing in for Slack. |
| USD 100 Slack bill paid live | **Not run yet.** Waits for a person's verification and one passkey checkout. |
| Payment record written to T:0 | **Not run yet.** Built and tested; waits on T:0's write contract. |

**Limits.**

- The 12-email evaluation is a small set we wrote and labelled ourselves. It shows behaviour; it does not measure an error rate.
- On 3 of 8 recorded live issuing runs, Airwallex logged `MALFORMED_RESPONSE` in 0 ms for one charge that never reached Horos. The charge was declined by default, and the check refuses to credit Horos.
- Re-reading T:0 just before confirming narrows the race with a payment made outside Horos. It cannot close it.
- Email intake is an operator-chosen file and bill. Attachments, HTML mail and other languages are untested.

## Run it live

Copy `.env.example` to `.env` and fill in the sandbox keys. Every command runs from this folder as `node --env-file=.env scripts/<file>.ts …` and prints its usage when run without arguments.

| Command | What it does |
|---|---|
| `horos.ts doctor` | Read-only health check of Airwallex, the cardholder, remote auth and the Airi session |
| `horos.ts run <https tunnel>` | The issuing-rail scenario on the live sandbox, with remote auth answered by Horos (for example via `ngrok http 8787`) |
| `queue.ts import` · `show` · `verify` | Reads T:0, prints the queue, records a person's verification |
| `email.ts read --bill <id> --file <email>` | Claude reads a supplier email; the policy holds or notes it |
| `airi-pay.ts approve --bill <id>` · `pay <mandate> --bill <id>` · `reconcile` | Preview and approve, pay once, settle anything interrupted |
| `horos.ts reconcile` · `resolve` · `cleanup` | Recovery from Airwallex's records; a person's decision on an exception |
| `accounting.ts status` · `sync --bill <id>` | The payment record owed to T:0 (writes need `T0_WRITE_ENABLED=1`) |

## Tests

237 tests, run in [CI](https://github.com/Cassxbt/horos/actions/workflows/ci.yml) on every push, against in-process stand-ins for Airwallex, Airi and T:0. They mirror the claims above.

| Area | Tests | What they hold to |
|---|---:|---|
| Issuing run, end to end | 42 | A clean run pays once; a decline closes the card with no retry; a stop signal starts nothing new and closes every card |
| Card authorization, signed endpoint, reconciliation | 55 | Lookalike merchants refused at the invoice amount; unsigned or replayed requests refused; paid only when the approved lifecycle cleared exactly |
| Bills and the queue | 44 | A bill paid elsewhere is caught before the passkey, before reserving and before confirming; duplicates across every bill ever seen; shared vendor names never pick a payee |
| Recovery and the ledger | 41 | Five processes racing for one bill: exactly one wins; an unknown payment blocks every rail until reconciled; state survives a restart |
| Payment policy and the Visa mandate | 27 | A new IBAN or a bank-change claim holds; every mismatch between the passkey-approved mandate and the approval is refused |
| Supplier email | 16 | Held before reading; holds latched across rereads and concurrent readers; quotes checked against the email; Claude unreachable holds |
| Books | 12 | One exact record per paid bill; a lost acknowledgement, a race or a delay never sends a second |

## Layout

```
src/        policy, ledger, queue, email, executor helpers, provider clients
scripts/    the commands above
test/       237 tests; stand-ins for Airwallex, Airi and T:0 in test/fixtures
demo/       replay, attacks, email evaluation, site generator, demo emails
evidence/   records of the live sandbox runs
assets/     the cover image
site/       the generated judge site (deployed to Vercel)
```

Built by [cassxbt](https://x.com/cassxbt) for the **Airwallex Agentic Banking Hackathon**, 2026. The four judging areas, mapped to evidence: [hackathon.md](hackathon.md).
