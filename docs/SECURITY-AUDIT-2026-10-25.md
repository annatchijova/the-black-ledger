# Security Audit — The Black Ledger

## Red Team Round 2: authorization and state invariants

**Date:** 2026-10-25
**Base:** `main` at `94dfdb4` (before the fix in this change)
**Scope:** API event authorization, participant lifecycle, write access, ledger reactivation, expense dispute authorization, and recipient privacy for confidential gift descriptions. PayPal and OpenAI provider calls were not exercised.
**Reproduction:** `npm test` runs `test/security.test.js` against an isolated SQLite database.

## Threat model

- An attacker has a valid token for an active participant in a shared session and can submit arbitrary event JSON to that session's API.
- The attacker does not have the organizer token, the departed participant's token, server credentials, or direct access to the SQLite database.
- The audit does not model a compromised server, stolen organizer token, or provider account.

## Epistemic legend

**CODE FACT** means visible in source. **PLAUSIBLE HYPOTHESIS** means a reasoned but unexecuted concern. **CONFIRMED BY INDUCTION** means the stated experiment was run. **FALSIFIED** means an experiment did not reproduce the predicted effect.

## Executive summary

| ID | Severity | Level | Bucket | Finding |
|---|---|---|---|---|
| BL-RT-001 | Medium | Confirmed by induction | Authorization vulnerability | An active participant could reactivate a departed participant using `MEMBER_JOINED`. Fixed by making that event organizer-only. |
| BL-RT-002 | Medium | Confirmed by induction | Authorization and integrity vulnerability | A participant unrelated to an expense could create an unresolved dispute against it. Fixed at the API and domain boundaries. |

## Findings

### BL-RT-001 — Participant could reactivate another participant

**Severity:** Medium
**Epistemic level:** Confirmed by induction
**Bucket:** Software vulnerability
**Status:** Fixed in this change.

**Severity rationale:** An active participant could change another person's membership state without organizer authority. This can restore write eligibility for that participant's still-valid token, but the attacker cannot take over that token; impact is therefore scoped to unauthorized state changes and reactivation, not identity theft or direct payment capture.

- **Surprise:** Only the organizer should decide when a departed participant becomes active again.
- **Abduction:** The API may allow a state transition that is not in its organizer-only event set. `MEMBER_JOINED` was the cheapest candidate because it sets participant status to `active` in the domain reducer.
- **Prediction (stated before execution):** Given a departed participant A and a different active participant B, B's valid session token submitting `MEMBER_JOINED` for A will be rejected with HTTP 403 and will leave A departed.
- **Induction on base `94dfdb4`:** On Node.js **22.23.2**, the isolated integration test returned HTTP **201**, not 403. This is the negative-control failure observed before the patch. After the fix, `npm test` passes and the same request returns HTTP 403; the event leaves A departed, and A's token cannot record an expense. The regression test also verifies that the organizer can still reactivate A through `MEMBER_STATUS_CHANGED`.
- **Causal chain:** `MEMBER_JOINED` absent from the `organizerOnly` set → active participant passes token checks → `append()` accepts the event → `deriveLedger()` sets the named participant's status to `active`.
- **Fix:** Added `MEMBER_JOINED` to the organizer-only event set. The regression test now requires HTTP 403 and also checks the departed token remains unable to record an expense.

### BL-RT-002 — Unassigned participant could dispute another person's expense

**Severity:** Medium
**Epistemic level:** Confirmed by induction
**Bucket:** Software vulnerability
**Status:** Fixed in this change.

**Severity rationale:** Any active participant could add a false dispute to an expense they neither paid nor shared. Unresolved disputes are closure blockers, so the write could obstruct final closure and pollute the event history. The attacker cannot alter the expense amount or resolve the dispute.

- **Surprise:** The interface only offers discrepancy controls to the payer or an allocated participant, but the server must enforce that relationship independently.
- **Abduction:** The route checked that `raisedByMemberId` matched the caller, while the reducer only required that the expense and participant existed. Neither layer appeared to require a relationship between them.
- **Prediction (stated before execution):** A participant not assigned to an expense, and not its payer, can submit a self-attributed discrepancy and receive HTTP 201; an assigned participant can submit one legitimately.
- **Induction on base `7cf79d5`:** The isolated API test returned HTTP **201** for the unrelated participant. The assigned participant also returned HTTP 201, as expected. The unauthorized write is confirmed. The closure impact follows the reducer's unresolved-discrepancy blocker; the regression test now prevents the unrelated event before it reaches the reducer.
- **Causal chain:** caller identity matches `raisedByMemberId` → no expense relationship check → discrepancy appended → unresolved discrepancy becomes a closure blocker.
- **Fix:** The API now requires a participant to be the payer or an allocated participant; member tokens cannot dispute unassigned expenses. The domain reducer enforces that every discrepancy references an assigned expense and a payer or allocated participant. The regression test expects 403 for an unrelated participant and 201 for an assigned participant.

## Discarded vectors

| Vector | Result | Evidence |
|---|---|---|
| Participant archives the whole session with `SESSION_ARCHIVED` | Falsified | The API already lists this event as organizer-only; regression check expects 403. |
| Read-only witness writes `SESSION_REOPENED` | Falsified | The API rejects witness writes before event processing; regression check expects 403. |
| Participant records an expense as paid by another member | Falsified | The API compares `payerId` with the token's member ID; regression check expects 403. |
| Gift recipient retrieves the private description through event or derived-state responses | Falsified | The recipient-scoped API response omits the secret phrase from both event and state JSON. |
| Unrelated participant can create a dispute after the fix | Falsified | The integration test receives 403; an assigned participant still receives 201. |

## Verification limits

The automated checks exercise the local API with synthetic participants and temporary storage. They do not test concurrent multi-process load, production deployment configuration, PayPal Sandbox capture, OpenAI provider behavior, or browser interaction. The hash chain proves that stored event bytes match their chain; it does not prove that a participant's assertion is true.
