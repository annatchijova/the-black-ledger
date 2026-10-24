import { deriveLedger, formatMoney, parseAmountToCents, settleUp } from "./domain.js";
import { deriveNarrativeEvents } from "./domain/narrative.js";
import { appendEvent, exportLedger, loadLedger, takeAppendWarnings, getAccessContext } from "./store.js";

const view = document.querySelector("#view");
const storageError = document.querySelector("#storage-error");
const toast = document.querySelector("#toast");
let events;
let route = location.hash.slice(1) || "home";
let toastTimer;
let pendingEvidenceIds = [];
const routes = new Set(["home", "members", "expenses", "history", "payments", "verdict"]);
const h = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const eventDate = (iso) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const ledger = () => deriveLedger(events);
const memberName = (id) => ledger().members.find((m) => m.id === id)?.name ?? "Unknown participant";

try { events = await loadLedger(); }
catch (error) { storageError.hidden = false; storageError.textContent = error.message; document.querySelector("#application").hidden = true; }

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function commit(type, fields, successMessage) {
  try { events = await appendEvent(events, type, fields); const warnings = takeAppendWarnings(); render(); showToast(warnings.length ? `Possible duplicate: ${warnings.map((item) => item.reason).join("; ")}. Check the record; nothing was removed.` : successMessage); return true; }
  catch (error) {
    try { events = await loadLedger(); render(); } catch (loadError) { storageError.hidden = false; storageError.textContent = loadError.message; document.querySelector("#application").hidden = true; }
    showToast(error.message); return false;
  }
}

function header(title, subtitle, eyebrow = "THE LEDGER") {
  return `<div class="view-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><span class="heading-mark" aria-hidden="true">✳</span></div>`;
}

function statusPill(current) {
  return `<span class="status-pill ${current.archived ? "sealed" : "open"}"><i></i>${current.archived ? "Archived" : "Open journey"}</span>`;
}

function homePage(current) {
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const balanceStatus = current.members.length === 0 ? "Awaiting entries" : [...current.balances.values()].every((value) => value === 0) ? "Balanced" : "Unsettled";
  const narrative = deriveNarrativeEvents(current).at(-1);
  return `${header("The Black Ledger", "A record of what was shared, and what remains.", "A PRIVATE ACCOUNT")}
    <section class="hero-card"><div class="hero-copy"><div class="eyebrow">THE KEEPER'S BOOK IS OPEN</div><h2>Every debt<br><em>leaves a trace.</em></h2><p>Record the expense. Decide who shared it. The ledger will show its work.</p><a href="#expenses" class="button button-gold">Record an expense <span>↗</span></a></div><div class="hero-status">${statusPill(current)}<span>Stored in the shared ledger</span></div></section>
    <section class="stat-grid"><article class="stat-card"><span>BOUND TO THIS JOURNEY</span><strong>${current.members.length}</strong><small>participants</small></article><article class="stat-card"><span>RECORDED EXPENDITURE</span><strong>${formatMoney(current.totalExpenses)}</strong><small>${current.expenses.length} expense${current.expenses.length === 1 ? "" : "s"}</small></article><article class="stat-card"><span>ACCOUNT CONDITION</span><strong class="condition ${balanceStatus === "Balanced" ? "good" : "pending"}">${balanceStatus}</strong><small>${current.settlements.length} recorded settlement${current.settlements.length === 1 ? "" : "s"}</small></article></section>
    ${narrative ? `<div class="calculation-note"><span>◇</span><p><b>Fictional witness:</b> ${h(narrative.text)} This story never changes a balance.</p></div>` : ""}
    <div class="content-grid"><section class="panel"><div class="section-title"><div><div class="eyebrow">THE WITNESSES</div><h2>People in the ledger</h2></div><a href="#members" class="text-button">All participants ↗</a></div>${current.members.length ? `<div class="member-list">${current.members.slice(0, 5).map((m) => memberCard(m, current)).join("")}</div>` : emptyState("No names have been entered.", "Add the people who shared this journey.", "#members", "Add the first participant")}</section><section class="panel recent-panel"><div class="section-title"><div><div class="eyebrow">THE LAST IMPRESSION</div><h2>Recent events</h2></div><a href="#history" class="text-button">Open memory ↗</a></div>${current.events.length ? `<div class="event-list compact">${[...current.events].reverse().slice(0, 4).map(eventRow).join("")}</div>` : emptyState("The pages are blank.", "The first record is waiting.", "#expenses", "Add an expense")}</section></div>
    ${current.archived ? `<div class="sealed-banner"><span>✦</span><div><b>This journey is sealed.</b><p>Its record is read-only. Export it from the footer.</p></div></div>` : current.closure?.type === "provisional" ? `<div class="sealed-banner"><span>!</span><div><b>This journey has a provisional close.</b><p>${current.closureBlockers.length} open item(s) remain visible. Add records to resolve them, then close again.</p></div></div>` : current.events.length && access.role === "organizer" ? `<section class="closing-strip"><div><div class="eyebrow">WHEN THE JOURNEY ENDS</div><b>Keep the memory. Close the books.</b><p>A final close requires resolved records and zero balances. Otherwise the close stays provisional.</p></div><button class="button button-quiet" id="archive-button" type="button">Close this journey <span>→</span></button></section>` : ""}`;
}

