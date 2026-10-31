# The Black Ledger — next development proposals

These are proposals, not implemented features. They are based on the current source plus the accompanying security patch.

| Priority | Proposal | User outcome | Acceptance check |
| --- | --- | --- | --- |
| Done in this patch | Payment reconciliation inbox | A completed external capture that cannot be posted is visible to the organizer and recoverable without another provider call. | Provider evidence is persisted before financial posting; incompatible captures leave balances unchanged; interrupted reconciliation is idempotent. |
| 2 | Token revocation and replacement | Organizer can revoke a lost invitation or device without deleting debts or removing the member. | Old token returns 401 for reads and writes; replacement token retains the member identity; organizer cannot accidentally revoke the last organizer credential. |
| Done in this patch | Explain each balance | Expand a participant balance and follow its source events. | Covered by domain reconciliation tests, including corrections, refunds and FX fees. Browser visual review remains pending. |
| 4 | Review before recording | Members preview who owes what before recording an expense, correction or forgiveness. | Simulation does not append; confirmation revalidates against current head; a changed ledger requires an updated preview. |
| 5 | Session selector | A person can keep several journeys and switch without overwriting their sole local session/token entry. | Credentials remain per session; invite acceptance does not discard existing access; roles are visible before writing. |
| 6 | Browser package verification | A person verifies an export without using the terminal. | Runs locally without uploading receipts; reports structural, chain, domain and attachment failures separately; explains that a hash is not a signature. |

## Next investigation hypotheses

- **External capture before reconciliation:** source shows the capture request happens before checking the latest ledger obligation. Investigate edits, cancellation and overlapping capture requests during the provider round-trip. This is a test target, not a confirmed loss of funds.
- **Payment recovery after crashes:** concurrent capture and recovery after confirmation append but before order-row updates are covered. Still test exits after external capture but before any financial event is stored, and failed order creation recovery.
- **Concurrent clients:** covered for an intervening event from a second client and a failed refresh after a successful write. Broader multi-process load remains to be tested.
- **Upload quotas:** test repeated uploads, deduplication, invalid media types and multiple server processes sharing storage. Current checks are application-level and should be assessed under real concurrency.

Recommended next product slice: token lifecycle, followed by a multi-session selector. Each needs explicit recovery behavior so access changes never erase financial history.
