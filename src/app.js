import { deriveLedger, formatMoney, parseAmountToMinor, SUPPORTED_CURRENCIES, settleUp } from "./domain.js";
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
const ledgerCurrency = () => events?.find((event) => event.type === "SESSION_CREATED")?.baseCurrency ?? "USD";
const money = (minor) => formatMoney(minor, ledgerCurrency());
const parseLedgerAmount = (value) => parseAmountToMinor(value, ledgerCurrency());
const ledger = () => deriveLedger(events, { baseCurrency: ledgerCurrency() });
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

async function commitFromForm(form, type, fields, successMessage) {
  const submit = form.querySelector("button[type=submit]");
  const errorOutput = form.querySelector("[data-action-error]");
  if (submit) submit.disabled = true;
  if (errorOutput) { errorOutput.hidden = true; errorOutput.textContent = ""; }
  try {
    events = await appendEvent(events, type, fields);
    const warnings = takeAppendWarnings();
    render();
    showToast(warnings.length ? `Possible duplicate: ${warnings.map((item) => item.reason).join("; ")}. Check the record; nothing was removed.` : successMessage);
    return true;
  } catch (error) {
    if (submit) submit.disabled = false;
    if (errorOutput) { errorOutput.textContent = `${error.message} Your entries are still here. Reload if this ledger changed in another session, then retry.`; errorOutput.hidden = false; }
    showToast(error.message);
    return false;
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
    <section class="stat-grid"><article class="stat-card"><span>BOUND TO THIS JOURNEY</span><strong>${current.members.length}</strong><small>participants</small></article><article class="stat-card"><span>RECORDED EXPENDITURE</span><strong>${money(current.totalExpenses)}</strong><small>${current.expenses.length} expense${current.expenses.length === 1 ? "" : "s"}</small></article><article class="stat-card"><span>ACCOUNT CONDITION</span><strong class="condition ${balanceStatus === "Balanced" ? "good" : "pending"}">${balanceStatus}</strong><small>${current.settlements.length} recorded settlement${current.settlements.length === 1 ? "" : "s"}</small></article></section>
    ${narrative ? `<div class="calculation-note"><span>◇</span><p><b>Fictional witness:</b> ${h(narrative.text)} This story never changes a balance.</p></div>` : ""}
    <div class="content-grid"><section class="panel"><div class="section-title"><div><div class="eyebrow">THE WITNESSES</div><h2>People in the ledger</h2></div><a href="#members" class="text-button">All participants ↗</a></div>${current.members.length ? `<div class="member-list">${current.members.slice(0, 5).map((m) => memberCard(m, current)).join("")}</div>` : emptyState("No names have been entered.", "Add the people who shared this journey.", "#members", "Add the first participant")}</section><section class="panel recent-panel"><div class="section-title"><div><div class="eyebrow">THE LAST IMPRESSION</div><h2>Recent events</h2></div><a href="#history" class="text-button">Open memory ↗</a></div>${current.events.length ? `<div class="event-list compact">${[...current.events].reverse().slice(0, 4).map(eventRow).join("")}</div>` : emptyState("The pages are blank.", "The first record is waiting.", "#expenses", "Add an expense")}</section></div>
    ${current.archived ? `<div class="sealed-banner"><span>✦</span><div><b>This journey is sealed.</b><p>Its record is read-only. Export it from the footer.</p></div></div>` : current.closure?.type === "provisional" ? `<div class="sealed-banner"><span>!</span><div><b>This journey has a provisional close.</b><p>${current.closureBlockers.length} open item(s) remain visible. Add records to resolve them, then close again.</p></div></div>` : current.events.length && access.role === "organizer" ? `<section class="closing-strip"><div><div class="eyebrow">WHEN THE JOURNEY ENDS</div><b>Keep the memory. Close the books.</b><p>A final close requires resolved records and zero balances. Otherwise the close stays provisional.</p></div><button class="button button-quiet" id="archive-button" type="button">Close this journey <span>→</span></button></section>` : ""}`;
}

function memberCard(member, current, showStatusControl = false) {
  const cents = current.balances.get(member.id) || 0;
  const status = member.status ?? "active";
  const statusControl = showStatusControl && getAccessContext().role === "organizer" && !current.archived && status !== "removed" ? `<button class="button button-quiet member-status" type="button" data-member-id="${h(member.id)}" data-next-status="${status === "active" ? "departed" : "active"}">${status === "active" ? "Mark departed" : "Reactivate"}</button>` : "";
  return `<article class="member-row"><span class="avatar">${h(member.name.trim().slice(0, 1).toUpperCase())}</span><span class="member-name"><b>${h(member.name)}</b><small>${status === "active" ? "Active participant" : h(status)} · Witness ${String(current.members.findIndex((m) => m.id === member.id) + 1).padStart(2, "0")}</small></span><strong class="money ${cents > 0 ? "credit" : cents < 0 ? "debit" : "neutral"}">${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}</strong>${statusControl}</article>`;
}

function emptyState(title, body, href, action) {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><b>${title}</b><p>${body}</p><a class="text-button" href="${href}">${action} ↗</a></div>`;
}

function membersPage(current) {
  const canAdmin = getAccessContext().role === "organizer";
  const agreementFields = [["shared_costs", "Shared costs", "Which costs are shared, and who is included?"], ["personal_costs", "Personal costs", "Which expenses remain personal?"], ["tips", "Tips and service charges", "How are tips and service charges split?"], ["cancellations", "Cancellations", "How are cancellations and non-refundable costs handled?"], ["payment_deadline", "Settlement deadline", "When should outstanding balances be settled?"]];
  const agreement = new Map();
  for (const event of current.events) if (event.type === "SESSION_RULES_RECORDED") for (const rule of event.rules) agreement.set(rule.category, { ...rule, at: event.at });
  return `${header("The Broken Mirror", "Reflections of those bound by this journey.", "CHAMBER 01 · THE WITNESSES")}
    <section class="feature-card mirror-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/broken-mirror.png" alt=""></div><div><div class="eyebrow">A NAME ENTERED BECOMES A WITNESS</div><h2>Who shared the account?</h2><p>Add the people whose spending and contributions belong in this ledger. This local level is operated by one organizer.</p></div></section>
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="member-form"><label for="member-name">Participant name</label><div class="input-row"><input id="member-name" name="name" maxlength="48" placeholder="e.g. Alex" required autocomplete="off"><button class="button button-gold" type="submit">Add to the mirror <span>↗</span></button></div><small>Up to 100 names. Entries are saved to the shared event log.</small></form>` : ""}
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="invite-form"><label for="invite-name">Invite someone to this ledger</label><div class="input-row"><input id="invite-name" name="name" maxlength="80" placeholder="Participant name" required><select name="role"><option value="member">Participant</option><option value="witness">Read-only witness</option></select><button class="button button-quiet" type="submit">Create invite link</button></div><output id="invite-link" aria-live="polite"></output></form>` : ""}
    ${!current.archived && canAdmin && current.members.length ? `<form class="form-panel inline-form" id="group-form"><label for="group-name">Create a temporary subgroup</label><div class="input-row"><input id="group-name" name="name" maxlength="80" placeholder="e.g. Museum afternoon" required><button class="button button-quiet" type="submit">Create subgroup</button></div><fieldset class="beneficiary-fieldset"><legend>Participants</legend><div class="check-grid">${current.members.map((member) => `<label class="check-row"><input type="checkbox" name="groupMember" value="${h(member.id)}"><span>${h(member.name)}</span></label>`).join("")}</div></fieldset></form>` : ""}
    ${!current.archived && canAdmin ? `<form class="form-panel agreement-form" id="agreement-form"><div class="eyebrow">AGREED BEFORE THE JOURNEY</div><h2>Record shared expectations</h2><p>Each statement is saved with its timestamp. Later updates add a new record to the history.</p>${agreementFields.map(([category, label, placeholder]) => `<label>${label}<textarea name="${category}" maxlength="500" rows="2" placeholder="${placeholder}">${h(agreement.get(category)?.text ?? "")}</textarea></label>`).join("")}<output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Save agreement record</button></form>` : ""}
    ${agreement.size ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">CURRENT AGREEMENT</div><h2>Rules of this journey</h2></div><span class="count">${agreement.size} topics</span></div><div class="agreement-list">${agreementFields.filter(([category]) => agreement.has(category)).map(([category, label]) => `<article><b>${label}</b><p>${h(agreement.get(category).text)}</p><small>Recorded ${eventDate(agreement.get(category).at)}</small></article>`).join("")}</div></section>` : ""}
    ${current.groups.length ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">TEMPORARY PARTIES</div><h2>Subgroups</h2></div><span class="count">${current.groups.length} groups</span></div><div class="member-list">${current.groups.map((group) => `<article class="member-row"><span class="avatar">◌</span><span class="member-name"><b>${h(group.name)}</b><small>${group.memberIds.map((id) => h(memberName(id))).join(", ")}</small></span></article>`).join("")}</div></section>` : ""}
    <section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE PRESENT</div><h2>Participants <span class="count">${current.members.length} / 100</span></h2></div></div>${current.members.length ? `<div class="member-list full-list">${current.members.map((m) => memberCard(m, current, true)).join("")}</div>` : emptyState("No reflections yet.", "Add the first participant to begin.", "#members", "Add a participant")}</section>`;
}

function expensePage(current) {
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const payerOptions = current.members.filter((member) => access.role !== "member" || member.id === access.memberId);
  const enough = current.members.length >= 1;
  const rows = current.members.map((m) => `<label class="check-row"><input type="checkbox" name="beneficiary" value="${h(m.id)}" checked><span>${h(m.name)}</span></label>`).join("");
  const groupOptions = current.groups.map((group) => `<option value="${h(group.id)}">${h(group.name)}</option>`).join("");
  const currencyOptions = SUPPORTED_CURRENCIES.map((currency) => `<option value="${currency}" ${currency === ledgerCurrency() ? "selected" : ""}>${currency}</option>`).join("");
  const feePayerOptions = current.members.map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  return `${header("The Black Telephone", "Every expense leaves a trace. Every share has a rule.", "CHAMBER 02 · THE EVIDENCE")}
    <section class="feature-card phone-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/black-telephone.png" alt=""></div><div><div class="eyebrow">THE RECEIPT IS EVIDENCE</div><h2>Enter what happened.</h2><p>Receipt analysis proposes details for a person to review. It never writes into the ledger by itself.</p></div><span class="coming-tag">HUMAN REVIEW</span></section>
    ${!current.archived && !readOnly ? `<section class="form-panel"><label for="receipt-image">Receipt image</label><div class="input-row"><input id="receipt-image" type="file" accept="image/jpeg,image/png,image/webp"><button class="button button-quiet" id="analyze-receipt" type="button">Propose receipt details</button></div><pre id="receipt-proposal" hidden aria-live="polite"></pre></section>` : ""}
    ${!enough ? emptyState("The table is empty.", "Enter at least one participant before recording a cost.", "#members", "Open the Broken Mirror") : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? "Read-only witness access." : "This ledger is read-only."}</b><p>${readOnly ? "You can inspect the expenses and their evidence." : "Start another ledger to record new expenses."}</p></div></div>` : `<form class="form-panel expense-form" id="expense-form"><div class="form-heading"><div><div class="eyebrow">A NEW ENTRY</div><h2>Record an expense</h2></div><span class="form-index">02 / 05</span></div><div class="field-grid"><label>Description<input name="description" maxlength="120" placeholder="Dinner, train tickets…" required></label><label>Receipt currency<select name="currency" id="expense-currency">${currencyOptions}</select></label><label><span id="source-total-label">Total amount · ${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" required></label><label>Paid by<select name="payer" required><option value="unassigned">Unknown / unassigned</option>${payerOptions.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("")}</select></label><label>Allocation rule<select name="splitMode" id="split-mode"><option value="equal">Split equally</option><option value="custom">Enter each share</option></select></label>${groupOptions ? `<label>Apply a subgroup<select name="group" id="expense-group"><option value="">All participants</option>${groupOptions}</select></label>` : ""}</div><fieldset id="fx-fields" class="form-panel fx-fields" hidden><legend>Conversion evidence · target ${h(ledgerCurrency())}</legend><div class="field-grid"><label>Ledger total · ${h(ledgerCurrency())}<input name="baseAmount" inputmode="decimal"></label><label>${h(ledgerCurrency())} per 1 <span id="fx-source-currency">foreign unit</span><input name="fxRate" inputmode="decimal" placeholder="1.08"></label><label>Rate source<input name="fxSource" maxlength="120" placeholder="Card statement, exchange receipt…"></label><label>Rate observed at<input name="fxObservedAt" type="datetime-local"></label><label>Conversion fee · ${h(ledgerCurrency())}<input name="fxFee" inputmode="decimal" value="0"></label><label>Fee paid by<select name="fxFeePayer"><option value="">No conversion fee</option>${feePayerOptions}</select></label></div><p class="field-hint">Enter the rate as an exact decimal. The converted total and fee must reconcile to the ledger total.</p></fieldset><fieldset class="beneficiary-fieldset"><legend>Who benefited from this expense?</legend><div class="check-grid">${rows}</div></fieldset><div id="custom-shares" class="custom-shares" hidden></div><div class="form-footer"><p>Shares reconcile to the ledger total. Unknown charges stay unassigned until identified.</p><button class="button button-gold" type="submit">Write into the ledger <span>↗</span></button></div></form>`}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">THE RECORD</div><h2>Recorded expenses</h2></div><span class="count">${current.expenses.length} entries</span></div>${current.expenses.length ? `<div class="expense-list">${[...current.expenses].reverse().map((expense) => expenseRow(expense, current)).join("")}</div>` : emptyState("Nothing has been recorded.", "The first expense will appear here.", "#expenses", "Record an expense")}</section>
    ${commitmentSection(current)}
    ${giftSection(current)}
    ${budgetSection(current)}
    ${recurringSection(current)}`;
}

function recurringSection(current) {
  const canManage = getAccessContext().role === "organizer" && !current.archived;
  const participantChecks = current.members.filter((member) => (member.status ?? "active") === "active").map((member) => `<label class="check-row"><input type="checkbox" name="recurringMember" value="${h(member.id)}" checked><span>${h(member.name)}</span></label>`).join("");
  const activePayers = current.members.filter((member) => (member.status ?? "active") === "active").map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  const createForm = canManage ? `<form class="form-panel" id="recurring-rule-form"><div class="eyebrow">REPEATING OBLIGATION</div><h2>Approve a recurring expense</h2><div class="field-grid"><label>Description<input name="description" maxlength="180" required></label><label>Expected amount · ${h(ledgerCurrency())}<input name="amount" inputmode="decimal" required></label><label>Cadence<input name="cadence" maxlength="40" placeholder="Monthly" required></label></div><fieldset class="beneficiary-fieldset"><legend>Default allocation</legend><div class="check-grid">${participantChecks}</div></fieldset><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Approve recurring rule</button></form>` : "";
  const rules = current.recurringRules.map((rule) => {
    const periods = current.recurringPeriods.filter((entry) => entry.startsWith(`${rule.ruleId}:`)).map((entry) => entry.slice(rule.ruleId.length + 1));
    const recorded = periods.length ? periods.map((period) => `<span class="count">${h(period)}</span>`).join(" ") : "No periods recorded";
    const generateForm = canManage && activePayers ? `<form class="recurring-instance-form" data-rule-id="${h(rule.ruleId)}"><label>Period key<input name="periodKey" maxlength="40" placeholder="2026-10" required></label><label>Paid by<select name="payerMemberId" required>${activePayers}</select></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record this period</button></form>` : "";
    return `<article class="recurring-row"><div><b>${h(rule.description)}</b><small>${h(rule.cadence)} · ${rule.allocations.length} allocated participants · ${money(rule.amountMinor)}</small></div><div class="recurring-periods"><small>Recorded periods:</small> ${recorded}</div>${generateForm}</article>`;
  }).join("");
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE CLOCKWORK ACCOUNT</div><h2>Recurring expenses</h2></div><span class="count">${current.recurringRules.length} rules</span></div>${createForm}${rules ? `<div class="recurring-list">${rules}</div>` : `<p class="empty-inline">No recurring expenses have been approved.</p>`}</section>`;
}

function budgetSection(current) {
  const canManage = getAccessContext().role === "organizer" && !current.archived;
  const form = canManage ? `<form class="form-panel" id="budget-form"><div class="eyebrow">AGREED ALLOWANCE</div><h2>Set a travel budget</h2><div class="field-grid"><label>Budget label<input name="period" maxlength="80" placeholder="Lisbon weekend" required></label><label>Limit · ${h(ledgerCurrency())}<input name="amount" inputmode="decimal" required></label></div><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record budget</button><p class="field-hint">Each new budget starts a fresh tracking period. The ledger keeps earlier limits in its event history.</p></form>` : "";
  const entries = current.budgets.map((budget, index) => {
    const spentMinor = current.expenses.filter((expense) => expense.status !== "unassigned" && Date.parse(expense.at) >= Date.parse(budget.at)).reduce((sum, expense) => sum + expense.baseAmountMinor, 0);
    const active = index === current.budgets.length - 1;
    const over = spentMinor >= budget.amountMinor;
    return `<article class="budget-row"><div><b>${h(budget.period)}</b><small>${active ? "Current budget" : "Previous limit"} · Set ${eventDate(budget.at)} · ${over ? "Limit reached" : "Within limit"}</small></div><progress max="${budget.amountMinor}" value="${Math.min(spentMinor, budget.amountMinor)}" aria-label="${h(budget.period)} budget usage"></progress><strong>${money(spentMinor)} / ${money(budget.amountMinor)}</strong></article>`;
  }).join("");
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE BLEEDING ALLOWANCE</div><h2>Travel budgets</h2></div><span class="count">${current.budgets.length} records</span></div>${form}${entries ? `<div class="budget-list">${entries}</div>` : `<p class="empty-inline">No budget has been agreed for this journey.</p>`}</section>`;
}

function giftSection(current) {
  const access = getAccessContext();
  const canCreate = access.role === "organizer" && !current.archived && current.members.length >= 2;
  const defaultRecipient = current.members[0]?.id;
  const recipients = current.members.map((member) => `<option value="${h(member.id)}" ${member.id === defaultRecipient ? "selected" : ""}>${h(member.name)}</option>`).join("");
  const payers = current.members.filter((member) => member.id !== defaultRecipient).map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  const contributors = current.members.map((member) => `<label class="check-row"><input type="checkbox" name="giftContributor" value="${h(member.id)}" ${member.id === defaultRecipient ? "" : "checked"}><span>${h(member.name)}</span></label>`).join("");
  const form = canCreate ? `<form class="form-panel" id="gift-form"><div class="eyebrow">THE PACT OF SILENCE</div><h2>Record a surprise gift</h2><div class="field-grid"><label>Private description<input name="description" maxlength="240" required></label><label>Amount <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" required></label><label>Recipient<select name="recipient" id="gift-recipient" required>${recipients}</select></label><label>Who paid upfront?<select name="payer" id="gift-payer" required>${payers}</select></label></div><fieldset class="beneficiary-fieldset"><legend>Who contributed? The recipient cannot be included.</legend><div class="check-grid">${contributors}</div></fieldset><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record privately</button><p class="field-hint">The recipient sees a confidential entry; other ledger participants can review its description and contributions.</p></form>` : "";
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE PACT OF SILENCE</div><h2>Surprise gifts</h2></div><span class="count">${current.gifts.length} records</span></div>${form}${!current.gifts.length ? `<p class="empty-inline">No surprise gifts have been recorded.</p>` : `<div class="member-list">${current.gifts.map((gift) => `<article class="member-row"><span class="avatar">✳</span><span class="member-name"><b>${access.memberId === gift.recipientMemberId ? "Confidential surprise gift" : h(gift.privateDescription)}</b><small>For ${h(current.members.find((member) => member.id === gift.recipientMemberId)?.name ?? "Unknown participant")} · ${gift.contributions.length} contributor${gift.contributions.length === 1 ? "" : "s"}</small></span><strong>${money(gift.amountMinor)}</strong></article>`).join("")}</div>`}</section>`;
}

function commitmentSection(current) {
  const access = getAccessContext();
  const canCreate = !current.archived && access.role !== "witness" && current.members.length > 0;
  const payerOptions = current.members.filter((member) => access.role !== "member" || member.id === access.memberId).map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  const participantOptions = current.members.map((member) => `<label class="check-row"><input type="checkbox" name="commitmentMember" value="${h(member.id)}" checked><span>${h(member.name)}</span></label>`).join("");
  const form = canCreate ? `<form class="form-panel" id="commitment-form"><div class="eyebrow">BEFORE THE RECEIPT</div><h2>Record a commitment</h2><div class="field-grid"><label>Description<input name="description" maxlength="240" required></label><label>Expected amount <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" required></label><label>Who committed to pay?<select name="payer" required>${payerOptions}</select></label><label>Refundability<select name="refundability" required><option value="refundable">Refundable</option><option value="partially_refundable">Partially refundable</option><option value="nonrefundable">Non-refundable</option></select></label></div><fieldset class="beneficiary-fieldset"><legend>Who shares this commitment?</legend><div class="check-grid">${participantOptions}</div></fieldset><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record commitment</button></form>` : "";
  const entries = current.commitments.map((item) => {
    const payerName = current.members.find((member) => member.id === item.payerMemberId)?.name ?? "Unknown participant";
    const remaining = item.amountMinor - (item.refundedMinor ?? 0);
    const linkedExpense = current.expenses.find((expense) => expense.commitmentId === item.commitmentId && expense.status !== "unassigned");
    const canManage = !current.archived && item.status === "open" && (access.role === "organizer" || access.role === "member" && access.memberId === item.payerMemberId);
    const refundForm = canManage && item.refundability !== "nonrefundable" && remaining > 0 ? `<form class="commitment-refund-form" data-commitment-id="${h(item.commitmentId)}" data-max-refund="${remaining}"><label>Record a refund <span class="field-hint">up to ${money(remaining)}</span><input name="amount" inputmode="decimal" required></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record refund</button></form>` : "";
    const outcomeControls = canManage ? linkedExpense ? `<button class="button button-quiet commitment-outcome" type="button" data-commitment-id="${h(item.commitmentId)}" data-outcome="consumed">Finish as used</button><button class="button button-quiet commitment-outcome" type="button" data-commitment-id="${h(item.commitmentId)}" data-outcome="cancelled">Finish as cancelled</button>` : `<button class="button button-quiet commitment-outcome" type="button" data-commitment-id="${h(item.commitmentId)}" data-outcome="consumed" ${remaining === 0 ? "disabled" : ""}>Record as used</button><button class="button button-quiet commitment-outcome" type="button" data-commitment-id="${h(item.commitmentId)}" data-outcome="cancelled">Cancel and record remaining cost</button>` : "";
    return `<article class="commitment-row"><div><b>${h(item.description)}</b><small>Committed by ${h(payerName)} · ${h(item.refundability.replaceAll("_", " "))} · ${h(item.status)}</small></div><strong>${money(item.amountMinor)}</strong>${item.refundedMinor ? `<small>Refunded ${money(item.refundedMinor)} · remaining exposure ${money(remaining)}</small>` : ""}${linkedExpense ? `<small>Linked expense: ${h(linkedExpense.description)}</small>` : ""}${refundForm}${outcomeControls ? `<div class="commitment-actions">${outcomeControls}</div>` : ""}</article>`;
  }).join("");
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">RESERVATIONS AND CANCELLATIONS</div><h2>Commitments</h2></div><span class="count">${current.commitments.length} records</span></div>${form}${entries ? `<div class="commitment-list">${entries}</div>` : `<p class="empty-inline">No commitments recorded. Add a reservation before its final cost is known.</p>`}</section>`;
}

function allocateWeighted(totalMinor, rows) {
  const weights = rows.map((row) => BigInt(row.baseMinor ?? row.amountMinor ?? row.cents));
  const weightTotal = weights.reduce((sum, value) => sum + value, 0n);
  if (weightTotal <= 0n) throw new Error("The commitment has no positive participant shares to allocate.");
  const portions = weights.map((weight, index) => {
    const numerator = BigInt(totalMinor) * weight;
    return { memberId: rows[index].memberId, amount: numerator / weightTotal, remainder: numerator % weightTotal, index };
  });
  let unallocated = BigInt(totalMinor) - portions.reduce((sum, row) => sum + row.amount, 0n);
  for (const portion of [...portions].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1)) {
    if (unallocated === 0n) break;
    portion.amount += 1n;
    unallocated -= 1n;
  }
  return portions.map(({ memberId, amount }) => ({ memberId, cents: Number(amount) }));
}