function memberCard(member, current) {
  const cents = current.balances.get(member.id) || 0;
  return `<article class="member-row"><span class="avatar">${h(member.name.trim().slice(0, 1).toUpperCase())}</span><span class="member-name"><b>${h(member.name)}</b><small>Witness ${String(current.members.findIndex((m) => m.id === member.id) + 1).padStart(2, "0")}</small></span><strong class="money ${cents > 0 ? "credit" : cents < 0 ? "debit" : "neutral"}">${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatMoney(Math.abs(cents))}</strong></article>`;
}

function emptyState(title, body, href, action) {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><b>${title}</b><p>${body}</p><a class="text-button" href="${href}">${action} ↗</a></div>`;
}

function membersPage(current) {
  const canAdmin = getAccessContext().role === "organizer";
  return `${header("The Broken Mirror", "Reflections of those bound by this journey.", "CHAMBER 01 · THE WITNESSES")}
    <section class="feature-card mirror-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/broken-mirror.png" alt=""></div><div><div class="eyebrow">A NAME ENTERED BECOMES A WITNESS</div><h2>Who shared the account?</h2><p>Add the people whose spending and contributions belong in this ledger. This local level is operated by one organizer.</p></div></section>
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="member-form"><label for="member-name">Participant name</label><div class="input-row"><input id="member-name" name="name" maxlength="48" placeholder="e.g. Alex" required autocomplete="off"><button class="button button-gold" type="submit">Add to the mirror <span>↗</span></button></div><small>Up to 100 names. Entries are saved to the shared event log.</small></form>` : ""}
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="invite-form"><label for="invite-name">Invite someone to this ledger</label><div class="input-row"><input id="invite-name" name="name" maxlength="80" placeholder="Participant name" required><select name="role"><option value="member">Participant</option><option value="witness">Read-only witness</option></select><button class="button button-quiet" type="submit">Create invite link</button></div><output id="invite-link" aria-live="polite"></output></form>` : ""}
    <section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE PRESENT</div><h2>Participants <span class="count">${current.members.length} / 100</span></h2></div></div>${current.members.length ? `<div class="member-list full-list">${current.members.map((m) => memberCard(m, current)).join("")}</div>` : emptyState("No reflections yet.", "Add the first participant to begin.", "#members", "Add a participant")}</section>`;
}

function expensePage(current) {
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const payerOptions = current.members.filter((member) => access.role !== "member" || member.id === access.memberId);
  const enough = current.members.length >= 1;
  const rows = current.members.map((m) => `<label class="check-row"><input type="checkbox" name="beneficiary" value="${h(m.id)}" checked><span>${h(m.name)}</span></label>`).join("");
  return `${header("The Black Telephone", "Every expense leaves a trace. Every share has a rule.", "CHAMBER 02 · THE EVIDENCE")}
    <section class="feature-card phone-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/black-telephone.png" alt=""></div><div><div class="eyebrow">THE RECEIPT IS EVIDENCE</div><h2>Enter what happened.</h2><p>Receipt analysis proposes details for a person to review. It never writes into the ledger by itself.</p></div><span class="coming-tag">HUMAN REVIEW</span></section>
    ${!current.archived && !readOnly ? `<section class="form-panel"><label for="receipt-image">Receipt image</label><div class="input-row"><input id="receipt-image" type="file" accept="image/jpeg,image/png,image/webp"><button class="button button-quiet" id="analyze-receipt" type="button">Propose receipt details</button></div><pre id="receipt-proposal" hidden aria-live="polite"></pre></section>` : ""}
    ${!enough ? emptyState("The table is empty.", "Enter at least one participant before recording a cost.", "#members", "Open the Broken Mirror") : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? "Read-only witness access." : "This ledger is read-only."}</b><p>${readOnly ? "You can inspect the expenses and their evidence." : "Start another ledger to record new expenses."}</p></div></div>` : `<form class="form-panel expense-form" id="expense-form"><div class="form-heading"><div><div class="eyebrow">A NEW ENTRY</div><h2>Record an expense</h2></div><span class="form-index">02 / 05</span></div><div class="field-grid"><label>Description<input name="description" maxlength="120" placeholder="Dinner, train tickets…" required></label><label>Total amount <span class="field-hint">USD</span><input name="amount" inputmode="decimal" placeholder="0.00" required></label><label>Paid by<select name="payer" required><option value="unassigned">Unknown / unassigned</option>${payerOptions.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("")}</select></label><label>Allocation rule<select name="splitMode" id="split-mode"><option value="equal">Split equally</option><option value="custom">Enter each share</option></select></label></div><fieldset class="beneficiary-fieldset"><legend>Who benefited from this expense?</legend><div class="check-grid">${rows}</div></fieldset><div id="custom-shares" class="custom-shares" hidden></div><div class="form-footer"><p>Shares reconcile to the total. If the payer is unknown, the expense stays unassigned until corrected.</p><button class="button button-gold" type="submit">Write into the ledger <span>↗</span></button></div></form>`}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">THE RECORD</div><h2>Recorded expenses</h2></div><span class="count">${current.expenses.length} entries</span></div>${current.expenses.length ? `<div class="expense-list">${[...current.expenses].reverse().map(expenseRow).join("")}</div>` : emptyState("Nothing has been recorded.", "The first expense will appear here.", "#expenses", "Record an expense")}</section>`;
}

