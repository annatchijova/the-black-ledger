# The Black Ledger — visual identity

This guide extends the app's existing chamber names, illustrations, and palette. The visual layer stays atmospheric; the event log and money calculations remain the only source of financial truth.

## 1. Central motif — The Witness Knot

Three line-art directions could organize the identity:

1. **The Witness Knot (recommended):** an archival folio with two interlocked loops crossing its center seam. The two loops stand for the payer and the people sharing a cost; the folio makes the record itself the witness. One restrained crimson stitch marks the binding.
2. **The Carbon Index:** two offset page corners with a single registration notch. It suggests a copied record and immutable history, with a very compact silhouette.
3. **The Red Thread Boundary:** two separate ledger marks joined by one continuous thread. It gives the strongest story of obligation between people, but reads less clearly as an app mark at favicon size.

I recommend the Witness Knot because it binds the two core ideas—shared obligation and recorded evidence—in one silhouette. The SVG is intentionally a few engraved strokes, not a literal cube, seasonal emblem, or borrowed game object. Use the same mark for the wordmark, favicon, active-chamber ornament, empty-state stamp, and loading indicator; vary only scale and the chamber-specific outer drawing.

The new `assets/ledger-mark.svg` is the standalone logo mark. The wordmark remains the existing serif “The Black Ledger”; together they form the header logo. The six reusable line symbols live inline in `index.html`, so navigation and rendered chamber headings share one source.

## 2. Chamber seals

Each chamber keeps its existing name and function. The small symbols beside them in the navigation today are, in order, `◈ ◉ ⌕ ▤ ♢ ⚖`. Replace those generic characters with the engraved SVG seals:

| Route and chamber | Engraved seal | Existing symbol |
|---|---|---|
| `#home` · The Ledger | Folio with the central Witness Knot and a folded corner. | `◈` |
| `#members` · The Broken Mirror | Oval hand mirror with a single long fracture that stops before the handle. | `◉` |
| `#expenses` · The Black Telephone | Old receiver, coiled line, and a small rotary dial. | `⌕` |
| `#history` · Memory Extraction | Folio with dated ruled entries and one broken registration line. | `▤` |
| `#payments` · The Elixir | Narrow apothecary vial holding the same two-loop seal. | `♢` |
| `#verdict` · The Verdict | Hand-engraved balance beam with the binding stitch at its fulcrum. | `⚖` |

Implementation IDs are `chamber-ledger`, `chamber-mirror`, `chamber-telephone`, `chamber-memory`, `chamber-elixir`, and `chamber-verdict`. Keep stroke weight fine but not hairline at 16–24 px; use `currentColor`, rounded joins, and one crimson stitch only on the central knot.

## 3. Reusable image direction

Use the following English prompt unchanged except for the bracketed subject:

> Create a quiet, cinematic still life of **[SUBJECT]** as an artifact recovered from a private bureau that records shared debts. Compose it like an archival evidence photograph crossed with a restrained hand-painted gouache illustration: subject placed off-center with generous shadowed negative space, imperfect edges, and no theatrical staging. Palette anchored to warm ink `#110f0d`, soft ink `#171411`, lifted panel `#1e1a16`, aged parchment `#e5d5b4`, restrained brass `#c3a66c` and `#ddc18a`, and a single small seal-red accent `#a63736` or `#d45c54`. Light from one low, narrow source as if from a desk lamp behind smoked glass; let gold catch only on an edge and preserve large areas of readable darkness. Use matte soot, worn paper fibres, shallow scratches, oxidized brass, soft pigment grain, and deep quiet shadows. No text, letters, numbers, logos, familiar characters, recognizable game props, photorealistic faces, neon, glossy 3D, ornate high-fantasy costume, generic fantasy clutter, or decorative detail behind interface copy. The image must remain legible as a dark atmospheric background with ample calm negative space.

For the six chambers, change only `[SUBJECT]` (for example: “a closed ledger with one thread-bound page”, “a cracked hand mirror”, or “an unlit rotary telephone”). Keep hero images on the right side when the page carries text on the left. Do not ask the image model to render UI labels, monetary amounts, receipts with readable text, or confirmation states.

## 4. Texture and financial legibility

- **General canvas:** keep the near-black base. A barely visible, one-direction archival fibre grain can sit on the outer canvas only; the added CSS uses low-opacity lines so it reads as atmosphere rather than a pattern.
- **Panels and forms:** use almost-solid charcoal. A thin inner rule and corner framing supply the engraved-object feeling. Avoid paper grain, wood grain, fabric, blur, or image backgrounds beneath labels, inputs, balances, and transaction rows.
- **Verdict paper:** parchment belongs on the final transfer sheet only. Keep the transfer rows as clean, high-contrast blocks over it; do not put a seal, texture, or illustration behind a number.
- **Type and amount treatment:** keep the existing serif/sans/mono roles, use tabular lining numerals, and make amounts at least as prominent as surrounding metadata. Color is a secondary cue: green means credit, blood red means debit, and a neutral balance stays parchment. Every status also needs visible words; color and motion alone never communicate money state.

No supplied palette value was changed. The current CSS already uses the requested warm black, brown, parchment, gold, seal red, and balance green; the update reuses those values and adjusts contrast and numeric sizing through existing tokens.

## 5. Microinteractions

- **Record an expense:** the submit button should depress like a brass stamp (about 100–140 ms). After the event is accepted, let the new row settle in with a brief ink-darkening edge (about 220 ms); keep the amount fixed and unobscured. If validation fails, show the existing error immediately without the success motion.
- **Confirm a payment:** a pending claim must look pending; only the app's confirmed event can receive a crisp gold edge and “Payment confirmed” wording. The receipt-like transition should be short (180–240 ms) and must not delay or imply settlement before the event is actually confirmed.
- **Archive a session:** after the existing confirmation dialog, the red seal can make one dry, soft imprint (roughly 260–320 ms), then the read-only state appears. Keep the confirmation controls and outstanding-balance note fully visible throughout.
- **Sound concept:** a muted felt stamp followed by a small paper slide. No audio is required; the timing and easing should suggest it. Respect `prefers-reduced-motion`; no animation may be the sole evidence that a financial action succeeded.

The interface now uses short press feedback, a restrained chamber-arrival motion, and an opening transition for the archive dialog. These effects are decorative and do not replace or delay the underlying event confirmation.

## 6. New chamber language

Use these English lines as optional replacements for generic empty, error, or confirmation copy:

1. **“No names have crossed the threshold.”** — empty state on The Broken Mirror; pair it with a direct “Add a participant” action.
2. **“The archive has no testimony yet.”** — empty state in Memory Extraction; the action should still say “Record an expense” or another literal next step.
3. **“Entry not confirmed. Review the record before retrying.”** — persistence or network error; avoids claiming that nothing was saved before the app has checked.
4. **“Payment recorded for review.”** — use only for a pending/asserted payment, never for a confirmed one.
5. **“The account is balanced.”** — confirmation on The Verdict only when every derived balance is exactly zero.

### Decision scan

- Section 1: Use The Witness Knot as the master mark.
- Section 2: Use the six shared engraved SVG seals instead of the current Unicode glyphs.
- Section 3: Keep the same low-key archive prompt and change only the subject.
- Section 4: Grain stays faint on the canvas; financial surfaces stay clean and solid.
- Section 5: Use brief tactile motion; the ledger's confirmed event remains the success signal.
- Section 6: Use English narrative copy with literal, state-accurate actions.