function decimalRateToRatio(value) {
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d{1,12}))?$/.exec(String(value ?? "").trim());
  if (!match) throw new Error("Enter a positive exchange rate with at most 12 decimal places.");
  const fraction = match[2] ?? "";
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (numerator <= 0n) throw new Error("Exchange rate must be greater than zero.");
  const gcd = (a, b) => b === 0n ? a : gcd(b, a % b);
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return { numerator: String(numerator), denominator: String(denominator) };
}

function expenseCurrencyDetails(data) {
  const currency = String(data.get("currency") || ledgerCurrency()).toUpperCase();
  const amountMinor = parseAmountToMinor(data.get("amount"), currency);
  if (currency === ledgerCurrency()) return { currency, amountMinor, baseAmountMinor: amountMinor, fx: null };
  const baseAmountMinor = parseLedgerAmount(data.get("baseAmount"));
  const feeText = String(data.get("fxFee") ?? "").trim();
  const feeMinor = feeText ? parseLedgerAmount(feeText) : 0;
  const ratio = decimalRateToRatio(data.get("fxRate"));
  const observedAt = new Date(String(data.get("fxObservedAt")));
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Enter when this exchange rate was observed.");
  const source = String(data.get("fxSource") ?? "").trim();
  if (!source) throw new Error("Enter the source of the exchange rate.");
  const feePayerMemberId = String(data.get("fxFeePayer") ?? "");
  if (feeMinor > 0 && !feePayerMemberId) throw new Error("Choose who paid the conversion fee.");
  return { currency, amountMinor, baseAmountMinor, fx: { sourceCurrency: currency, targetCurrency: ledgerCurrency(), ...ratio, source, observedAt: observedAt.toISOString(), feeMinor, ...(feeMinor ? { feePayerMemberId } : {}) } };
}

