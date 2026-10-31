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

---

## Red Team Round 3 — authority boundaries and the analysis spend ceiling

**Base:** `main` @ `29a5d1d`
**Reproducible evidence:** `test/analysis-access.test.js`, `test/analysis-provider.test.js`

### Threat model

- The attacker CAN reach the HTTP API from one or more network source addresses and create sessions, because `POST /api/sessions` takes no credential by design.
- The attacker CANNOT read another session's access token, modify code, or control the provider's responses.
- The boundary at issue is between unrelated sessions sharing one deployment's paid-provider budget.

### Executive summary

| ID | Severity | Level | Module | Finding |
| --- | --- | --- | --- | --- |
| R3-1 | Medium | CONFIRMED BY INDUCTION | `src/analysis-access.js` | The shared hourly analysis spend ceiling could be drained from a single source by rotating freely minted sessions, denying paid analysis to every other session. |
| R3-2 | Low | CONFIRMED BY INDUCTION | `src/server.js` analysis path | Spend was charged for requests the provider never billed, so a provider outage became an hour-long lockout for all sessions. |
| R3-3 | Low | CODE FACT | test suite | The paid-analysis provider branch was unreachable in tests, so a defect on that path passed a fully green suite. |

### R3-1 — A free-to-mint principal drained the shared spend ceiling

**Severity:** Medium. **Epistemic level:** CONFIRMED BY INDUCTION. **Bucket:** software defect (availability). **Introduced by:** `ff2a571`, this project's own earlier commit.

**Abduction.** The limiter keyed its per-principal ceiling on `session:<sessionId>:<principalId>`. Session creation needs no credential, so the key is something the caller mints for free; only the global ceiling then stands between one caller and the whole hourly budget.

**Deduction.** Twenty calls per session times `ceil(120 / 20)` sessions reaches the global ceiling, after which an unrelated session's first ever analysis call is refused.

**Induction.** Executed against `29a5d1d`. An end-to-end probe first established the mechanism: `POST /api/sessions` with no `Authorization` header returned 201, and one analysis call from each of two unrelated sessions incremented the same `analysis:global` row while producing two independent per-session scopes. Driving it to the production limits then produced the predicted denial:

| | Calls | Sessions minted | `analysis:global` | Unrelated session's first call |
| --- | --- | --- | --- | --- |
| Before | 120 | 7 | 120 / 120 | **DENIED 429** |
| After | 40 | 3 | 40 / 120 | ALLOWED |

**Remediation applied.** A third ceiling keyed to the transport peer address, defaulting to 40 per hour, now bounds attempts from one source. The peer address is read from the socket rather than `X-Forwarded-For`, since a caller-supplied header would make the ceiling self-defeating.

**Stated limitation.** This raises the cost of the attack; it does not remove it. A caller with three or more source addresses still drains the global budget, and behind a reverse proxy every client shares the proxy's address, degrading the ceiling to one shared allowance. The global ceiling is deliberately retained as the spend guard of last resort: removing it to avoid the denial would trade a bounded outage for unbounded billing.

### R3-2 — Unbilled requests consumed spend

**Severity:** Low. **Epistemic level:** CONFIRMED BY INDUCTION. **Bucket:** software defect (availability).

The reservation was taken before the provider call and never returned, so a `502` from the provider still consumed the hourly budget. Observed directly: two calls against an unreachable provider left `analysis:global` at 2. On the limiter's own terms this is wrong, since a failed call bills nothing, and it converts a provider outage into an hour-long lockout for every session.

**Remediation applied.** The spend scopes are returned when the provider produced no answer, by transport error or non-2xx. The per-source attempt scope is deliberately *not* returned, so a failing provider cannot be used as free unbounded retries. A release is confined to the window its reservation was taken in, so an hour boundary crossed in between is a no-op rather than a negative counter.

### R3-3 — The provider branch was untestable, and that is how a defect shipped

**Severity:** Low. **Epistemic level:** CODE FACT. **Bucket:** test coverage.

The provider URL was hardcoded, so every test stopped at the unconfigured-key check and the branch past it was never executed. While fixing R3-2 a shadowed `const aiResponse` inside the new `try` block left the outer binding undefined; the suite stayed green at 33/33 because nothing reached that line. `OPENAI_BASE_URL` now overrides the provider origin, mirroring the existing `PAYPAL_BASE_URL`, and `test/analysis-provider.test.js` exercises both the failed and answered paths against a loopback double. The new test was verified to fail when the shadowing defect is reintroduced and to pass when it is removed.

### Discarded (non-exploitable) vectors

| Vector | Result | Why it failed |
| --- | --- | --- |
| Static file path traversal | FALSIFIED | Served paths must match an exact allowlist or a strict `assets/[A-Za-z0-9_-]+\.(png\|svg)` pattern, then pass a root-prefix check, `statSync().isFile()` and `realpathSync()` identity. Decoding happens before an exact-set membership test, so a crafted path only 404s. |
| Appending events after `SESSION_CLOSED_FINAL` to brick a ledger | FALSIFIED | `deriveLedger` throws when a final closure coexists with non-zero balances, and every event-log write path derives the post-state before committing. Enumerated all of them: `/events`, the four `/payments` routes, `/carry-debt`, `/evidence`, `/invitations`, and the expired-approval sweep. The invariant is a write barrier, not a read-time trap. |
| Hijacking an existing session by supplying `body.sessionId` | FALSIFIED | `sessions.id` is the primary key and its insert precedes the organizer-token insert, so a duplicate fails before any credential is issued. |
| Squatting session IDs a client would choose | FALSIFIED | The frontend never sends `sessionId` on creation; server-generated UUIDs are unpredictable. |
| Re-deriving a ledger under a changed base currency | FALSIFIED | No code path updates `sessions.base_currency` after creation. |
| Role escalation through an invitation | FALSIFIED | Invitations are organizer-only, the role is restricted to `member` or `witness`, and the member ID is server-generated. |
| Carrying one origin obligation into two sessions | FALSIFIED | The outbound event zeroes the origin obligation, so the second carry sees `originDue` of 0 and is refused for not matching the full amount. |
| Poisoning the origin session's idempotency namespace through `/carry-debt` | Not a defect | The caller must already present an organizer token for the origin session, so no authority boundary is crossed. |

### Recorded, not addressed

- An approval window that expires with no client retrying its idempotency key leaves the `SETTLEMENT_ASSERTED` claim counted against the obligation until a retry sweeps it. Fail-closed, but it blocks the PayPal rail for that pair for up to the TTL. Carried over from Round 2.
- The organizer may create a checkout on behalf of any member, which permits repeatedly reserving another member's obligation. The organizer is already trusted with the whole ledger, so this is a threat-model assumption rather than a defect, but it is the shape that would matter if a non-organizer role ever gained that capability.