function expenseRow(event) {
  return `<article class="expense-row"><span class="row-icon">⌕</span><span class="expense-meta"><b>${h(event.description)}</b><small>Paid by ${h(memberName(event.payerId))} · Shared by ${event.allocations.length} participant${event.allocations.length === 1 ? "" : "s"} · ${eventDate(event.at)}</small></span><strong>${formatMoney(event.totalCents)}</strong></article>`;
}

function eventDescription(event) {
  if (event.type === "MEMBER_ADDED") return `<b>${h(event.name)}</b> entered the mirror`;
  if (event.type === "MEMBER_INVITED") return `<b>${h(event.name)}</b> was invited as a ${h(event.role)}`;
  if (event.type === "EXPENSE_RECORDED") return `Expense recorded: <b>${h(event.description)}</b> · ${formatMoney(event.totalCents)}`;
  if (event.type === "EXPENSE_UNASSIGNED") return `Unassigned charge recorded: <b>${h(event.description)}</b> · ${formatMoney(event.totalCents ?? event.amountMinor)}`;
  if (event.type === "SETTLEMENT_RECORDED") return `Settlement recorded: <b>${h(memberName(event.fromId))}</b> → <b>${h(memberName(event.toId))}</b> · ${formatMoney(event.cents)}`;
  if (event.type === "SETTLEMENT_ASSERTED") return `Payment claim pending: <b>${h(memberName(event.fromMemberId))}</b> → <b>${h(memberName(event.toMemberId))}</b> · ${formatMoney(event.amountMinor)}`;
  if (event.type === "SETTLEMENT_CONFIRMED") return `Payment confirmed for ${h(memberName(event.confirmedByMemberId))}.`;
  if (event.type === "SESSION_CLOSED_PROVISIONAL") return `<b>A provisional close was recorded.</b> ${h(event.reason)}`;
  if (event.type === "SESSION_CLOSED_FINAL") return "<b>The journey was finally closed.</b>";
  if (event.type === "SESSION_ARCHIVED") return `<b>The journey was archived.</b>${event.provisional ? " Open balances remained." : " The account was balanced."}`;
  if (event.type === "SESSION_CREATED") return `<b>${h(event.name)}</b> opened a ledger in ${h(event.baseCurrency)}`;
  return `${h(event.type.replaceAll("_", " ").toLowerCase())} recorded`;
}