function expenseRow(event, current) {
  const groupNames = (event.groupIds ?? []).map((id) => current.groups.find((group) => group.id === id)?.name).filter(Boolean);
  const originalAmount = event.currency !== ledgerCurrency() ? ` · original ${formatMoney(event.amountMinor, event.currency)}` : "";
  const fxEvidence = event.fx ? ` · FX ${event.fx.numerator}/${event.fx.denominator} ${event.fx.targetCurrency}/${event.fx.sourceCurrency} from ${h(event.fx.source)} at ${eventDate(event.fx.observedAt)}` : "";
  const feeEvidence = event.fx?.feeMinor ? ` · conversion fee ${money(event.fx.feeMinor)} paid by ${h(current.members.find((member) => member.id === event.fx.feePayerMemberId)?.name ?? "Unknown participant")}` : "";
  return `<article class="expense-row"><span class="row-icon">⌕</span><span class="expense-meta"><b>${h(event.description)}</b><small>Paid by ${h(current.members.find((member) => member.id === event.payerId)?.name ?? "Unknown participant")} · Shared by ${event.allocations.length} participant${event.allocations.length === 1 ? "" : "s"}${groupNames.length ? ` · ${groupNames.map(h).join(", ")}` : ""}${originalAmount}${fxEvidence}${feeEvidence} · ${eventDate(event.at)}</small></span><strong>${money(event.totalCents)}</strong>${expenseReview(event, current)}</article>`;
}

