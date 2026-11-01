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

---

## Closure — the carried-over liveness gap

**Base:** `main` @ `fcd1dd4`
**Reproducible evidence:** `test/paypal-approval-expiry.test.js`

Rounds 2 and 3 both recorded, without addressing it, that an approval window expiring with no client retrying its idempotency key left the `SETTLEMENT_ASSERTED` claim reserving the obligation. It is now confirmed and closed.

**Epistemic level:** CONFIRMED BY INDUCTION. **Bucket:** software defect (availability). **Severity:** Low — no balance was ever wrong, and the refusal was fail-closed.

**Deduction.** A claim is a ledger event, and events do not expire. The expiry that existed ran only inside the branch handling a repeated idempotency key, so a buyer who starts a checkout and never approves it blocks that debtor-creditor pair from the PayPal rail, and only a retry with the very same key — which nobody has a reason to send — clears it.

**Induction.** Executed against `fcd1dd4`. A checkout was created and abandoned, its approval window backdated 24 hours, and a fresh checkout attempted under a new key:

| | New checkout after the window died |
| --- | --- |
| Before | **409**, `availableMinor: 0`, while the debtor genuinely owed 500 |
| After | **201**, a replacement order |

**Remediation applied.** Stale approvals are swept before the obligation is measured, writing the same expiry event the retry path writes under the same idempotency key, so the two paths cannot double-record an expiry. A live approval still reserves the obligation — verified as a negative control in the same run. The sweep is wrapped so that a failure warns at the boundary and leaves the request behaving exactly as it did before, rather than failing a checkout because an optional cleanup could not run.

The test was checked against the previous implementation and fails there with the 409 above.

### Still open after this round

- The browser was exercised for the first time in this session and found the organizer reconciliation inbox rendering nothing, fixed in `fab69c2`. Narrow-viewport layout remains unverified: programmatic resize is ignored by the window manager while the browser window is maximized.
- The live PayPal Sandbox has still not been exercised. Every payment result in this document comes from a loopback double, so provider response shapes beyond those modelled remain unverified — including the premise of R2-1, that a provider can return a capture in a currency outside the supported table.

---

## Live PayPal Sandbox exercise — 2026-11-01

**Base:** `main` @ `ad65842`
**Scope:** The first end-to-end run of the payment path against the real PayPal Sandbox, rather than the loopback double every earlier result in this document came from.

Order `10D056488K241574M`, capture `4SH52176MC5695524`, USD 5.00, sandbox business payee `W5TDJ2MZBBETL`.

### Confirmed against the real provider

| Property | Result |
| --- | --- |
| Client-credentials authentication | 200 |
| Order creation, with the configured merchant as payee | 201, and `payee.merchant_id` in the capture matches the configured value |
| Buyer approval and capture | `COMPLETED`, settlement posted, debtor balance cleared to 0 |
| Capture idempotency | A repeated capture returned the recorded one with `alreadyRecorded`, one confirmation in the chain, no second charge |
| Capture amount shape | `{"currency_code": "USD", "value": "5.00"}` — the two-decimal form the parser assumes |
| Provider timestamp | `create_time` preserved verbatim into the event's `at` |

The reconciliation inbox stayed empty, which is the correct outcome for a capture that matches its obligation.

### Observed: the provider's fee appears in the capture, not in the ledger

The capture's `seller_receivable_breakdown` reports `gross_amount` 5.00, `paypal_fee` 0.57, `net_amount` 4.43. The ledger records the settlement at 5.00 and discharges the obligation.

That is correct, and is not a gap. The ledger's subject is obligations between the participants of a journey: the debtor owed 5.00 and paid 5.00, so the debt is settled. The fee is a cost between the creditor and PayPal, a counterparty who is not in the ledger, in the same way a wire fee would be. Recording it would introduce a non-participant into a record whose whole structure is participant-to-participant, and anyone choosing to settle through PayPal already knows PayPal charges.

It is written down here only as part of the observed response shape, which earlier rounds could not see because the loopback double did not model it.

### Still unverified