function eventRow(event) {
  const icon = { MEMBER_ADDED: "◉", MEMBER_INVITED: "◉", EXPENSE_RECORDED: "⌕", SETTLEMENT_RECORDED: "♢", SETTLEMENT_ASSERTED: "♢", SETTLEMENT_CONFIRMED: "♢", SESSION_ARCHIVED: "▣", SESSION_CLOSED_FINAL: "▣", SESSION_CLOSED_PROVISIONAL: "▣" }[event.type] || "·";
  return `<article class="event-row"><span class="event-icon">${icon}</span><span class="event-copy"><span>${eventDescription(event)}</span><small>${eventDate(event.at)}</small></span></article>`;
}

function historyPage(current) {
  return `${header("Memory Extraction", "A history of events, preserved in the order they were recorded.", "CHAMBER 03 · THE MEMORY")}
    <section class="feature-card memory-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/verdict-seal.png" alt=""></div><div><div class="eyebrow">THE PAST IS NEVER TRULY GONE</div><h2>A record, not a rewrite.</h2><p>Events are stored in a shared SQLite ledger with a chained integrity hash. Corrections remain separate records.</p></div><span class="coming-tag">${current.events.length} EVENTS</span></section>
    <section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">CHRONOLOGICAL RECORD</div><h2>What happened</h2></div><span class="count">${current.events.length} events</span></div>${current.events.length ? `<div class="event-list full-events">${[...current.events].reverse().map(eventRow).join("")}</div>` : emptyState("The memory is blank.", "Events will be listed here as they happen.", "#members", "Begin with the witnesses")}</section>`;
}

function paymentPage(current) {
  const enough = current.members.length >= 2;
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const options = current.members.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("");
  const payerOptions = current.members.filter((member) => access.role !== "member" || member.id === access.memberId).map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("");
  return `${header("The Elixir", "Record a claimed settlement without confusing it for provider proof.", "CHAMBER 04 · THE SETTLEMENT")}
    <section class="feature-card elixir-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/elixir-vial.png" alt=""></div><div><div class="eyebrow">THE VIAL OF DEBT</div><h2>A payment changes the account.</h2><p>A claimed transfer stays pending. Only recipient confirmation or a completed PayPal capture changes balances.</p></div><span class="coming-tag">VERIFIED STATES</span></section>
    ${!enough ? emptyState("Two witnesses are needed.", "Add at least two participants to record a settlement.", "#members", "Open the Broken Mirror") : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? "Read-only witness access." : "This ledger is read-only."}</b><p>${readOnly ? "You can inspect payment states and confirm receipts addressed to you." : "Its settlement history remains available below."}</p></div></div>` : `<form class="form-panel payment-form" id="payment-form"><div class="form-heading"><div><div class="eyebrow">A CLAIM OF PAYMENT</div><h2>Record a settlement</h2></div><span class="form-index">04 / 05</span></div><div class="field-grid"><label>Who paid?<select name="from" required>${payerOptions}</select></label><label>Who received?<select name="to" required>${options}</select></label><label>Amount <span class="field-hint">USD</span><input name="amount" inputmode="decimal" placeholder="0.00" required></label></div><div class="honesty-note"><span>i</span><p><b>This remains a pending claim.</b> It does not reduce balances until the recipient confirms the transfer or PayPal reports a completed capture.</p></div><div class="form-footer"><p>A claim must match an outstanding obligation between these participants.</p><div><button class="button button-gold" type="submit">Record pending claim <span>↗</span></button><button class="button button-quiet" id="paypal-checkout" type="button">Pay through PayPal Sandbox</button></div></div></form>`}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">PAYMENT RECORD</div><h2>Settlements recorded</h2></div><span class="count">${current.settlements.length} entries</span></div>${current.settlements.length ? `<div class="expense-list">${[...current.settlements].reverse().map((event) => `<article class="expense-row"><span class="row-icon payment-icon">♢</span><span class="expense-meta"><b>${h(memberName(event.fromId))} → ${h(memberName(event.toId))}</b><small>${h(event.status ?? "recorded")} · ${eventDate(event.at)}</small></span><strong>${formatMoney(event.cents)}</strong>${event.status === "pending" && event.rail !== "paypal" && event.toId === access.memberId ? `<button type="button" class="button button-quiet confirm-payment" data-settlement-id="${h(event.settlementId)}">Confirm receipt</button>` : ""}</article>`).join("")}</div>` : emptyState("No settlement has been recorded.", "A claimed payment will be listed here.", "#payments", "Record a settlement")}</section>`;
}