function expenseReview(expense, current) {
  const access = getAccessContext();
  const confirmations = current.confirmations.filter((item) => item.expenseId === expense.id);
  const discrepancies = current.discrepancies.filter((item) => item.expenseId === expense.id);
  const assigned = access.role === "member" && (expense.payerId === access.memberId || expense.allocations.some((row) => row.memberId === access.memberId));
  const ownConfirmation = confirmations.find((item) => item.memberId === access.memberId);
  const openOwnDispute = discrepancies.find((item) => item.raisedByMemberId === access.memberId && !item.resolution);
  const canAct = assigned && !current.archived;
  const reviewSummary = confirmations.length ? confirmations.map((item) => `${h(current.members.find((member) => member.id === item.memberId)?.name ?? "Unknown participant")}: ${h(item.decision)}`).join(" · ") : "No participant has confirmed a share yet.";
  const confirmationControl = canAct ? ownConfirmation?.decision === "accepted" ? `<span class="status-pill open">Your share is confirmed</span>` : `<button class="button button-quiet expense-confirm" type="button" data-expense-id="${h(expense.id)}">Confirm my share</button>` : "";
  const disputeControl = canAct && !openOwnDispute ? `<details class="expense-dispute"><summary>Report a discrepancy</summary><form class="discrepancy-form" data-expense-id="${h(expense.id)}"><label>What does not match?<textarea name="claim" maxlength="500" required></textarea></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record discrepancy</button></form></details>` : openOwnDispute ? `<p class="dispute-note">Your discrepancy is awaiting resolution.</p>` : "";
  const disputeRows = discrepancies.map((item) => `<div class="dispute-note"><b>${h(current.members.find((member) => member.id === item.raisedByMemberId)?.name ?? "Unknown participant")} reported:</b> ${h(item.claim)}${item.resolution ? `<br><b>Resolution:</b> ${h(item.resolution)}` : access.role === "organizer" && !current.archived ? `<form class="resolution-form" data-discrepancy-id="${h(item.discrepancyId)}"><label>Resolution<textarea name="resolution" maxlength="500" required></textarea></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Resolve discrepancy</button></form>` : "<br><span>Awaiting organizer review.</span>"}</div>`).join("");
  return `<section class="expense-review" aria-label="Participant review for ${h(expense.description)}"><p><b>Share review:</b> ${reviewSummary}</p>${confirmationControl}${disputeControl}${disputeRows}</section>`;
}

