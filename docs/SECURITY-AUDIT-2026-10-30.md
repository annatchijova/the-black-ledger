# Security review — 2026-10-30

Base: `af878b6304eb29c56e068fc0d8daa376caae2711`. All experiments used a local isolated server, synthetic participants and temporary SQLite storage. No production data or external payment/AI providers were accessed.

## Reproduced findings

### BL-RT-004 — Unrestricted static file serving

The server treated any existing file inside the project root as a public asset. Prediction: an unauthenticated `GET /src/server.js` returns the server implementation. Observed before correction: HTTP 200 instead of the regression test's required 404.

The default database directory and `.env` are also inside this root. Their exposure follows from the same handler when those files exist; real credentials and a production database were not fetched. Potential impact includes credentials and session/database contents.

Correction: an explicit list of browser modules and entry files, plus narrowly named PNG/SVG assets. Require a regular file and reject symlink resolution. Internal files and directories return 404. Regression checks cover denied internal paths and all required browser modules.

### BL-RT-005 — Confidential gift description leaked by write responses

GET session responses applied recipient redaction, but event append responses returned an unrestricted state snapshot. Prediction: the recipient records an ordinary expense and sees their gift's private description in the returned state. Observed before correction: the synthetic secret appeared in the JSON response.

Correction: apply recipient projection to event write responses, including stored idempotency responses. Regression checks cover a new write, its replay, unchanged organizer visibility and exactly one appended event.

### BL-RT-006 — Unassigned expenses bypassed payer authorization

Participant payer checks covered `EXPENSE_RECORDED` but omitted `EXPENSE_UNASSIGNED`, although both create expenses in the financial reducer. Prediction: a participant can attribute an unassigned expense to another member. Observed before correction: HTTP 201 instead of 403.

Correction: apply expense authorization consistently to both event types, including recurring-rule and inactive-beneficiary checks. Regression checks reject impersonation without changing the chain head and preserve an authorized participant's own unassigned expense.

### BL-RT-007 — Departed participants could still upload evidence

The event route enforced participant status, while the upload route checked only role. A departed member's token could upload bytes and cause an `EVIDENCE_ATTACHED` event to be appended. Reproduced with HTTP 201 before the patch; the regression explicitly marks the participant departed immediately before attempting upload.

Correction: check current participant status before reading/storing upload bytes. The same request now returns 403. This intentionally preserves payment actions needed to settle existing obligations after departure.

### BL-RT-008 — Provider idempotency keys collided across sessions

Local idempotency is scoped by session, but PayPal order creation used only a hash of the client key. Two sessions reusing that client key produced the same provider key. A loopback provider double replaying its first response caused the second checkout to fail with a duplicate order ID (HTTP 400).

Correction: new attempts derive provider keys from canonical `[sessionId, requestId]`. Persist the selected key so retries retain it. Add an additive SQLite migration. Pre-upgrade requests without a persisted key deliberately keep their original legacy key when retried, avoiding a new external attempt during upgrade. The regression starts from the old table schema, checks same-session replay without another provider call, distinct orders across sessions, persisted new keys and preservation of a legacy retry key.

This establishes local request isolation under the simulated provider contract. No actual PayPal Sandbox request was executed.

## Offline verification improvements

The package verifier now handles malformed structures as failures, replays the domain history, validates session/currency identity, and requires attachment events, metadata and canonical base64 bytes to agree. Tests include self-consistently rehashed invalid packages and an actual API export with an attachment.

Package hashes are not signatures. A coherent replacement can be rehashed by anyone; an independent trusted head/hash is needed to detect whole-history replacement. Verification neither authenticates assertions nor proves settlement.

## Validation and limits

`npm test`: 28 passing top-level tests, including the expanded API integration scenario. Local runtime: Node 24.22.1. Added GitHub Actions configuration for Node 22 and 24; those remote jobs have not run. Browser rendering, production infrastructure, Real PayPal and OpenAI provider behavior are outside this verification; the PayPal request-key regression uses a loopback-only provider double.

## Balance provenance and recovery follow-up

Implemented current signed balance contributions in the same posting path as financial obligations. Each row refers to source event IDs and a counterparty; it never copies expense or confidential gift descriptions. Payments and refunds appear separately. Corrections reference the latest correction event, which can be followed back through the original history. UI labels explicitly distinguish current contributions from a chronological running balance.

The correction reducer previously kept the normalized replacement's source ID instead of the correction event ID. This could exclude corrected expenses when IDs matched or reject subsequent corrections when IDs differed. The reducer now preserves the stable expense identity and advances its source event; regression coverage includes two successive corrections.

An integration test reproduced omission of another client's intervening event after a successful browser-store append. The store now reloads authoritative history and explicitly reports a saved write if only that refresh fails.

A local provider test reproduced HTTP 409 for one of two overlapping successful capture calls. Capture processing now recognizes an existing matching provider confirmation, posts one financial confirmation, and updates both order tables transactionally. A simulated interruption after confirmation append but before order-row updates recovers without another provider call. This does not prove recovery for an external capture that was never recorded locally.

Visual browser verification was attempted but could not run because Chromium is not installed in this environment. UI rendering and responsive layout need a browser check during integration. Domain and API tests passed on Node 24.22.1; remote CI and real provider operations were not run.

## Provider-capture reconciliation follow-up

Completed PayPal captures are now preserved in a dedicated reconciliation table before the server attempts to append a financial confirmation. A capture whose amount, currency, claim, or current obligation does not reconcile returns HTTP 202, remains excluded from balances, and appears only to the organizer. Retrying reconciliation uses the persisted capture and does not contact the provider.

The local provider double covers a mismatched completed capture, unchanged balances, organizer inbox visibility, a failed retry without a second provider call, successful recovery from a persisted compatible capture, and an interruption after the confirmation event but before order-row updates. The last case finishes bookkeeping without appending a second confirmation.

This is crash recovery and deterministic reconciliation, not automatic dispute resolution. A genuinely incompatible amount or currency stays pending for human review. Real PayPal Sandbox behavior and provider webhooks remain outside the local test evidence.