function verdictPage(current) {
  const transfers = settleUp(current.balances);
  const allBalanced = [...current.balances.values()].every((value) => value === 0);
  return `${header("The Verdict", "Every number has a source. Every remainder has a rule.", "CHAMBER 05 · THE CALCULATION")}
    <section class="verdict-paper"><div class="paper-seal">✳</div><div class="paper-eyebrow">THE BLACK LEDGER · ACCOUNT ${String(current.events.length).padStart(3, "0")}</div><h2>The Verdict</h2><p class="paper-subtitle">“The account is derived from what was entered.”</p><div class="paper-rule"></div>${allBalanced ? `<div class="balanced-result"><span>✦</span><h3>The balance is restored.</h3><p>Every recorded participant stands at zero.</p></div>` : `<h3 class="paper-section-title">Suggested transfers</h3>${transfers.length ? `<div class="transfer-list">${transfers.map((t, i) => `<article class="transfer-row"><span class="transfer-num">${String(i + 1).padStart(2, "0")}</span><span><b>${h(memberName(t.fromId))}</b><small>must pay</small><b>${h(memberName(t.toId))}</b></span><strong>${formatMoney(t.cents)}</strong></article>`).join("")}</div>` : `<p class="paper-empty">Add participants and expenses to render a verdict.</p>`}`}<div class="paper-rule"></div><p class="paper-foot">Calculated from ${current.expenses.length} expense${current.expenses.length === 1 ? "" : "s"} and ${current.settlements.length} recorded settlement${current.settlements.length === 1 ? "" : "s"}. No floating-point amounts.</p></section>
    <section class="panel balances-panel"><div class="section-title"><div><div class="eyebrow">THE ACCOUNT, PERSON BY PERSON</div><h2>Current balances</h2></div><span class="method-tag">EXACT MINOR UNITS</span></div>${current.members.length ? `<div class="balance-grid">${current.members.map((m) => memberCard(m, current)).join("")}</div>` : emptyState("No balances to show.", "Participants will appear when entered.", "#members", "Open the Broken Mirror")}</section>
    <div class="calculation-note"><span>i</span><p>Net position = expenses paid − allocated shares + completed settlements paid − received. Suggested transfers net those positions without changing the ledger.</p></div>
    ${!current.archived ? `<section class="form-panel"><div class="eyebrow">A SCENARIO, NOT A RECORD</div><h2>Ask what would happen</h2><form id="scenario-form"><label for="scenario-prompt">Describe a hypothetical change</label><textarea id="scenario-prompt" name="prompt" maxlength="1200" required placeholder="What if Alex covered the hotel and the others paid for dinner?"></textarea><button class="button button-quiet" type="submit">Simulate without saving</button></form><pre id="scenario-result" hidden aria-live="polite"></pre></section>` : ""}`;
}