function eventDescription(event) {
  if (event.type === "MEMBER_ADDED") return `<b>${h(event.name)}</b> entered the mirror`;
  if (event.type === "MEMBER_INVITED") return `<b>${h(event.name)}</b> was invited as a ${h(event.role)}`;
  if (event.type === "EXPENSE_RECORDED") return `Expense recorded: <b>${h(event.description)}</b> · ${money(event.totalCents)}`;
  if (event.type === "EXPENSE_UNASSIGNED") return `Unassigned charge recorded: <b>${h(event.description)}</b> · ${money(event.totalCents ?? event.amountMinor)}`;
  if (event.type === "SETTLEMENT_RECORDED") return `Settlement recorded: <b>${h(memberName(event.fromId))}</b> → <b>${h(memberName(event.toId))}</b> · ${money(event.cents)}`;
  if (event.type === "SETTLEMENT_ASSERTED") return `Payment claim pending: <b>${h(memberName(event.fromMemberId))}</b> → <b>${h(memberName(event.toMemberId))}</b> · ${money(event.amountMinor)}`;
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
  const paypalButton = ledgerCurrency() === "USD" ? `<button class="button button-quiet" id="paypal-checkout" type="button">Pay through PayPal Sandbox</button>` : "";
  return `${header("The Elixir", "Record a claimed settlement without confusing it for provider proof.", "CHAMBER 04 · THE SETTLEMENT")}
    <section class="feature-card elixir-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/elixir-vial.png" alt=""></div><div><div class="eyebrow">THE VIAL OF DEBT</div><h2>A payment changes the account.</h2><p>A claimed transfer stays pending. Only recipient confirmation or a completed PayPal capture changes balances.</p></div><span class="coming-tag">VERIFIED STATES</span></section>
    ${!enough ? emptyState("Two witnesses are needed.", "Add at least two participants to record a settlement.", "#members", "Open the Broken Mirror") : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? "Read-only witness access." : "This ledger is read-only."}</b><p>${readOnly ? "You can inspect payment states and confirm receipts addressed to you." : "Its settlement history remains available below."}</p></div></div>` : `<form class="form-panel payment-form" id="payment-form"><div class="form-heading"><div><div class="eyebrow">A CLAIM OF PAYMENT</div><h2>Record a settlement</h2></div><span class="form-index">04 / 05</span></div><div class="field-grid"><label>Who paid?<select name="from" required>${payerOptions}</select></label><label>Who received?<select name="to" required>${options}</select></label><label>Amount <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" placeholder="0.00" required></label></div><div class="honesty-note"><span>i</span><p><b>This remains a pending claim.</b> It does not reduce balances until the recipient confirms the transfer or PayPal reports a completed capture.</p></div><div class="form-footer"><p>A claim must match an outstanding obligation between these participants.</p><div><button class="button button-gold" type="submit">Record pending claim <span>↗</span></button>${paypalButton}</div></div></form>`}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">PAYMENT RECORD</div><h2>Settlements recorded</h2></div><span class="count">${current.settlements.length} entries</span></div>${current.settlements.length ? `<div class="expense-list">${[...current.settlements].reverse().map((event) => `<article class="expense-row"><span class="row-icon payment-icon">♢</span><span class="expense-meta"><b>${h(memberName(event.fromId))} → ${h(memberName(event.toId))}</b><small>${h(event.status ?? "recorded")} · ${eventDate(event.at)}</small></span><strong>${money(event.cents)}</strong>${event.status === "pending" && event.rail !== "paypal" && event.toId === access.memberId ? `<button type="button" class="button button-quiet confirm-payment" data-settlement-id="${h(event.settlementId)}">Confirm receipt</button>` : ""}</article>`).join("")}</div>` : emptyState("No settlement has been recorded.", "A claimed payment will be listed here.", "#payments", "Record a settlement")}</section>`;
}