R2-1 rests on the premise that a provider can return a completed capture whose currency is outside the supported table, or whose precision exceeds it. This run observed one capture, in the normal shape, and so neither confirms nor refutes that premise. The remediation stands on its own as defensive handling of an input the code's own currency-mismatch guard already anticipated, but the triggering scenario remains a modelled assumption rather than an observed provider behaviour, and is labelled as such.

---

## Variant analysis — the dead-surface class

**Base:** `main` @ `c4f058a`
**Lead:** the organizer reconciliation inbox rendering nothing, fixed in `fab69c2`.

### The invariant, not the symptom

The client keeps two state origins. The derived ledger is a pure function of the event log; the server's `publicState` additionally carries fields held outside that log, in tables of their own. Both are plain objects with overlapping key names, nothing marks which origin owns which field, and a read from the wrong one yields `undefined`, which renders as an empty panel rather than an error.

Stated once: **a render surface read its data from a source structurally incapable of producing it, and the miss degraded silently to empty instead of failing.**

### Sweep

Four axes, each enumerated rather than sampled. Hits and no-hits both recorded.

| Axis | Method | Result |
| --- | --- | --- |
| Fields read off the derived ledger | all 20 `current.<field>` reads in the client against the key set `deriveLedger` actually returns at runtime | no further misses |
| Fields read off the server state | every `getServerState().<field>` read against `publicState`'s keys | one read, `paymentReconciliations`, which the server does expose |
| Shape confusion within a valid field | every `current.<field>.<method>` against each field's real runtime type, looking for a `Map` used as an array or the reverse | none |
| Fields read off HTTP responses | every variable bound from a `.json()` against the keys any `send()` can emit | none; the apparent misses were same-named DOM and `FormData` variables in other scopes |

One candidate was examined and dismissed: `narrativeEvents` is exposed by the server and is not in the derived ledger, but the client imports `deriveNarrativeEvents` and computes it locally, so no surface reads it from the wrong origin.

### Attacking the fix

`fab69c2` makes the inbox render; it does not stop the class recurring. The next non-derivable field added to `publicState` and read off the derived ledger reproduces the defect exactly, with the same silent failure, because nothing enforces the boundary. The fix was at the symptom's layer, not the invariant's.

The derived ledger is now returned behind a proxy that warns when a surface reads a known server-only field from it, naming the field and where it actually lives. Verified both ways in the browser: reintroducing the original defect produces the warning on load, and the corrected code produces none.

This converts a class that fails invisibly into one that announces itself. It warns rather than throws, so a diagnostic can never take down a ledger.

### Blast radius and severity

Every organizer whose capture could not be posted, from the v5 integration in `67f7249` until `fab69c2` — the inbox was invisible to all of them, with no error anywhere. The code is not published as a library, so nothing downstream consumes it.

This is a functional defect, not a security finding: no authority boundary was crossed, no balance was wrong, and the failure mode is a feature that cannot be reached. Anchoring it to a security advisory for severity would overstate what it is.

---

## Narrow-viewport review — 2026-11-01

The last of the four visual checks the integration notes left unperformed. Earlier attempts failed because the window manager ignores programmatic resizing; rendering the app inside a 390px iframe gives a genuine mobile viewport, since media queries evaluate against the iframe rather than the window.

**Checked:** the ledger, expenses, history, participants, verdict and settlement pages at 390px. No page scrolled horizontally, and no element overflowed its container on any of them.

**Found and fixed.** The reconciliation row kept its three-column desktop layout at 390px. The row is a flex container whose text column carries `min-width: 0`, so it shrank instead of wrapping while the button held its width: 93px for the whole record against 161px for the button, leaving the reason wrapped into eight lines beside a large empty space. The text column now takes the full row and the button moves to its own line below it, which brought the text from 93px to 265px. The same squeeze applied to the one other row type that carries a button, so the rule covers both rather than only the row where it was spotted.

Separately, the ledger-export control was a 16px-tall touch target, under the 24px minimum. It now has a 44px target on small screens with no change to how it reads.

**Not a defect:** the participant checkboxes measure 13px but sit inside labels with a 67 by 37px target, and the remaining buttons are 37px — above the minimum, under the 44px comfort guideline. Recorded rather than changed.

Desktop layout verified unchanged at 1920px after the fix.