function bindPage(current) {
  document.querySelector("#scenario-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const resultNode = document.querySelector("#scenario-result");
    try {
      const prompt = new FormData(event.currentTarget).get("prompt");
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/analysis/scenario`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` }, body: JSON.stringify({ prompt }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Scenario simulation failed.");
      resultNode.hidden = false; resultNode.textContent = JSON.stringify(data, null, 2);
    } catch (error) { resultNode.hidden = false; resultNode.textContent = error.message; }
  });

  document.querySelector("#invite-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/invitations`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` }, body: JSON.stringify({ name: data.get("name"), role: data.get("role") }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not create invite.");
      const link = `${location.origin}${result.invitePath}`;
      try { await navigator.clipboard?.writeText(link); } catch { /* The visible invite path remains available to copy manually. */ }
      events = await loadLedger(); render(); document.querySelector("#invite-link").textContent = link;
      showToast("Invite link created. Share it privately with the participant.");
    } catch (error) { showToast(error.message); }
  });

  document.querySelector("#analyze-receipt")?.addEventListener("click", async () => {
    const file = document.querySelector("#receipt-image")?.files?.[0];
    const output = document.querySelector("#receipt-proposal");
    try {
      if (!file || file.size > 8_000_000) throw new Error("Choose an image no larger than 8 MB.");
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
      output.hidden = false; output.textContent = "Reading receipt…";
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/analysis/receipt`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` }, body: JSON.stringify({ mediaType: file.type, dataBase64: btoa(binary) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Receipt analysis failed.");
      const dataBase64 = btoa(binary);
      const evidenceResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/evidence`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` }, body: JSON.stringify({ mediaType: file.type, dataBase64 }) });
      const evidence = await evidenceResponse.json();
      if (!evidenceResponse.ok) throw new Error(evidence.error ?? "Could not attach receipt evidence.");
      if (!events.some((item) => item.id === evidence.event.id)) events = [...events, evidence.event];
      if (!pendingEvidenceIds.includes(evidence.id)) pendingEvidenceIds.push(evidence.id);
      output.textContent = JSON.stringify(result.proposal, null, 2);
      const form = document.querySelector("#expense-form");
      if (form && result.proposal.currency === "USD" && result.proposal.merchant) form.elements.description.value = result.proposal.merchant;
      if (form && result.proposal.currency === "USD" && result.proposal.total) form.elements.amount.value = result.proposal.total;
      showToast("Proposal ready and receipt evidence attached. Review each value before recording.");
    } catch (error) { if (output) { output.hidden = false; output.textContent = error.message; } }
  });

  document.querySelector("#member-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name").trim();
    if (!name || current.members.length >= 100) return showToast("Enter a name; the ledger supports up to 100 participants.");
    commit("MEMBER_ADDED", { memberId: crypto.randomUUID(), name }, `${name} entered the mirror.`);
  });

  const expenseForm = document.querySelector("#expense-form");
  const custom = document.querySelector("#custom-shares");
  const modeSelect = document.querySelector("#split-mode");
  const updateCustom = () => {
    const checked = [...expenseForm.querySelectorAll("[name=beneficiary]:checked")];
    const enabled = modeSelect.value === "custom";
    custom.hidden = !enabled;
    custom.innerHTML = enabled ? `<div class="custom-title">Enter each participant’s share</div>${checked.map((box) => `<label>${h(memberName(box.value))}<input name="share-${h(box.value)}" inputmode="decimal" placeholder="0.00" required></label>`).join("")}` : "";
  };
  modeSelect?.addEventListener("change", updateCustom);
  expenseForm?.querySelectorAll("[name=beneficiary]").forEach((box) => box.addEventListener("change", updateCustom));
  expenseForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(expenseForm);
      const totalCents = parseAmountToCents(data.get("amount"));
      const payerId = data.get("payer");
      if (payerId === "unassigned") {
        const saved = await commit("EXPENSE_UNASSIGNED", { description: String(data.get("description")).trim(), totalCents, allocations: [], evidenceIds: [...pendingEvidenceIds] }, "Charge recorded as unassigned. It will not affect balances until assigned.");
        if (saved) pendingEvidenceIds = [];
        return;
      }
      const ids = data.getAll("beneficiary");
      if (!ids.length) throw new Error("Select at least one beneficiary.");
      let allocations;
      if (data.get("splitMode") === "custom") {
        allocations = ids.map((memberId) => ({ memberId, cents: parseAmountToCents(data.get(`share-${memberId}`)) }));
        if (allocations.reduce((sum, row) => sum + row.cents, 0) !== totalCents) throw new Error("Custom shares must sum exactly to the expense total.");
      } else {
        const base = Math.floor(totalCents / ids.length);
        let remainder = totalCents - base * ids.length;
        allocations = ids.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      }
      const saved = await commit("EXPENSE_RECORDED", { description: String(data.get("description")).trim(), payerId, totalCents, allocations, evidenceIds: [...pendingEvidenceIds] }, "Expense entered into the ledger.");
      if (saved) pendingEvidenceIds = [];
    } catch (error) { showToast(error.message); }
  });

  document.querySelector("#payment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const fromId = data.get("from"); const toId = data.get("to");
      if (fromId === toId) throw new Error("Choose two different participants.");
      const cents = parseAmountToCents(data.get("amount"));
      commit("SETTLEMENT_ASSERTED", { settlementId: crypto.randomUUID(), fromMemberId: fromId, toMemberId: toId, amountMinor: cents, rail: "other" }, "Payment claim is pending. Balances remain unchanged until confirmation.");
    } catch (error) { showToast(error.message); }
  });

  document.querySelectorAll(".confirm-payment").forEach((button) => button.addEventListener("click", () => {
    const access = getAccessContext();
    commit("SETTLEMENT_CONFIRMED", { settlementId: button.dataset.settlementId, confirmedByMemberId: access.memberId, confirmationSource: "recipient_confirmation" }, "You confirmed receipt. The settlement now updates balances.");
  }));

  document.querySelector("#paypal-checkout")?.addEventListener("click", async () => {
    try {
      const data = new FormData(document.querySelector("#payment-form"));
      const fromMemberId = data.get("from"); const toMemberId = data.get("to");
      if (!fromMemberId || !toMemberId || fromMemberId === toMemberId) throw new Error("Choose two different participants.");
      const amountMinor = parseAmountToCents(data.get("amount"));
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ fromMemberId, toMemberId, amountMinor }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not create PayPal checkout.");
      if (!result.approvalUrl) throw new Error("PayPal returned no buyer approval link.");
      location.assign(result.approvalUrl);
    } catch (error) { showToast(error.message); }
  });
}