function verdictPage(current) {
  const transfers = settleUp(current.balances);
  const allBalanced = [...current.balances.values()].every((value) => value === 0);
  return `${header("The Verdict", "Every number has a source. Every remainder has a rule.", "CHAMBER 05 · THE CALCULATION")}
    <section class="verdict-paper"><div class="paper-seal">✳</div><div class="paper-eyebrow">THE BLACK LEDGER · ACCOUNT ${String(current.events.length).padStart(3, "0")}</div><h2>The Verdict</h2><p class="paper-subtitle">“The account is derived from what was entered.”</p><div class="paper-rule"></div>${allBalanced ? `<div class="balanced-result"><span>✦</span><h3>The balance is restored.</h3><p>Every recorded participant stands at zero.</p></div>` : `<h3 class="paper-section-title">Suggested transfers</h3>${transfers.length ? `<div class="transfer-list">${transfers.map((t, i) => `<article class="transfer-row"><span class="transfer-num">${String(i + 1).padStart(2, "0")}</span><span><b>${h(memberName(t.fromId))}</b><small>must pay</small><b>${h(memberName(t.toId))}</b></span><strong>${money(t.cents)}</strong></article>`).join("")}</div>` : `<p class="paper-empty">Add participants and expenses to render a verdict.</p>`}`}<div class="paper-rule"></div><p class="paper-foot">Calculated from ${current.expenses.length} expense${current.expenses.length === 1 ? "" : "s"} and ${current.settlements.length} recorded settlement${current.settlements.length === 1 ? "" : "s"}. No floating-point amounts.</p></section>
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
      const proposalCurrency = String(result.proposal.currency ?? "").toUpperCase();
      if (form && proposalCurrency && SUPPORTED_CURRENCIES.includes(proposalCurrency)) {
        form.elements.currency.value = proposalCurrency;
        form.elements.currency.dispatchEvent(new Event("change"));
      }
      if (form && result.proposal.merchant) form.elements.description.value = result.proposal.merchant;
      if (form && result.proposal.total) form.elements.amount.value = result.proposal.total;
      showToast("Proposal ready and receipt evidence attached. Review each value before recording.");
    } catch (error) { if (output) { output.hidden = false; output.textContent = error.message; } }
  });

  document.querySelector("#member-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name").trim();
    if (!name || current.members.length >= 100) return showToast("Enter a name; the ledger supports up to 100 participants.");
    commit("MEMBER_ADDED", { memberId: crypto.randomUUID(), name }, `${name} entered the mirror.`);
  });

  document.querySelectorAll(".member-status").forEach((button) => button.addEventListener("click", () => {
    const nextStatus = button.dataset.nextStatus;
    const name = current.members.find((member) => member.id === button.dataset.memberId)?.name ?? "Participant";
    commit("MEMBER_STATUS_CHANGED", { memberId: button.dataset.memberId, status: nextStatus }, nextStatus === "departed" ? `${name} marked as departed. Their ledger history and obligations remain.` : `${name} reactivated.`);
  }));

  document.querySelector("#group-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const memberIds = data.getAll("groupMember");
    if (!memberIds.length) return showToast("Choose at least one participant for the subgroup.");
    const name = String(data.get("name")).trim();
    commit("GROUP_CREATED", { groupId: crypto.randomUUID(), name, memberIds }, `Subgroup ${name} created.`);
  });

  document.querySelector("#commitment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const form = event.currentTarget;
      const data = new FormData(form);
      const amountMinor = parseLedgerAmount(data.get("amount"));
      const memberIds = data.getAll("commitmentMember");
      if (!memberIds.length) throw new Error("Select at least one participant who shares this commitment.");
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const allocations = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(form, "COMMITMENT_RECORDED", { commitmentId: crypto.randomUUID(), description: String(data.get("description")).trim(), amountMinor, payerMemberId: data.get("payer"), allocations, refundability: data.get("refundability") }, "Commitment recorded; its final cost remains separate from expenses.");
    } catch (error) {
      const output = event.currentTarget.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  });

  const giftForm = document.querySelector("#gift-form");
  const updateGiftRecipient = () => {
    if (!giftForm) return;
    const recipientId = giftForm.elements.recipient.value;
    const payerSelect = giftForm.elements.payer;
    for (const option of payerSelect.options) option.disabled = option.value === recipientId;
    if (payerSelect.value === recipientId) payerSelect.value = [...payerSelect.options].find((option) => !option.disabled)?.value ?? "";
    giftForm.querySelectorAll("[name=giftContributor]").forEach((checkbox) => {
      checkbox.disabled = checkbox.value === recipientId;
      if (checkbox.disabled) checkbox.checked = false;
    });
  };
  giftForm?.elements.recipient?.addEventListener("change", updateGiftRecipient);
  updateGiftRecipient();
  giftForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(giftForm);
      const recipientMemberId = String(data.get("recipient"));
      const payerMemberId = String(data.get("payer"));
      const memberIds = data.getAll("giftContributor");
      const amountMinor = parseLedgerAmount(data.get("amount"));
      if (!memberIds.length) throw new Error("Select at least one gift contributor.");
      if (memberIds.includes(recipientMemberId) || payerMemberId === recipientMemberId) throw new Error("The recipient cannot pay for or contribute to their own surprise gift.");
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const contributions = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(giftForm, "SURPRISE_GIFT_RECORDED", { giftId: crypto.randomUUID(), recipientMemberId, payerMemberId, privateDescription: String(data.get("description")).trim(), amountMinor, contributions }, "Surprise gift recorded. Its recipient will see a confidential entry.");
    } catch (error) {
      const output = giftForm.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  });

  const budgetForm = document.querySelector("#budget-form");
  budgetForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(budgetForm);
    try {
      const amountMinor = parseLedgerAmount(data.get("amount"));
      const period = String(data.get("period")).trim();
      if (!period) throw new Error("Name the trip or budget period.");
      commitFromForm(budgetForm, "BUDGET_SET", { amountMinor, currency: ledgerCurrency(), period }, "Budget recorded. Future expenses will be measured against this limit.");
    } catch (error) {
      const output = budgetForm.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  });

  const agreementForm = document.querySelector("#agreement-form");
  agreementForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(agreementForm);
    const rules = ["shared_costs", "personal_costs", "tips", "cancellations", "payment_deadline"].map((category) => ({ category, text: String(data.get(category) ?? "").trim() })).filter((rule) => rule.text);
    if (!rules.length) {
      const output = agreementForm.querySelector("[data-action-error]");
      output.textContent = "Add at least one agreement before saving.";
      output.hidden = false;
      return;
    }
    commitFromForm(agreementForm, "SESSION_RULES_RECORDED", { sessionId: current.session.id, rules }, "Agreement recorded in the ledger history.");
  });

  const recurringRuleForm = document.querySelector("#recurring-rule-form");
  recurringRuleForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(recurringRuleForm);
      const amountMinor = parseLedgerAmount(data.get("amount"));
      const memberIds = data.getAll("recurringMember");
      if (!memberIds.length) throw new Error("Select at least one participant for the recurring allocation.");
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const allocations = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(recurringRuleForm, "RECURRING_RULE_APPROVED", { ruleId: crypto.randomUUID(), description: String(data.get("description")).trim(), amountMinor, allocations, cadence: String(data.get("cadence")).trim() }, "Recurring rule approved. Each period still needs an explicit recorded expense.");
    } catch (error) {
      const output = recurringRuleForm.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  });

  document.querySelectorAll(".recurring-instance-form").forEach((form) => form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const ruleId = form.dataset.ruleId;
    const periodKey = String(data.get("periodKey")).trim();
    const rule = current.recurringRules.find((item) => item.ruleId === ruleId);
    const alreadyRecorded = current.recurringPeriods.includes(`${ruleId}:${periodKey}`);
    if (!rule || alreadyRecorded) {
      const output = form.querySelector("[data-action-error]");
      output.textContent = alreadyRecorded ? "This rule already has an expense recorded for that period." : "This recurring rule is no longer available.";
      output.hidden = false;
      return;
    }
    let expenseEvent = events.find((item) => item.type === "EXPENSE_RECORDED" && item.recurringRuleId === ruleId && item.recurringPeriodKey === periodKey);
    if (!expenseEvent) {
      const expenseEventId = crypto.randomUUID();
      const saved = await commitFromForm(form, "EXPENSE_RECORDED", { id: expenseEventId, expenseId: expenseEventId, description: rule.description, payerId: data.get("payerMemberId"), amountMinor: rule.amountMinor, currency: ledgerCurrency(), baseAmountMinor: rule.amountMinor, totalCents: rule.amountMinor, allocations: rule.allocations, recurringRuleId: ruleId, recurringPeriodKey: periodKey }, `Recurring expense for ${periodKey} recorded.`);
      if (!saved) return;
      expenseEvent = events.find((item) => item.id === expenseEventId);
    }
    commitFromForm(form, "RECURRING_INSTANCE_RECORDED", { ruleId, periodKey, expenseEventId: expenseEvent.id }, `Recurring period ${periodKey} sealed into the ledger.`);
  }));

  document.querySelectorAll(".commitment-refund-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const item = current.commitments.find((commitment) => commitment.commitmentId === form.dataset.commitmentId);
      const amountMinor = parseLedgerAmount(new FormData(form).get("amount"));
      if (!item || amountMinor > Number(form.dataset.maxRefund)) throw new Error("Refund must be no greater than the remaining commitment amount.");
      const allocations = allocateWeighted(amountMinor, item.allocations);
      commitFromForm(form, "COMMITMENT_REFUND_RECORDED", { commitmentId: item.commitmentId, amountMinor, allocations, reason: "Refund recorded against the commitment." }, "Commitment refund recorded.");
    } catch (error) {
      const output = form.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  }));

  document.querySelectorAll(".commitment-outcome").forEach((button) => button.addEventListener("click", async () => {
    const item = current.commitments.find((commitment) => commitment.commitmentId === button.dataset.commitmentId);
    if (!item || item.status !== "open") return;
    const outcome = button.dataset.outcome;
    const remaining = item.amountMinor - (item.refundedMinor ?? 0);
    const linkedExpense = current.expenses.find((expense) => expense.commitmentId === item.commitmentId && expense.status !== "unassigned");
    if (!linkedExpense && outcome === "consumed" && remaining <= 0) return showToast("A fully refunded commitment can be cancelled, but has no remaining expense to consume.");
    button.disabled = true;
    if (!linkedExpense && remaining > 0) {
      const allocations = allocateWeighted(remaining, item.allocations);
      const recorded = await commit("EXPENSE_RECORDED", { expenseId: crypto.randomUUID(), description: item.description, payerId: item.payerMemberId, totalCents: remaining, allocations, commitmentId: item.commitmentId }, outcome === "consumed" ? "Final commitment cost recorded." : "Non-refundable cancellation cost recorded.");
      if (!recorded) return;
    }
    commit("COMMITMENT_UPDATED", { commitmentId: item.commitmentId, status: outcome, reason: outcome === "consumed" ? "Commitment cost was recorded as an expense." : "Commitment was cancelled; any remaining cost stays in the ledger." }, outcome === "consumed" ? "Commitment marked as used." : "Commitment cancelled with its remaining cost preserved.");
  }));

  const expenseForm = document.querySelector("#expense-form");
  const custom = document.querySelector("#custom-shares");
  const modeSelect = document.querySelector("#split-mode");
  const currencySelect = document.querySelector("#expense-currency");
  const fxFields = document.querySelector("#fx-fields");
  const updateExpenseCurrency = () => {
    if (!currencySelect || !fxFields) return;
    const foreign = currencySelect.value !== ledgerCurrency();
    fxFields.hidden = !foreign;
    for (const name of ["baseAmount", "fxRate", "fxSource", "fxObservedAt"]) expenseForm.elements[name].required = foreign;
    const feeText = String(expenseForm.elements.fxFee.value).trim();
    expenseForm.elements.fxFeePayer.required = foreign && Boolean(feeText && !/^0+(?:\.0+)?$/.test(feeText));
    document.querySelector("#source-total-label").textContent = `Original total · ${currencySelect.value}`;
    document.querySelector("#fx-source-currency").textContent = currencySelect.value;
  };
  currencySelect?.addEventListener("change", updateExpenseCurrency);
  expenseForm?.elements.fxFee?.addEventListener("input", () => {
    const feeText = String(expenseForm.elements.fxFee.value).trim();
    if (currencySelect.value !== ledgerCurrency()) expenseForm.elements.fxFeePayer.required = Boolean(feeText && !/^0+(?:\.0+)?$/.test(feeText));
  });
  updateExpenseCurrency();
  const updateCustom = () => {
    const checked = [...expenseForm.querySelectorAll("[name=beneficiary]:checked")];
    const enabled = modeSelect.value === "custom";
    custom.hidden = !enabled;
    custom.innerHTML = enabled ? `<div class="custom-title">Enter each participant’s share</div>${checked.map((box) => `<label>${h(memberName(box.value))}<input name="share-${h(box.value)}" inputmode="decimal" placeholder="0.00" required></label>`).join("")}` : "";
  };
  modeSelect?.addEventListener("change", updateCustom);
  document.querySelector("#expense-group")?.addEventListener("change", (event) => {
    const group = current.groups.find((item) => item.id === event.target.value);
    const members = new Set(group?.memberIds ?? current.members.map((member) => member.id));
    expenseForm.querySelectorAll("[name=beneficiary]").forEach((box) => { box.checked = members.has(box.value); });
    updateCustom();
  });
  expenseForm?.querySelectorAll("[name=beneficiary]").forEach((box) => box.addEventListener("change", updateCustom));
  expenseForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(expenseForm);
      const details = expenseCurrencyDetails(data);
      const totalMinor = details.baseAmountMinor;
      const payerId = data.get("payer");
      if (payerId === "unassigned") {
        const saved = await commit("EXPENSE_UNASSIGNED", { description: String(data.get("description")).trim(), amountMinor: details.amountMinor, currency: details.currency, baseAmountMinor: details.baseAmountMinor, totalCents: details.baseAmountMinor, fx: details.fx, allocations: [], evidenceIds: [...pendingEvidenceIds] }, "Charge recorded as unassigned. It will not affect balances until assigned.");
        if (saved) pendingEvidenceIds = [];
        return;
      }
      const ids = data.getAll("beneficiary");
      if (!ids.length) throw new Error("Select at least one beneficiary.");
      let allocations;
      if (data.get("splitMode") === "custom") {
        allocations = ids.map((memberId) => ({ memberId, cents: parseLedgerAmount(data.get(`share-${memberId}`)) }));
        if (allocations.reduce((sum, row) => sum + row.cents, 0) !== totalMinor) throw new Error("Custom shares must sum exactly to the ledger total.");
      } else {
        const base = Math.floor(totalMinor / ids.length);
        let remainder = totalMinor - base * ids.length;
        allocations = ids.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      }
      const groupId = data.get("group");
      const saved = await commit("EXPENSE_RECORDED", { description: String(data.get("description")).trim(), payerId, amountMinor: details.amountMinor, currency: details.currency, baseAmountMinor: details.baseAmountMinor, totalCents: details.baseAmountMinor, fx: details.fx, allocations, groupIds: groupId ? [groupId] : [], evidenceIds: [...pendingEvidenceIds] }, "Expense entered into the ledger.");
      if (saved) pendingEvidenceIds = [];
    } catch (error) { showToast(error.message); }
  });

  document.querySelectorAll(".expense-confirm").forEach((button) => button.addEventListener("click", () => {
    const access = getAccessContext();
    commit("MEMBER_CONFIRMED_EXPENSE", { expenseId: button.dataset.expenseId, memberId: access.memberId, decision: "accepted" }, "Your share confirmation was recorded.");
  }));

  document.querySelectorAll(".discrepancy-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const claim = String(new FormData(form).get("claim")).trim();
    if (!claim) { const output = form.querySelector("[data-action-error]"); output.textContent = "Describe what does not match before submitting."; output.hidden = false; form.elements.claim.focus(); return; }
    commitFromForm(form, "EXPENSE_DISCREPANCY_RECORDED", { expenseId: form.dataset.expenseId, discrepancyId: crypto.randomUUID(), raisedByMemberId: getAccessContext().memberId, claim }, "Discrepancy recorded for organizer review.");
  }));

  document.querySelectorAll(".resolution-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const resolution = String(new FormData(form).get("resolution")).trim();
    if (!resolution) { const output = form.querySelector("[data-action-error]"); output.textContent = "Record how this discrepancy was resolved."; output.hidden = false; form.elements.resolution.focus(); return; }
    commitFromForm(form, "EXPENSE_DISCREPANCY_RESOLVED", { discrepancyId: form.dataset.discrepancyId, resolution }, "Discrepancy resolution recorded.");
  }));

  document.querySelector("#payment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const fromId = data.get("from"); const toId = data.get("to");
      if (fromId === toId) throw new Error("Choose two different participants.");
      const cents = parseLedgerAmount(data.get("amount"));
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
      const amountMinor = parseLedgerAmount(data.get("amount"));
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
