# Horos for judges

**One question to ask of it:** what does Horos do when an email asks it to move money it has already been told to pay?

**The answer:**

1. It records the email and holds the payment before reading it.
2. Claude reads it and quotes what it relied on.
3. A fixed policy decides.
4. The approved checkout is refused with no credential and no charge.
5. Only a person's new verification, and a new approval, releases it.

## Five-minute path

1. **[The case](https://horos-rosy.vercel.app/case.html)**: one bill, approved, then the bank-change email, the refused checkout, the release and the single payment: replayed, then run live on the same bill on 13 Nov. At the end, switch between three emails about the same bill to see what the rules caught, what only Claude caught, and what the checkout did.
2. **[Attacks](https://horos-rosy.vercel.app/judges.html)**: eight attempts to make Horos pay wrongly, with the counts.
3. **[Proof](https://horos-rosy.vercel.app/proof.html)**: what ran live, what is a recorded Claude reading, what is a replay, and what has not run. Every entry links to its raw file.
4. **Rerun it:** `npm install && npm test && npm run demo`, with no keys.

## The four judging areas

| Area | What Horos shows | Where to check |
|---|---|---|
| **Finance and product value:** an important finance problem for a clear user | The AP lead's moment of risk: a correct approval followed by a request to pay someone else. Horos holds every bill of that supplier (both vendor records that share the name), says why, and names the one action that releases it. An ordinary invoice email changes nothing. | [The case](https://horos-rosy.vercel.app/case.html); `test/email-flow.test.ts`; the controls in `demo/replay.json` |
| **Airwallex relevance and financial context:** Airwallex performs a meaningful financial action that context informs | **Payment Acceptance:** Airwallex takes the payment, and Horos confirms, cancels or reads it back. **Issuing remote authorization:** Airwallex asks Horos about every card authorization. **Context:** the T:0 bill, its history, the email and the approval decide whether either happens. | `evidence/slack-bill-live-2026-11-13.json` (the case live on one bill: held, refused, re-verified, paid once, USD 100); `evidence/vic-payment-live-2026-11-10.json` (USD 186.40, VIC via Airi) and `evidence/vic-readback-2026-11-13.json` (read back from Airwallex: settled); `evidence/issuing-run-live-2026-11-11.json` (15/15 checks, wallet drop equal to reconciled clearings) |
| **Agentic behaviour and controls:** the right next step, within permissions, with approvals and exceptions | **Claude:** reads and cites, and can only add holds. **Code:** decides, and binds each approval to amount, bill version, destination and receiving account. **Before confirming:** the executor re-reads T:0 and requires the mandate and approval to outlast the call. **People:** they release holds, decide exceptions, and cannot reopen a payment the provider shows succeeded. | [Attacks](https://horos-rosy.vercel.app/judges.html); `demo/attacks.json`; `src/email.ts`, `src/queue.ts`, `scripts/airi-pay.ts`, `src/settle.ts` |
| **Technical execution:** a reliable workflow with a clear resulting financial state | Every payment ends in one recorded state: PAID with the provider's settlement, OPEN only on proof that nothing moved, or held for a person. 239 tests; every fix was mutation-checked by reverting it until a named test failed. The whole demo is reproducible without keys. | `npm test`; `npm run demo`; `test/` |

## Rules we hold ourselves to

- Claude can add a reason to hold. It can never remove one, including by reading the same email again.
- An email cannot set a payee or approve a payment.
- An unknown outcome is not paid. An unreadable or unfinished email reading holds.
- Horos pays a bill at most once, across its rails. A payment made outside Horos is narrowed by re-reading T:0, not prevented.
- A refusal names its reason, and a held item names the person's next step.

## What is not claimed

The case ran live on the USD 100 Slack bill on 13 Nov (`evidence/slack-bill-live-2026-11-13.json`), with a test email we wrote, read live by Claude. Nothing has been written to T:0 yet. The supplier checkout is a team-controlled sandbox checkout standing in for Slack, not Slack. The 12-email evaluation is a small set we wrote and labelled ourselves. It shows behaviour; it does not measure an error rate. See "What is real" in the [README](README.md).