function render() {
  if (!events) return;
  const current = ledger();
  document.querySelector("#export-button").hidden = getAccessContext().role !== "organizer";
  if (!routes.has(route)) route = "home";
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  const pages = { home: homePage, members: membersPage, expenses: expensePage, history: historyPage, payments: paymentPage, verdict: verdictPage };
  view.innerHTML = pages[route](current);
  bindPage(current);
  document.querySelector("#archive-button")?.addEventListener("click", () => {
    const dialog = document.querySelector("#confirm-dialog");
    const blockers = current.closureBlockers;
    document.querySelector("#archive-balance-note").textContent = blockers.length ? `This will be a provisional close. ${blockers.map((item) => item.message).join(" ")}` : "All records are resolved and participant balances net to zero. This final close makes the ledger read-only.";
    dialog.showModal();
  });
}

document.querySelector("#main-nav").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (link) route = link.dataset.route;
});
window.addEventListener("hashchange", () => { route = location.hash.slice(1) || "home"; render(); });
const syncChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("the-black-ledger-sync-v1");
syncChannel?.addEventListener("message", async (event) => {
  if (event.data?.sessionId !== localStorage.getItem("the-black-ledger.session.v1")) return;
  try { events = await loadLedger(); render(); showToast("The ledger was refreshed from another tab."); }
  catch (error) { showToast(error.message); }
});
document.querySelector("#export-button").addEventListener("click", async () => {
  try { await exportLedger(); showToast("The integrity-checked evidence package was exported."); }
  catch (error) { showToast(error.message); }
});
document.querySelector("#cancel-archive").addEventListener("click", () => document.querySelector("#confirm-dialog").close());
document.querySelector("#confirm-archive").addEventListener("click", () => {
  const current = ledger();
  const provisional = current.closureBlockers.length > 0;
  document.querySelector("#confirm-dialog").close();
  commit(provisional ? "SESSION_CLOSED_PROVISIONAL" : "SESSION_CLOSED_FINAL", { reason: provisional ? "Organizer accepted a provisional close; outstanding records remain visible." : "All closure checks passed." }, provisional ? "Provisional close recorded. The ledger remains open for resolution." : "The journey was finally closed. Its record is read-only.");
});
render();
const paymentReturn = new URLSearchParams(location.search);
if (paymentReturn.get("payment") === "return" && paymentReturn.get("token")) {
  const orderId = paymentReturn.get("token");
  history.replaceState(null, "", `${location.pathname}#payments`);
  const sessionId = localStorage.getItem("the-black-ledger.session.v1");
  fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` } })
    .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "PayPal capture failed."); return result; })
    .then(async (result) => { events = await loadLedger(); render(); showToast(result.status === "COMPLETED" ? "PayPal capture confirmed by the server." : "PayPal payment is still pending confirmation."); })
    .catch((error) => showToast(error.message));
} else if (paymentReturn.get("payment") === "cancel") {
  const orderId = paymentReturn.get("token");
  history.replaceState(null, "", `${location.pathname}#payments`);
  if (orderId) {
    const sessionId = localStorage.getItem("the-black-ledger.session.v1");
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` } })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Could not record checkout cancellation."); events = await loadLedger(); render(); showToast("PayPal checkout was cancelled. Ledger balances did not change."); })
      .catch((error) => showToast(error.message));
  } else showToast("PayPal checkout was cancelled. Ledger balances did not change.");
}
