# The Black Ledger

The Black Ledger records shared expenses as an auditable event history. Its financial engine uses integer minor units, preserves original currencies and exchange-rate evidence, and derives balances from validated events. Narrative signals are designed to observe the ledger without changing balances.

## Run locally

Requires Node.js 22.5 or newer. The server uses Node's built-in SQLite module and needs no package install.

```sh
npm run dev
```

Open `http://127.0.0.1:4173`. Copy `.env.example` to `.env` to configure integrations. Set `LEDGER_DATA_DIR` to choose where the SQLite database is stored, `PORT` to change the port, and `HOST=0.0.0.0` when the app must accept connections from other devices.

## Current implementation

- Exact money parsing, rational FX conversion with half-even rounding, and deterministic remainder allocation.
- Versioned canonical serialization and a hash-chained SQLite event log. Writes use SQLite transactions and idempotency keys.
- Domain events for session agreements, members and witnesses, subgroups, assigned and unassigned expenses, corrections, receipt discrepancies, confirmations, commitments, refunds, settlements, reversals, forgiveness, responsibility transfers, budgets, recurring rules, evidence, gifts, and closure states.
- Deterministic net-settlement suggestions, hypothetical event simulation, possible-duplicate suggestions, and explicit closure blockers.
- Evidence upload with an 8 MB bound and SHA-256 digest.
- Session access tokens with organizer, participant, and read-only witness roles; surprise-gift descriptions are hidden from the recipient's event view.
- Participant expense and payment actions are constrained to the participant's own identity; only the payment recipient can confirm receipt.
- Optional server-side PayPal Sandbox order and capture endpoints. Checkout is restricted to an outstanding obligation owed to the configured merchant participant. The server derives amounts and posts a settlement only after a completed capture.
- Optional receipt proposals from the OpenAI Responses API. The returned extraction is a proposal and requires manual review.

## API outline

- `GET /api/health`
- `POST /api/sessions` with `{ "name": "Weekend", "baseCurrency": "USD" }`
- `GET /api/sessions/:sessionId` with the returned organizer token as a Bearer token
- `POST /api/sessions/:sessionId/invitations` with `{ "name": "Alex", "role": "member" }`; returns a private invite path and access token
- `POST /api/sessions/:sessionId/carry-debt` with `Idempotency-Key` and `x-origin-token` to carry one full, verified obligation atomically from another same-currency session
- `POST /api/sessions/:sessionId/events` with a Bearer token, an `Idempotency-Key` header, and `{ "event": { ... } }`
- `POST /api/sessions/:sessionId/evidence` with `{ "mediaType": "image/jpeg", "dataBase64": "..." }`
- `GET /api/sessions/:sessionId/export` for the event log, event proofs, and attached evidence
- `POST /api/sessions/:sessionId/analysis/receipt` with `{ "mediaType": "image/jpeg", "dataBase64": "..." }`
- `POST /api/sessions/:sessionId/analysis/scenario` with `{ "prompt": "..." }`; AI proposes events and deterministic simulation computes balances without writing
- `POST /api/sessions/:sessionId/simulate` with `{ "proposedEvents": [ ... ] }`; this endpoint never writes events
- `POST /api/sessions/:sessionId/payments` with `{ "fromMemberId": "...", "toMemberId": "..." }` to create an order for an existing obligation
- `POST /api/sessions/:sessionId/payments/:orderId/capture` after buyer approval

PayPal configuration is server-side: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_ID`, and `PAYPAL_PAYEE_MEMBER_ID`. The default API host is the PayPal Sandbox; `PAYPAL_BASE_URL` can override it for a controlled environment. Receipt proposals need `OPENAI_API_KEY`; `OPENAI_RECEIPT_MODEL` selects the model. Never put credentials in browser code.

An exported evidence package can be checked offline with `node src/verify-package.js <evidence-package.json>`.

## Financial boundaries

Receipt interpretation and scenario language can only produce proposals. A person must review proposed financial facts before recording them. Pending or claimed payments do not reduce debt. Corrections, forgiveness, and responsibility changes are distinct events. Simulations do not append events. A final close reports unresolved records instead of hiding them.

## License

MIT. See [LICENSE](LICENSE).
