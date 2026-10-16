# The Black Ledger

**Every debt has a story. Every balance deserves a verdict.**

*A surreal expense-sharing application where memories become records, debts become obligations, and every payment brings the ledger closer to balance.*

## What is The Black Ledger?

The Black Ledger is an expense-sharing and debt-settlement application with a dark, surreal visual identity inspired by atmospheric mystery and point-and-click adventure games.

It helps groups track shared expenses, understand who owes whom, and settle outstanding balances without losing sight of how those balances were calculated.

Instead of presenting financial management as another conventional dashboard, The Black Ledger turns everyday accounting into a narrative experience.

A receipt becomes evidence. A payment becomes a pact. A settled balance becomes a verdict.

**Behind the atmosphere, the accounting must remain precise, explainable, and auditable.**

## The Five Chambers

### The Broken Mirror — Participants

*Reflections of those bound by debt.*

Manage the people participating in a shared financial experience: adding and managing participants, viewing individual balances, and understanding each person's position within the group.

### The Black Telephone — Expenses

*Every expense leaves a trace.*

Register shared expenses, identify who paid, and determine who participated.

AI-assisted receipt interpretation will allow uploading a photograph and reviewing extracted items, quantities, and prices before adding them to the ledger. Manual expense entry will remain available.

### Memory Extraction — History

*The past is never truly gone.*

Explore previous sessions, expenses, payments, and settlement records, preserving the context necessary to understand how a balance was produced and how it changed over time.

### The Elixir — Payments

*Some debts can only be settled.*

Record settlements and integrate payment-provider flows to initiate and verify payment operations. An initiated payment will never be treated as a completed settlement without appropriate confirmation.

### The Verdict — Calculation

*The final judgment has been rendered.*

Calculate each participant's financial position and present the obligations required to restore balance, using exact monetary arithmetic, explicit allocation rules, and verifiable accounting invariants, independent of the AI system.

When all obligations have been satisfied: **the balance is restored.**

## AI-Assisted Receipt Interpretation

The AI component is intended to reduce manual data entry, not to make financial decisions on behalf of users.

The proposed workflow is:

1. Upload a photograph or screenshot of a receipt.
2. Extract candidate line items, quantities, prices, and applicable charges.
3. Present the extracted information for human review and correction.
4. Assign expenses to the relevant participants.
5. Calculate each participant's share deterministically.
6. Confirm the resulting obligations before initiating payments.

Ambiguous or unreadable information must remain explicitly unresolved until corrected or confirmed.

**AI interprets. People confirm. The ledger calculates.**

## Financial Integrity

The Black Ledger is designed around several principles:

- **Exact arithmetic:** Monetary calculations must not depend on binary floating-point approximations.
- **Conservation of value:** Allocated amounts must reconcile with the recorded expense total.
- **Explicit consent:** AI-generated interpretations and payment operations require appropriate user confirmation.
- **Traceability:** Financial events should be attributable to their source and subsequent changes.
- **Idempotent payment handling:** Repeated requests or notifications must not produce duplicate settlement effects.
- **Verified settlement:** A pending, failed, or cancelled payment must not be reported as completed.
- **Separation of concerns:** AI extraction, accounting logic, and payment processing must remain independently testable.

## Beyond Equal Splitting

Not every shared expense should be divided equally. The planned calculation model will support scenarios such as:

- Equal splitting among selected participants.
- Item-level assignment based on actual consumption.
- Shared items consumed by subsets of the group.
- Unequal contributions and partial settlements.
- Taxes, tips, discounts, and rounding adjustments.
- Multiple expenses paid by different participants.
- Net obligations derived from the group's complete expense history.

All allocation and rounding rules will be explicit and testable.

## The Experience

The Black Ledger combines practical financial workflows with a distinctive interactive world.

Its visual direction includes aged gold, deep black, muted sepia, crimson accents, antique typography, symbolic objects, and atmospheric transitions: a black cube, a rotary telephone, an elixir bottle, mirrors, and other narrative elements, kept accessible and usable.

Hidden details, unusual numerical events, and optional visual effects may reward exploration, but they must never alter financial results or obstruct essential operations.

All visual assets and implementation are original.

## Project Status

**Status: Early design and planning.**

The following are planned, not yet claimed as implemented in this repository:

- Application interface and interactive objects.
- Deterministic expense-allocation and settlement engine.
- AI-assisted receipt extraction with human confirmation.
- Payment-provider integration.
- Persistent sessions and financial event history.
- Auditability, automated tests, and reproducible setup.
- A functional end-to-end demonstration.

## License

License to be determined before the first public release.

---

*The cube remembers. The ledger never forgets.*
