# Security Audit — The Black Ledger

## Red Team Round 2 — PayPal capture evidence preservation

**Date:** 2026-10-31
**Method:** Abductive Engineering (A-D-I) + Red-Team Auditing
**Scope:** The PayPal order, capture and reconciliation path integrated in `67f7249`. The browser interface and the live PayPal Sandbox were not exercised.
**Base:** `main` @ `67f7249`
**Runtime:** Node 22.23.2
**Reproducible evidence:** `test/paypal-capture-evidence.test.js`

### Threat model

- The provider CAN return a `COMPLETED` capture whose `amount.currency_code` is outside this ledger's supported-currency table, or whose `amount.value` carries more decimal places than the currency's exponent allows.
- The provider CANNOT be assumed to have moved no money when it reports a completed capture.
- A ledger participant CANNOT shape the provider's capture response directly. This finding is a provider-behavior robustness defect, not a participant-reachable exploit.
- Nothing in this round assumes code modification, token theft, or transport compromise.

### Epistemic legend

CODE FACT - PLAUSIBLE HYPOTHESIS - CONFIRMED BY INDUCTION - FALSIFIED

### Executive summary

| ID | Severity | Level | Module | Finding |
| --- | --- | --- | --- | --- |
| R2-1 | Medium | CONFIRMED BY INDUCTION | `src/server.js` capture path | A completed capture whose amount the ledger cannot parse was discarded instead of preserved, leaving money moved at the provider with no record in the reconciliation inbox and no operator warning. |

### R2-1 — An uninterpretable provider capture was discarded, not preserved

**Severity:** Medium. **Epistemic level:** CONFIRMED BY INDUCTION. **Bucket:** software defect (invariant violation under a stated provider-behavior assumption).

**Invariant violated.** The reconciliation inbox shipped with its own acceptance check: *"Provider evidence is persisted before financial posting."* That property did not hold for the input class below.

**Surprise.** The capture path validates a currency mismatch explicitly:

```js
|| payment.amount?.currency_code !== session.base_currency) { markReconciliationRequired(...) }
```

so the design admits an unexpected capture currency is possible. But `parseAmountToMinor` ran three lines earlier and throws on any currency outside the supported table. The mismatch handler was therefore unreachable for exactly the most anomalous inputs — the code declared a defense it could not execute.

**Abduction.** Rival explanations, ranked by cost to test:

1. The parse throws before `preserveCapturedPayment`, so the evidence write never runs. Cheapest to test.
2. The parse is unreachable because the capture currency always equals the order currency, making this hygiene only.

**Deduction.** If (1) holds, a `COMPLETED` capture reported with currency `XYZ` leaves no row in `paypal_reconciliations`, leaves `paypal_orders.status` at `created`, shows nothing in the organizer tray, and permits a retry that calls the provider again. A supported-currency mismatch in the same run must still be preserved — the negative control.

**Induction.** Executed against `67f7249` with the loopback provider double. Prediction held in full:

| Arm | Provider called | HTTP | `paypal_reconciliations` | `paypal_orders.status` | Tray | Retry re-calls provider |
| --- | --- | --- | --- | --- | --- | --- |
| Control: `USD 6.00` (amount mismatch) | yes | 202 | row, `pending` | `reconciliation_required` | 1 | no |
| Arm A: `XYZ 5.00` | yes | 400 | **no row** | `created` | 0 | **yes** |
| Arm B: `USD 5.001` | yes | 400 | **no row** | `created` | 0 | **yes** |

Server `stderr` was empty in both failing arms: the operator received no warning either. Hypothesis (2) is FALSIFIED — the branch is reachable from provider output alone.

**Causal chain.**

```
provider returns COMPLETED capture, currency or precision outside the supported table
    -> parseAmountToMinor throws, one line before preserveCapturedPayment
    -> no row in paypal_reconciliations; paypal_orders.status stays 'created'
    -> organizer tray empty, stderr silent
    -> retry permitted -> provider called again, same outcome, indefinitely
```

**What this is not.** Balances were never wrong in any arm: no settlement was posted and the debtor stayed at `-500`. The defect destroys the record of money that moved; it does not misstate the ledger. Calling it a loss-of-funds vulnerability would overstate it.

**Remediation applied.** The amount is now interpreted only after the provider's claim is persisted. The raw `provider_amount_value`, `provider_currency` and `parse_error` are stored alongside the parsed value and surfaced in the organizer tray; the capture is marked `reconciliation_required` so a retry cannot re-call the provider; the boundary logs a warning naming the raw claim; and `POST /payments/:id/reconcile` refuses to post a capture carrying a `parse_error` rather than interpreting it. Post-fix, all three arms behave as the control and still post zero settlements.

### Discarded (non-exploitable) vectors

| Vector | Result | Why it failed |
| --- | --- | --- |
| Concurrent capture of one order | FALSIFIED | The provider request ID is derived from the order, and the confirmation append is idempotent on the capture ID. One confirmation is posted. |
| Cancel racing an in-flight capture | FALSIFIED | The cancel event leaves the settlement non-`pending`, so `orderClaim` is absent and the capture routes to the reconciliation inbox. Fail-closed. |
| Supported-but-different capture currency (for example `EUR` on a `USD` session) | FALSIFIED | `parseAmountToMinor` succeeds, the claim is preserved, and the explicit currency-mismatch guard routes it to reconciliation as designed. |
| Organizer posting an uninterpretable capture after the fix | FALSIFIED | `reconcile` refuses on `parse_error` and zero settlements are posted. |
| Organizer creating or capturing another member's order | Not a defect | The role check constrains members only, by design; the organizer must still fund the real approval at the provider. |

### Recorded, not addressed in this round

- An approval window that expires without any client retrying the same idempotency key leaves its `SETTLEMENT_ASSERTED` claim counted against the obligation, blocking that amount until a retry sweeps it. Fail-closed but a liveness gap; a sweep on read would close it.
- The live PayPal Sandbox has not been exercised. Every result above comes from the loopback double, so provider-response shapes beyond those modelled remain unverified.
