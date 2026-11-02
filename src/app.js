import { deriveLedger, findPossibleDuplicates, formatMoney, parseAmountToMinor, SUPPORTED_CURRENCIES, settleUp } from "./domain.js";
import { deriveNarrativeEvents } from "./domain/narrative.js";
import { t, tOptional, plural, currentLanguage, setLanguage } from "./i18n.js";
import { appendEvent, exportLedger, loadLedger, takeAppendWarnings, getAccessContext, getServerState } from "./store.js";

const view = document.querySelector("#view");
const storageError = document.querySelector("#storage-error");
const toast = document.querySelector("#toast");
let events;
let route = location.hash.slice(1).split("/")[0] || "home";
let toastTimer;
let pendingEvidenceIds = [];
const routes = new Set(["home", "members", "expenses", "history", "payments", "verdict"]);
const h = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Dates follow the chosen interface language, not a fixed locale.
const eventDate = (iso) => new Date(iso).toLocaleString(currentLanguage() === "es" ? "es-AR" : "en-US", { dateStyle: "medium", timeStyle: "short" });
const ledgerCurrency = () => events?.find((event) => event.type === "SESSION_CREATED")?.baseCurrency ?? "USD";
// The viewer's own locale, so an ARS ledger reads 1.500,00 rather than 1,500.00.
const displayLocale = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US";
const money = (minor) => formatMoney(minor, ledgerCurrency(), displayLocale);
const parseLedgerAmount = (value) => parseAmountToMinor(value, ledgerCurrency());
// Fields the server holds outside the event log. The derived ledger is a pure
// function of the events and can never produce them, but both are plain objects
// with overlapping names, so reading one off the wrong origin yields undefined
// and renders as an empty panel. That is how the reconciliation inbox shipped
// invisible. Reading one here now says so out loud instead of rendering nothing.
const SERVER_ONLY_STATE = new Set(["paymentReconciliations"]);

const ledger = () => {
  const derived = deriveLedger(events, { baseCurrency: ledgerCurrency() });
  return new Proxy(derived, {
    get(target, key) {
      if (typeof key === "string" && SERVER_ONLY_STATE.has(key) && !(key in target)) {
        console.warn(`[ledger] "${key}" is not derivable from the event log; read it from getServerState() instead. Rendering it from the derived ledger silently produces nothing.`);
      }
      return target[key];
    }
  });
};
const memberName = (id) => ledger().members.find((m) => m.id === id)?.name ?? t("member.unknown");

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
  return `<span class="status-pill ${current.archived ? "sealed" : "open"}"><i></i>${current.archived ? t("status.archived") : t("status.open")}</span>`;
}

function homePage(current) {
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const balanceStatus = current.members.length === 0 ? "awaiting" : [...current.balances.values()].every((value) => value === 0) ? "balanced" : "unsettled";
  const narrative = deriveNarrativeEvents(current).at(-1);
  return `${header(t("brand.name"), t("home.subtitle"), t("home.eyebrow"))}
    <section class="hero-card"><div class="hero-copy"><div class="eyebrow">${t("home.hero.eyebrow")}</div><h2>${t("home.hero.title")}</h2><p>${t("home.hero.body")}</p><a href="#expenses" class="button button-gold">${t("home.hero.cta")} <span>↗</span></a></div><div class="hero-status">${statusPill(current)}<span>${t("home.hero.stored")}</span></div></section>
    <section class="stat-grid"><article class="stat-card"><span>${t("home.stat.bound")}</span><strong>${current.members.length}</strong><small>${t("home.stat.participants")}</small></article><article class="stat-card"><span>${t("home.stat.spend")}</span><strong>${money(current.totalExpenses)}</strong><small>${plural(current.expenses.length, "home.stat.expenses")}</small></article><article class="stat-card"><span>${t("home.stat.condition")}</span><strong class="condition ${balanceStatus === "balanced" ? "good" : "pending"}">${t(`balance.${balanceStatus}`)}</strong><small>${plural(current.settlements.length, "home.stat.settlements")}</small></article></section>
    ${narrative ? `<div class="calculation-note"><span>◇</span><p><b>${t("home.narrative.label")}</b> ${h(narrative.text)} ${t("home.narrative.note")}</p></div>` : ""}
    <div class="content-grid"><section class="panel"><div class="section-title"><div><div class="eyebrow">${t("home.witnesses.eyebrow")}</div><h2>${t("home.witnesses.title")}</h2></div><a href="#members" class="text-button">${t("home.witnesses.all")}</a></div>${current.members.length ? `<div class="member-list">${current.members.slice(0, 5).map((m) => memberCard(m, current)).join("")}</div>` : emptyState(t("home.witnesses.emptyTitle"), t("home.witnesses.emptyBody"), "#members", t("home.witnesses.emptyAction"))}</section><section class="panel recent-panel"><div class="section-title"><div><div class="eyebrow">${t("home.recent.eyebrow")}</div><h2>${t("home.recent.title")}</h2></div><a href="#history" class="text-button">${t("home.recent.open")}</a></div>${current.events.length ? `<div class="event-list compact">${[...current.events].reverse().slice(0, 4).map(eventRow).join("")}</div>` : emptyState(t("home.recent.emptyTitle"), t("home.recent.emptyBody"), "#expenses", t("home.recent.emptyAction"))}</section></div>
    ${current.archived ? `<div class="sealed-banner"><span>✦</span><div><b>${t("home.sealed.title")}</b><p>${t("home.sealed.body")}</p></div></div>` : current.closure?.type === "provisional" ? `<div class="sealed-banner"><span>!</span><div><b>${t("home.provisional.title")}</b><p>${t("home.provisional.body", { count: current.closureBlockers.length })}</p></div></div>` : current.events.length && access.role === "organizer" ? `<section class="closing-strip"><div><div class="eyebrow">${t("home.closing.eyebrow")}</div><b>${t("home.closing.title")}</b><p>${t("home.closing.body")}</p></div><button class="button button-quiet" id="archive-button" type="button">${t("home.closing.cta")} <span>→</span></button></section>` : ""}`;
}

function memberCard(member, current, showStatusControl = false) {
  const cents = current.balances.get(member.id) || 0;
  const status = member.status ?? "active";
  const statusControl = showStatusControl && getAccessContext().role === "organizer" && !current.archived && status !== "removed" ? `<button class="button button-quiet member-status" type="button" data-member-id="${h(member.id)}" data-next-status="${status === "active" ? "departed" : "active"}">${status === "active" ? t("member.markDeparted") : t("member.reactivate")}</button>` : "";
  return `<article class="member-row"><span class="avatar">${h(member.name.trim().slice(0, 1).toUpperCase())}</span><span class="member-name"><b>${h(member.name)}</b><small>${status === "active" ? t("member.active") : t(`member.${status}`)} · ${t("member.witness", { n: String(current.members.findIndex((m) => m.id === member.id) + 1).padStart(2, "0") })}</small></span><strong class="money ${cents > 0 ? "credit" : cents < 0 ? "debit" : "neutral"}">${cents > 0 ? "+" : cents < 0 ? "−" : ""}${money(Math.abs(cents))}</strong>${statusControl}${balanceBreakdown(member, current)}</article>`;
}

function balanceBreakdown(member, current) {
  const rows = current.balanceBreakdowns.get(member.id) ?? [];
  
  const signed = (amount) => `${amount > 0 ? "+" : amount < 0 ? "−" : ""}${money(Math.abs(amount))}`;
  const pending = current.settlements.filter((payment) => ["pending", "asserted"].includes(payment.status) && [payment.fromId, payment.toId].includes(member.id));
  return `<details class="balance-breakdown"><summary>${t("breakdown.summary")}</summary><p>${t("breakdown.intro")}</p>${rows.length ? `<ol>${rows.map((row) => {
    const kind = t(`kind.${row.kind}`);
    const record = current.expenses.find((item) => item.id === row.recordId);
    const counterparty = current.members.find((item) => item.id === row.counterpartyId)?.name ?? t("member.unknown");
    const title = record?.description ? h(record.description) : h(kind);
    const detail = record?.description ? `${h(kind)} · ${t("breakdown.with", { name: h(counterparty) })}` : t("breakdown.with", { name: h(counterparty) });
    const links = row.eventIds.map((id, index) => `<a href="#history/${encodeURIComponent(id)}" title="${h(id)}">${row.eventIds.length > 1 ? t("breakdown.viewEventNumbered", { n: index + 1 }) : t("breakdown.viewEvent")}</a>`).join(" · ");
    return `<li><span><b>${title}</b><small>${detail}</small><span class="balance-references">${links}</span></span><strong>${signed(row.deltaMinor)}</strong></li>`;
  }).join("")}</ol>` : `<p>${t("breakdown.none")}</p>`}<div class="balance-total"><b>${t("breakdown.total")}</b><strong>${signed(current.balances.get(member.id) ?? 0)}</strong></div><p>${plural(pending.length, "breakdown.pending")}</p></details>`;
}

function emptyState(title, body, href, action) {
  return `<div class="empty-state"><span aria-hidden="true">◌</span><b>${title}</b><p>${body}</p><a class="text-button" href="${href}">${action} ↗</a></div>`;
}

function membersPage(current) {
  const canAdmin = getAccessContext().role === "organizer";
  const activeMembers = current.members.filter((member) => (member.status ?? "active") === "active");
  const agreementFields = ["shared_costs", "personal_costs", "tips", "cancellations", "payment_deadline"].map((category) => [category, t(`agreement.${category}`), t(`agreement.${category}.hint`)]);
  const agreement = new Map();
  for (const event of current.events) if (event.type === "SESSION_RULES_RECORDED") for (const rule of event.rules) agreement.set(rule.category, { ...rule, at: event.at });
  return `${header(t("members.title"), t("members.subtitle"), t("members.eyebrow"))}
    <section class="feature-card mirror-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/broken-mirror.png" alt=""></div><div><div class="eyebrow">${t("members.card.eyebrow")}</div><h2>${t("members.card.title")}</h2><p>${t("members.card.body")}</p></div></section>
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="member-form"><label for="member-name">${t("members.add.label")}</label><div class="input-row"><input id="member-name" name="name" maxlength="48" placeholder="${t("members.add.placeholder")}" required autocomplete="off"><button class="button button-gold" type="submit">${t("members.add.cta")} <span>↗</span></button></div><small>${t("members.add.hint")}</small></form>` : ""}
    ${!current.archived && canAdmin ? `<form class="form-panel inline-form" id="invite-form"><label for="invite-name">${t("members.invite.label")}</label><div class="input-row"><input id="invite-name" name="name" maxlength="80" placeholder="${t("members.invite.placeholder")}" required><select name="role"><option value="member">${t("members.invite.member")}</option><option value="witness">${t("members.invite.witness")}</option></select><button class="button button-quiet" type="submit">${t("members.invite.cta")}</button></div><output id="invite-link" aria-live="polite"></output></form>` : ""}
    ${!current.archived ? `<form class="form-panel inline-form" id="join-code-form"><label for="join-code">${t("members.join.label")}</label><div class="input-row"><input id="join-code" name="code" maxlength="20" autocomplete="off" spellcheck="false" placeholder="ABCD-2345"><button class="button button-quiet" type="submit">${t("members.join.cta")}</button></div><p class="field-hint">${t("members.join.hint")}</p><output id="join-code-result" aria-live="polite"></output></form>` : ""}
    ${!current.archived && canAdmin && activeMembers.length ? `<form class="form-panel inline-form" id="group-form"><label for="group-name">${t("members.group.label")}</label><div class="input-row"><input id="group-name" name="name" maxlength="80" placeholder="${t("members.group.placeholder")}" required><button class="button button-quiet" type="submit">${t("members.group.cta")}</button></div><fieldset class="beneficiary-fieldset"><legend>${t("members.group.legend")}</legend><div class="check-grid">${activeMembers.map((member) => `<label class="check-row"><input type="checkbox" name="groupMember" value="${h(member.id)}"><span>${h(member.name)}</span></label>`).join("")}</div></fieldset></form>` : ""}
    ${!current.archived && canAdmin ? `<form class="form-panel agreement-form" id="agreement-form"><div class="eyebrow">${t("members.agreement.eyebrow")}</div><h2>${t("members.agreement.title")}</h2><p>${t("members.agreement.body")}</p>${agreementFields.map(([category, label, placeholder]) => `<label>${label}<textarea name="${category}" maxlength="500" rows="2" placeholder="${placeholder}">${h(agreement.get(category)?.text ?? "")}</textarea></label>`).join("")}<output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">${t("members.agreement.cta")}</button></form>` : ""}
    ${agreement.size ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("members.current.eyebrow")}</div><h2>${t("members.current.title")}</h2></div><span class="count">${t("members.current.count", { count: agreement.size })}</span></div><div class="agreement-list">${agreementFields.filter(([category]) => agreement.has(category)).map(([category, label]) => `<article><b>${label}</b><p>${h(agreement.get(category).text)}</p><small>${t("members.current.recorded", { when: eventDate(agreement.get(category).at) })}</small></article>`).join("")}</div></section>` : ""}
    ${current.groups.length ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("members.groups.eyebrow")}</div><h2>${t("members.groups.title")}</h2></div><span class="count">${t("members.groups.count", { count: current.groups.length })}</span></div><div class="member-list">${current.groups.map((group) => `<article class="member-row"><span class="avatar">◌</span><span class="member-name"><b>${h(group.name)}</b><small>${group.memberIds.map((id) => h(memberName(id))).join(", ")}</small></span></article>`).join("")}</div></section>` : ""}
    <section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("members.present.eyebrow")}</div><h2>${t("members.present.title")} <span class="count">${current.members.length} / 100</span></h2></div></div>${current.members.length ? `<div class="member-list full-list">${current.members.map((m) => memberCard(m, current, true)).join("")}</div>` : emptyState(t("members.emptyTitle"), t("members.emptyBody"), "#members", t("members.emptyAction"))}</section>`;
}

function expensePage(current) {
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const activeMembers = current.members.filter((member) => (member.status ?? "active") === "active");
  const payerOptions = activeMembers.filter((member) => access.role !== "member" || member.id === access.memberId);
  const enough = current.members.length >= 1;
  const rows = activeMembers.map((m) => `<label class="check-row"><input type="checkbox" name="beneficiary" value="${h(m.id)}" checked><span>${h(m.name)}</span></label>`).join("");
  const groupOptions = current.groups.map((group) => `<option value="${h(group.id)}">${h(group.name)}</option>`).join("");
  const currencyOptions = SUPPORTED_CURRENCIES.map((currency) => `<option value="${currency}" ${currency === ledgerCurrency() ? "selected" : ""}>${currency}</option>`).join("");
  const feePayerOptions = activeMembers.map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  return `${header(t("expenses.title"), t("expenses.subtitle"), t("expenses.eyebrow"))}
    <section class="feature-card phone-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/black-telephone.png" alt=""></div><div><div class="eyebrow">${t("expenses.card.eyebrow")}</div><h2>${t("expenses.card.title")}</h2><p>${t("expenses.card.body")}</p></div><span class="coming-tag">${t("expenses.card.tag")}</span></section>
    ${!current.archived && !readOnly ? `<section class="form-panel"><label for="receipt-image">${t("photo.label")}</label><div class="input-row"><input id="receipt-image" type="file" accept="image/jpeg,image/png,image/webp"><input id="receipt-note" type="text" maxlength="240" placeholder="${t("photo.note")}"><button class="button button-quiet" id="analyze-receipt" type="button">${t("photo.cta")}</button></div><p class="field-hint">${t("photo.hint")}</p><pre id="receipt-proposal" hidden aria-live="polite"></pre></section>` : ""}
    ${!enough ? emptyState(t("expenses.emptyTitle"), t("expenses.emptyBody"), "#members", t("expenses.emptyAction")) : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? t("expenses.witnessOnly") : t("expenses.readOnly")}</b><p>${readOnly ? t("expenses.witnessOnly.body") : t("expenses.readOnly.body")}</p></div></div>` : `<form class="form-panel expense-form" id="expense-form"><div class="form-heading"><div><div class="eyebrow">${t("expenses.form.eyebrow")}</div><h2>${t("expenses.form.title")}</h2></div><span class="form-index">02 / 05</span></div><div class="field-grid"><label>${t("expenses.form.description")}<input name="description" maxlength="120" placeholder="${t("expenses.form.descriptionPlaceholder")}" required></label><label>${t("expenses.form.currency")}<select name="currency" id="expense-currency">${currencyOptions}</select></label><label><span id="source-total-label">${t("expenses.form.total", { currency: h(ledgerCurrency()) })}</span><input name="amount" inputmode="decimal" required></label><label>${t("expenses.form.paidBy")}<select name="payer" required><option value="unassigned">${t("expenses.form.unassigned")}</option>${payerOptions.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("")}</select></label><label>${t("expenses.form.rule")}<select name="splitMode" id="split-mode"><option value="equal">${t("expenses.form.equal")}</option><option value="custom">${t("expenses.form.custom")}</option></select></label>${groupOptions ? `<label>${t("expenses.form.group")}<select name="group" id="expense-group"><option value="">${t("expenses.form.allParticipants")}</option>${groupOptions}</select></label>` : ""}</div><fieldset id="fx-fields" class="form-panel fx-fields" hidden><legend>${t("fx.legend", { currency: h(ledgerCurrency()) })}</legend><div class="field-grid"><label>${t("fx.ledgerTotal", { currency: h(ledgerCurrency()) })}<input name="baseAmount" inputmode="decimal"></label><label>${t("fx.per", { currency: h(ledgerCurrency()) })} <span id="fx-source-currency">${t("fx.foreignUnit")}</span><input name="fxRate" inputmode="decimal" placeholder="1.08"></label><label>${t("fx.source")}<input name="fxSource" maxlength="120" placeholder="${t("fx.sourcePlaceholder")}"></label><label>${t("fx.observedAt")}<input name="fxObservedAt" type="datetime-local"></label><label>${t("fx.fee", { currency: h(ledgerCurrency()) })}<input name="fxFee" inputmode="decimal" value="0"></label><label>${t("fx.feePayer")}<select name="fxFeePayer"><option value="">${t("fx.noFee")}</option>${feePayerOptions}</select></label></div><p class="field-hint">${t("fx.hint")}</p></fieldset><fieldset class="beneficiary-fieldset"><legend>${t("expenses.form.beneficiaries")}</legend><div class="check-grid">${rows}</div></fieldset><div id="custom-shares" class="custom-shares" hidden></div><div class="form-footer"><p>${t("expenses.form.footer")}</p><button class="button button-gold" type="submit">${t("expenses.form.cta")} <span>↗</span></button></div></form>`}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">${t("expenses.record.eyebrow")}</div><h2>${t("expenses.record.title")}</h2></div><span class="count">${t("expenses.record.count", { count: current.expenses.length })}</span></div>${current.expenses.length ? `<div class="expense-list">${[...current.expenses].reverse().map((expense) => expenseRow(expense, current)).join("")}</div>` : emptyState(t("expenses.record.emptyTitle"), t("expenses.record.emptyBody"), "#expenses", t("expenses.record.emptyAction"))}</section>
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
    const recorded = periods.length ? periods.map((period) => `<span class="count">${h(period)}</span>`).join(" ") : t("msg.no.periods.recorded");
    const generateForm = canManage && activePayers ? `<form class="recurring-instance-form" data-rule-id="${h(rule.ruleId)}"><label>Period key<input name="periodKey" maxlength="40" placeholder="2026-10" required></label><label>Paid by<select name="payerMemberId" required>${activePayers}</select></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record this period</button></form>` : "";
    return `<article class="recurring-row"><div><b>${h(rule.description)}</b><small>${h(rule.cadence)} · ${rule.allocations.length} allocated participants · ${money(rule.amountMinor)}</small></div><div class="recurring-periods"><small>Recorded periods:</small> ${recorded}</div>${generateForm}</article>`;
  }).join("");
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE CLOCKWORK ACCOUNT</div><h2>Recurring expenses</h2></div><span class="count">${current.recurringRules.length} rules</span></div>${createForm}${rules ? `<div class="recurring-list">${rules}</div>` : `<p class="empty-inline">No recurring expenses have been approved.</p>`}</section>`;
}

function budgetSection(current) {
  const canManage = getAccessContext().role === "organizer" && !current.archived;
  const form = canManage ? `<form class="form-panel" id="budget-form"><div class="eyebrow">AGREED ALLOWANCE</div><h2>Set a travel budget</h2><div class="field-grid"><label>Budget label<input name="period" maxlength="80" placeholder=t("msg.lisbon.weekend") required></label><label>Limit · ${h(ledgerCurrency())}<input name="amount" inputmode="decimal" required></label></div><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record budget</button><p class="field-hint">Each new budget starts a fresh tracking period. The ledger keeps earlier limits in its event history.</p></form>` : "";
  const entries = current.budgets.map((budget, index) => {
    const spentMinor = current.expenses.filter((expense) => expense.status !== "unassigned" && Date.parse(expense.at) >= Date.parse(budget.at)).reduce((sum, expense) => sum + expense.baseAmountMinor, 0);
    const active = index === current.budgets.length - 1;
    const over = spentMinor >= budget.amountMinor;
    return `<article class="budget-row"><div><b>${h(budget.period)}</b><small>${active ? t("msg.current.budget") : t("msg.previous.limit")} · Set ${eventDate(budget.at)} · ${over ? t("msg.limit.reached") : "Within limit"}</small></div><progress max="${budget.amountMinor}" value="${Math.min(spentMinor, budget.amountMinor)}" aria-label="${h(budget.period)} budget usage"></progress><strong>${money(spentMinor)} / ${money(budget.amountMinor)}</strong></article>`;
  }).join("");
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE BLEEDING ALLOWANCE</div><h2>Travel budgets</h2></div><span class="count">${current.budgets.length} records</span></div>${form}${entries ? `<div class="budget-list">${entries}</div>` : `<p class="empty-inline">No budget has been agreed for this journey.</p>`}</section>`;
}

function giftSection(current) {
  const access = getAccessContext();
  const activeMembers = current.members.filter((member) => (member.status ?? "active") === "active");
  const canCreate = access.role === "organizer" && !current.archived && current.members.length >= 2 && activeMembers.length > 0;
  const defaultRecipient = activeMembers[0]?.id ?? current.members[0]?.id;
  const recipients = current.members.map((member) => `<option value="${h(member.id)}" ${member.id === defaultRecipient ? "selected" : ""}>${h(member.name)}</option>`).join("");
  const payers = activeMembers.filter((member) => member.id !== defaultRecipient).map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  const contributors = activeMembers.map((member) => `<label class="check-row"><input type="checkbox" name="giftContributor" value="${h(member.id)}" ${member.id === defaultRecipient ? "" : "checked"}><span>${h(member.name)}</span></label>`).join("");
  const form = canCreate ? `<form class="form-panel" id="gift-form"><div class="eyebrow">THE PACT OF SILENCE</div><h2>Record a surprise gift</h2><div class="field-grid"><label>Private description<input name="description" maxlength="240" required></label><label>Amount <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" required></label><label>Recipient<select name="recipient" id="gift-recipient" required>${recipients}</select></label><label>Who paid upfront?<select name="payer" id="gift-payer" required>${payers}</select></label></div><fieldset class="beneficiary-fieldset"><legend>Who contributed? The recipient cannot be included.</legend><div class="check-grid">${contributors}</div></fieldset><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record privately</button><p class="field-hint">The recipient sees a confidential entry; other ledger participants can review its description and contributions.</p></form>` : "";
  return `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">THE PACT OF SILENCE</div><h2>Surprise gifts</h2></div><span class="count">${current.gifts.length} records</span></div>${form}${!current.gifts.length ? `<p class="empty-inline">No surprise gifts have been recorded.</p>` : `<div class="member-list">${current.gifts.map((gift) => `<article class="member-row"><span class="avatar">✳</span><span class="member-name"><b>${access.memberId === gift.recipientMemberId ? t("msg.confidential.surprise.gift") : h(gift.privateDescription)}</b><small>For ${h(current.members.find((member) => member.id === gift.recipientMemberId)?.name ?? t("member.unknown"))} · ${gift.contributions.length} contributor${gift.contributions.length === 1 ? "" : "s"}</small></span><strong>${money(gift.amountMinor)}</strong></article>`).join("")}</div>`}</section>`;
}

function commitmentSection(current) {
  const access = getAccessContext();
  const activeMembers = current.members.filter((member) => (member.status ?? "active") === "active");
  const canCreate = !current.archived && access.role !== "witness" && activeMembers.length > 0;
  const payerOptions = activeMembers.filter((member) => access.role !== "member" || member.id === access.memberId).map((member) => `<option value="${h(member.id)}">${h(member.name)}</option>`).join("");
  const participantOptions = activeMembers.map((member) => `<label class="check-row"><input type="checkbox" name="commitmentMember" value="${h(member.id)}" checked><span>${h(member.name)}</span></label>`).join("");
  const form = canCreate ? `<form class="form-panel" id="commitment-form"><div class="eyebrow">BEFORE THE RECEIPT</div><h2>Record a commitment</h2><div class="field-grid"><label>Description<input name="description" maxlength="240" required></label><label>Expected amount <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" required></label><label>Who committed to pay?<select name="payer" required>${payerOptions}</select></label><label>Refundability<select name="refundability" required><option value="refundable">Refundable</option><option value="partially_refundable">Partially refundable</option><option value="nonrefundable">Non-refundable</option></select></label></div><fieldset class="beneficiary-fieldset"><legend>Who shares this commitment?</legend><div class="check-grid">${participantOptions}</div></fieldset><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record commitment</button></form>` : "";
  const entries = current.commitments.map((item) => {
    const payerName = current.members.find((member) => member.id === item.payerMemberId)?.name ?? t("member.unknown");
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
  if (weightTotal <= 0n) throw new Error(t("msg.the.commitment.has.no"));
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
  if (!match) throw new Error(t("msg.enter.a.positive.exchange"));
  const fraction = match[2] ?? "";
  let numerator = BigInt(`${match[1]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (numerator <= 0n) throw new Error(t("msg.exchange.rate.must.be"));
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
  if (!Number.isFinite(observedAt.getTime())) throw new Error(t("msg.enter.when.this.exchange"));
  const source = String(data.get("fxSource") ?? "").trim();
  if (!source) throw new Error(t("msg.enter.the.source.of"));
  const feePayerMemberId = String(data.get("fxFeePayer") ?? "");
  if (feeMinor > 0 && !feePayerMemberId) throw new Error(t("msg.choose.who.paid.the"));
  return { currency, amountMinor, baseAmountMinor, fx: { sourceCurrency: currency, targetCurrency: ledgerCurrency(), ...ratio, source, observedAt: observedAt.toISOString(), feeMinor, ...(feeMinor ? { feePayerMemberId } : {}) } };
}

function expenseRow(event, current) {
  const groupNames = (event.groupIds ?? []).map((id) => current.groups.find((group) => group.id === id)?.name).filter(Boolean);
  const expenseIndex = current.expenses.findIndex((expense) => expense.id === event.id);
  const earlierExpenses = expenseIndex < 0 ? [] : current.expenses.slice(0, expenseIndex);
  const possibleDuplicates = findPossibleDuplicates(earlierExpenses, event);
  const originalAmount = event.currency !== ledgerCurrency() ? ` · original ${formatMoney(event.amountMinor, event.currency)}` : "";
  const fxEvidence = event.fx ? ` · FX ${event.fx.numerator}/${event.fx.denominator} ${event.fx.targetCurrency}/${event.fx.sourceCurrency} from ${h(event.fx.source)} at ${eventDate(event.fx.observedAt)}` : "";
  const feeEvidence = event.fx?.feeMinor ? ` · conversion fee ${money(event.fx.feeMinor)} paid by ${h(current.members.find((member) => member.id === event.fx.feePayerMemberId)?.name ?? t("member.unknown"))}` : "";
  const duplicateNotice = possibleDuplicates.length ? `<div class="duplicate-notice" role="note"><b>Possible duplicate; review before relying on this entry.</b>${possibleDuplicates.map((match) => { const prior = current.expenses.find((expense) => expense.id === match.expenseId); return `<small>Similar to “${h(prior?.description ?? "expense")}” recorded ${prior ? eventDate(prior.at) : "earlier"}. ${h(match.reason)}. No entry was removed.</small>`; }).join("")}</div>` : "";
  return `<article class="expense-row"><span class="row-icon">⌕</span><span class="expense-meta"><b>${h(event.description)}</b><small>Paid by ${h(current.members.find((member) => member.id === event.payerId)?.name ?? t("member.unknown"))} · Shared by ${event.allocations.length} participant${event.allocations.length === 1 ? "" : "s"}${groupNames.length ? ` · ${groupNames.map(h).join(", ")}` : ""}${originalAmount}${fxEvidence}${feeEvidence} · ${eventDate(event.at)}</small>${duplicateNotice}</span><strong>${money(event.totalCents)}</strong>${expenseReview(event, current)}</article>`;
}

function expenseReview(expense, current) {
  const access = getAccessContext();
  const confirmations = current.confirmations.filter((item) => item.expenseId === expense.id);
  const discrepancies = current.discrepancies.filter((item) => item.expenseId === expense.id);
  const assigned = access.role === "member" && (expense.payerId === access.memberId || expense.allocations.some((row) => row.memberId === access.memberId));
  const ownConfirmation = confirmations.find((item) => item.memberId === access.memberId);
  const openOwnDispute = discrepancies.find((item) => item.raisedByMemberId === access.memberId && !item.resolution);
  const canAct = assigned && !current.archived;
  const reviewSummary = confirmations.length ? confirmations.map((item) => `${h(current.members.find((member) => member.id === item.memberId)?.name ?? t("member.unknown"))}: ${h(item.decision)}`).join(" · ") : t("msg.no.participant.has.confirmed");
  const confirmationControl = canAct ? ownConfirmation?.decision === "accepted" ? `<span class="status-pill open">Your share is confirmed</span>` : `<button class="button button-quiet expense-confirm" type="button" data-expense-id="${h(expense.id)}">Confirm my share</button>` : "";
  const disputeControl = canAct && !openOwnDispute ? `<details class="expense-dispute"><summary>Report a discrepancy</summary><form class="discrepancy-form" data-expense-id="${h(expense.id)}"><label>What does not match?<textarea name="claim" maxlength="500" required></textarea></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Record discrepancy</button></form></details>` : openOwnDispute ? `<p class="dispute-note">Your discrepancy is awaiting resolution.</p>` : "";
  const disputeRows = discrepancies.map((item) => `<div class="dispute-note"><b>${h(current.members.find((member) => member.id === item.raisedByMemberId)?.name ?? t("member.unknown"))} reported:</b> ${h(item.claim)}${item.resolution ? `<br><b>Resolution:</b> ${h(item.resolution)}` : access.role === "organizer" && !current.archived ? `<form class="resolution-form" data-discrepancy-id="${h(item.discrepancyId)}"><label>Resolution<textarea name="resolution" maxlength="500" required></textarea></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">Resolve discrepancy</button></form>` : "<br><span>Awaiting organizer review.</span>"}</div>`).join("");
  return `<section class="expense-review" aria-label=t("msg.participant.review.for", { what: h(expense.description) })><p><b>Share review:</b> ${reviewSummary}</p>${confirmationControl}${disputeControl}${disputeRows}</section>`;
}

function eventDescription(event) {
  if (event.type === "MEMBER_ADDED") return t("event.memberAdded", { name: h(event.name) });
  if (event.type === "MEMBER_INVITED") return t("event.memberInvited", { name: h(event.name), role: tOptional(`role.${event.role}`) ?? h(event.role) });
  if (event.type === "EXPENSE_RECORDED") return t("event.expense", { what: h(event.description), amount: money(event.totalCents ?? event.baseAmountMinor ?? event.amountMinor) });
  if (event.type === "EXPENSE_UNASSIGNED") return t("event.unassigned", { what: h(event.description), amount: money(event.totalCents ?? event.amountMinor) });
  if (event.type === "SETTLEMENT_RECORDED") return t("event.settlementRecorded", { from: h(memberName(event.fromId)), to: h(memberName(event.toId)), amount: money(event.cents) });
  if (event.type === "SETTLEMENT_ASSERTED") return t("event.settlementAsserted", { from: h(memberName(event.fromMemberId)), to: h(memberName(event.toMemberId)), amount: money(event.amountMinor) });
  if (event.type === "SETTLEMENT_CONFIRMED") return t("event.settlementConfirmed", { name: h(memberName(event.confirmedByMemberId)) });
  if (event.type === "SESSION_CLOSED_PROVISIONAL") return t("event.closedProvisional", { reason: h(event.reason) });
  if (event.type === "SESSION_CLOSED_FINAL") return t("event.closedFinal");
  if (event.type === "SESSION_ARCHIVED") return `${t("event.archived")}${event.provisional ? t("event.archived.open") : t("event.archived.balanced")}`;
  if (event.type === "EVIDENCE_ATTACHED") return `${event.note ? t("event.photoNamed", { note: h(event.note) }) : t("event.photo")}<span class="evidence-thumb"><img data-evidence="${h(event.evidenceId)}" alt="${h(event.note ?? t("event.photoAlt"))}"></span>`;
  if (event.type === "SESSION_CREATED") return t("event.sessionCreated", { name: h(event.name), currency: h(event.baseCurrency) });
  // An event type without its own phrasing still reads as something, rather than
  // as a raw constant: the humanised type is the last resort, not the default.
  const named = tOptional(`event.${event.type}`);
  if (named) return h(named);
  const described = event.type.replaceAll("_", " ").toLowerCase();
  return h(described.endsWith(" recorded") ? described : `${described} recorded`);
}


function eventRow(event) {
  const icon = { MEMBER_ADDED: "◉", MEMBER_INVITED: "◉", EXPENSE_RECORDED: "⌕", SETTLEMENT_RECORDED: "♢", SETTLEMENT_ASSERTED: "♢", SETTLEMENT_CONFIRMED: "♢", SESSION_ARCHIVED: "▣", SESSION_CLOSED_FINAL: "▣", SESSION_CLOSED_PROVISIONAL: "▣" }[event.type] || "·";
  return `<article class="event-row" id="event-${h(event.id)}" tabindex="-1"><span class="event-icon">${icon}</span><span class="event-copy"><span>${eventDescription(event)}</span><small>${eventDate(event.at)}</small></span></article>`;
}

function historyPage(current) {
  return `${header(t("history.title"), t("history.subtitle"), t("history.eyebrow"))}
    <section class="feature-card memory-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/verdict-seal.png" alt=""></div><div><div class="eyebrow">${t("history.card.eyebrow")}</div><h2>${t("history.card.title")}</h2><p>${t("history.card.body")}</p></div><span class="coming-tag">${t("history.events", { count: current.events.length })}</span></section>
    <section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("history.list.eyebrow")}</div><h2>${t("history.list.title")}</h2></div><span class="count">${t("history.count", { count: current.events.length })}</span></div>${current.events.length ? `<div class="event-list full-events">${[...current.events].reverse().map(eventRow).join("")}</div>` : emptyState(t("history.emptyTitle"), t("history.emptyBody"), "#members", t("history.emptyAction"))}</section>`;
}

function paymentPage(current) {
  const enough = current.members.length >= 2;
  const access = getAccessContext();
  const readOnly = access.role === "witness";
  const options = current.members.map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("");
  const payerOptions = current.members.filter((member) => access.role !== "member" || member.id === access.memberId).map((m) => `<option value="${h(m.id)}">${h(m.name)}</option>`).join("");
  const paypalButton = ledgerCurrency() === "USD" ? `<button class="button button-quiet" id="paypal-checkout" type="button">${t("payments.paypal")}</button>` : "";
  const forgivenessRows = !current.archived && !readOnly ? current.outstanding.filter((item) => access.role !== "member" || item.creditorId === access.memberId).map((item) => `<form class="forgiveness-form" data-debtor="${h(item.debtorId)}" data-creditor="${h(item.creditorId)}" data-max="${item.amountMinor}"><b>${t("forgive.owes", { debtor: h(memberName(item.debtorId)), creditor: h(memberName(item.creditorId)) })}</b><small>${t("forgive.outstanding", { amount: money(item.amountMinor) })}</small><label>${t("forgive.amount", { currency: h(ledgerCurrency()) })}<input name="amount" inputmode="decimal" required></label><label>${t("forgive.reason")}<input name="reason" maxlength="300" required></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">${t("forgive.cta")}</button></form>`).join("") : "";
  const assumptionRows = !current.archived && access.role === "member" ? current.outstanding.filter((item) => item.debtorId !== access.memberId && item.creditorId !== access.memberId).map((item) => `<form class="assumption-form" data-debtor="${h(item.debtorId)}" data-creditor="${h(item.creditorId)}" data-max="${item.amountMinor}"><b>${t("forgive.owes", { debtor: h(memberName(item.debtorId)), creditor: h(memberName(item.creditorId)) })}</b><small>${t("forgive.outstanding", { amount: money(item.amountMinor) })}</small><label>${t("assume.amount", { currency: h(ledgerCurrency()) })}<input name="amount" inputmode="decimal" required></label><label>${t("forgive.reason")}<input name="reason" maxlength="300" placeholder="${t("assume.reasonPlaceholder")}" required></label><output data-action-error role="alert" hidden></output><button class="button button-quiet" type="submit">${t("assume.cta")}</button></form>`).join("") : "";
  const pendingReconciliations = getServerState()?.paymentReconciliations ?? [];
  const reconciliationRows = access.role === "organizer" ? pendingReconciliations.map((item) => `<article class="expense-row reconciliation-row"><span class="row-icon payment-icon">!</span><span class="expense-meta"><b>${t("payments.recon.rowTitle")}</b><small>${h(memberName(item.fromMemberId))} → ${h(memberName(item.toMemberId))} · ${money(item.amountMinor)} · ${t("payments.recon.capture", { id: h(item.captureId) })} · ${eventDate(item.occurredAt)}</small><span>${h(item.reason ?? t("payments.recon.defaultReason"))}</span></span><button type="button" class="button button-quiet retry-reconciliation" data-order-id="${h(item.orderId)}">${t("payments.recon.retry")}</button></article>`).join("") : "";
  return `${header(t("payments.title"), t("payments.subtitle"), t("payments.eyebrow"))}
    <section class="feature-card elixir-card"><div class="feature-symbol feature-illustrated"><img class="chamber-art" src="/assets/elixir-vial.png" alt=""></div><div><div class="eyebrow">${t("payments.card.eyebrow")}</div><h2>${t("payments.card.title")}</h2><p>${t("payments.card.body")}</p></div><span class="coming-tag">${t("payments.card.tag")}</span></section>
    ${!enough ? emptyState(t("payments.emptyTitle"), t("payments.emptyBody"), "#members", t("expenses.emptyAction")) : current.archived || readOnly ? `<div class="sealed-banner"><span>✦</span><div><b>${readOnly ? t("expenses.witnessOnly") : t("expenses.readOnly")}</b><p>${readOnly ? t("payments.readOnly.witnessBody") : t("payments.readOnly.body")}</p></div></div>` : `<form class="form-panel payment-form" id="payment-form"><div class="form-heading"><div><div class="eyebrow">${t("payments.form.eyebrow")}</div><h2>${t("payments.form.title")}</h2></div><span class="form-index">04 / 05</span></div><div class="field-grid"><label>${t("payments.form.who")}<select name="from" required>${payerOptions}</select></label><label>${t("payments.form.received")}<select name="to" required>${options}</select></label><label>${t("payments.form.amount")} <span class="field-hint">${h(ledgerCurrency())}</span><input name="amount" inputmode="decimal" placeholder="0.00" required></label></div><div class="honesty-note"><span>i</span><p><b>${t("payments.form.pendingTitle")}</b> ${t("payments.form.pendingBody")}</p></div><div class="form-footer"><p>${t("payments.form.footer")}</p><div><button class="button button-gold" type="submit">${t("payments.form.cta")} <span>↗</span></button>${paypalButton}</div></div></form>`}
    ${reconciliationRows ? `<section class="panel reconciliation-panel" role="alert"><div class="section-title"><div><div class="eyebrow">${t("payments.recon.eyebrow")}</div><h2>${t("payments.recon.title")}</h2></div><span class="count">${t("payments.recon.count", { count: pendingReconciliations.length })}</span></div><p>${t("payments.recon.body")}</p><div class="expense-list">${reconciliationRows}</div></section>` : ""}
    <section class="panel history-panel"><div class="section-title"><div><div class="eyebrow">${t("payments.record.eyebrow")}</div><h2>${t("payments.record.title")}</h2></div><span class="count">${t("payments.record.count", { count: current.settlements.length })}</span></div>${current.settlements.length ? `<div class="expense-list">${[...current.settlements].reverse().map((event) => `<article class="expense-row"><span class="row-icon payment-icon">♢</span><span class="expense-meta"><b>${h(memberName(event.fromId))} → ${h(memberName(event.toId))}</b><small>${h(event.status ?? t("payments.status.recorded"))} · ${eventDate(event.at)}</small></span><strong>${money(event.cents)}</strong>${event.status === "pending" && event.rail !== "paypal" && event.toId === access.memberId ? `<button type="button" class="button button-quiet confirm-payment" data-settlement-id="${h(event.settlementId)}">${t("payments.confirm")}</button>` : ""}</article>`).join("")}</div>` : emptyState(t("payments.record.emptyTitle"), t("payments.record.emptyBody"), "#payments", t("payments.record.emptyAction"))}</section>
    ${forgivenessRows ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("forgive.eyebrow")}</div><h2>${t("forgive.title")}</h2></div></div><p>${t("forgive.body")}</p><div class="forgiveness-list">${forgivenessRows}</div></section>` : ""}
    ${assumptionRows ? `<section class="panel list-panel"><div class="section-title"><div><div class="eyebrow">${t("assume.eyebrow")}</div><h2>${t("assume.title")}</h2></div></div><p>${t("assume.body")}</p><div class="forgiveness-list">${assumptionRows}</div></section>` : ""}`;
}

function verdictPage(current) {
  const transfers = settleUp(current.balances);
  const allBalanced = [...current.balances.values()].every((value) => value === 0);
  return `${header(t("verdict.title"), t("verdict.subtitle"), t("verdict.eyebrow"))}
    <section class="verdict-paper"><div class="paper-seal">✳</div><div class="paper-eyebrow">${t("verdict.paper.eyebrow", { n: String(current.events.length).padStart(3, "0") })}</div><h2>${t("verdict.title")}</h2><p class="paper-subtitle">${t("verdict.paper.quote")}</p><div class="paper-rule"></div>${allBalanced ? `<div class="balanced-result"><span>✦</span><h3>${t("verdict.balanced.title")}</h3><p>${t("verdict.balanced.body")}</p></div>` : `<h3 class="paper-section-title">${t("verdict.transfers")}</h3>${transfers.length ? `<div class="transfer-list">${transfers.map((transfer, i) => `<article class="transfer-row"><span class="transfer-num">${String(i + 1).padStart(2, "0")}</span><span><b>${h(memberName(transfer.fromId))}</b><small>${t("verdict.mustPay")}</small><b>${h(memberName(transfer.toId))}</b></span><strong>${money(transfer.cents)}</strong></article>`).join("")}</div>` : `<p class="paper-empty">${t("verdict.noTransfers")}</p>`}`}<div class="paper-rule"></div><p class="paper-foot">${t("verdict.foot", { expenses: plural(current.expenses.length, "home.stat.expenses"), settlements: plural(current.settlements.length, "home.stat.settlements") })}</p></section>
    <section class="panel balances-panel"><div class="section-title"><div><div class="eyebrow">${t("verdict.balances.eyebrow")}</div><h2>${t("verdict.balances.title")}</h2></div><span class="method-tag">${t("verdict.balances.tag")}</span></div>${current.members.length ? `<div class="balance-grid">${current.members.map((m) => memberCard(m, current)).join("")}</div>` : emptyState(t("verdict.emptyTitle"), t("verdict.emptyBody"), "#members", t("verdict.emptyAction"))}</section>
    <div class="calculation-note"><span>i</span><p>${t("verdict.note")}</p></div>
    ${!current.archived ? `<section class="form-panel"><div class="eyebrow">${t("verdict.scenario.eyebrow")}</div><h2>${t("verdict.scenario.title")}</h2><form id="scenario-form"><label for="scenario-prompt">${t("verdict.scenario.label")}</label><textarea id="scenario-prompt" name="prompt" maxlength="1200" required placeholder="${t("verdict.scenario.placeholder")}"></textarea><button class="button button-quiet" type="submit">${t("verdict.scenario.cta")}</button></form><pre id="scenario-result" hidden aria-live="polite"></pre></section>` : ""}`;
}

function bindPage(current) {
  document.querySelectorAll(".retry-reconciliation").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments/${encodeURIComponent(button.dataset.orderId)}/reconcile`, { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("msg.reconciliation.could.not.be"));
      events = await loadLedger(); render(); showToast(t("msg.captured.payment.reconciled.without"));
    } catch (error) { showToast(error.message); button.disabled = false; }
  }));
  document.querySelector("#scenario-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const resultNode = document.querySelector("#scenario-result");
    try {
      const prompt = new FormData(event.currentTarget).get("prompt");
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/analysis/scenario`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` }, body: JSON.stringify({ prompt }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? t("msg.scenario.simulation.failed"));
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
      if (!response.ok) throw new Error(result.error ?? t("msg.could.not.create.invite"));
      const link = `${location.origin}${result.invitePath}`;
      try { await navigator.clipboard?.writeText(link); } catch { /* The visible invite path remains available to copy manually. */ }
      events = await loadLedger(); render();
      const output = document.querySelector("#invite-link");
      // The code is shown once. It is stored hashed, so it cannot be read back
      // out later and a lost one is replaced by inviting again.
      if (output) output.textContent = result.joinCode ? `Code ${result.joinCode} — say it out loud, or send the link: ${link}` : link;
      showToast(result.joinCode ? `Join code ${result.joinCode}. It works once, for 24 hours.` : t("msg.invite.link.created.share"));
    } catch (error) { showToast(error.message); }
  });

  document.querySelector("#join-code-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const field = event.target.elements.code;
    const result = document.querySelector("#join-code-result");
    const say = (text) => { if (result) { result.hidden = false; result.textContent = text; } };
    try {
      const response = await fetch("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: field.value }) });
      const claim = await response.json();
      if (!response.ok) throw new Error(claim.error ?? t("msg.that.code.could.not"));
      localStorage.setItem("the-black-ledger.session.v1", claim.sessionId);
      localStorage.setItem("the-black-ledger.access.v1", claim.accessToken);
      field.value = "";
      say("");
      events = await loadLedger();
      route = "home";
      render();
      showToast(claim.role === "witness" ? t("msg.you.joined.as.a") : t("msg.you.joined.the.ledger"));
    } catch (error) { say(error.message); }
  });

  document.querySelector("#analyze-receipt")?.addEventListener("click", async () => {
    const file = document.querySelector("#receipt-image")?.files?.[0];
    // Re-queried on every write: attaching the photo re-renders this panel, so a
    // reference captured beforehand writes into a detached node and the reader's
    // outcome never reaches the screen.
    const output = (text) => {
      const element = document.querySelector("#receipt-proposal");
      if (!element) return;
      element.hidden = false;
      element.textContent = text;
    };
    try {
      if (!file || file.size > 8_000_000) throw new Error(t("msg.choose.an.image.no"));
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error(t("msg.choose.a.jpeg.png"));
      output(t("msg.attaching.photo"));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      const dataBase64 = btoa(binary);
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const token = localStorage.getItem("the-black-ledger.access.v1");

      // The photo is the evidence; reading it is a convenience. Attach it first,
      // so a photo that is not a receipt at all, or an unavailable reader, still
      // leaves the image in the history instead of discarding it.
      const note = document.querySelector("#receipt-note")?.value?.trim();
      const evidenceResponse = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/evidence`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ mediaType: file.type, dataBase64, ...(note ? { note } : {}) }) });
      const evidence = await evidenceResponse.json();
      if (!evidenceResponse.ok) throw new Error(evidence.error ?? t("msg.could.not.attach.the"));
      if (!events.some((item) => item.id === evidence.event.id)) events = [...events, evidence.event];
      if (!pendingEvidenceIds.includes(evidence.id)) pendingEvidenceIds.push(evidence.id);
      render();

      output(t("msg.photo.attached.reading"));
      let proposal = null; let readerMessage = "";
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/analysis/receipt`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ mediaType: file.type, dataBase64 }) });
        const result = await response.json();
        if (response.ok) proposal = result.proposal;
        else readerMessage = result.error ?? "the reader returned an error";
      } catch { readerMessage = "the reader could not be reached"; }

      if (!proposal) {
        output(`Photo attached and recorded in the history.\n\nIt was not read automatically (${readerMessage}), so type the description and amount yourself. Leave the amount empty if this is only a reference.`);
        showToast(t("msg.photo.attached.enter.the"));
        return;
      }
      output(JSON.stringify(proposal, null, 2));
      const form = document.querySelector("#expense-form");
      const proposalCurrency = String(proposal.currency ?? "").toUpperCase();
      if (form && proposalCurrency && SUPPORTED_CURRENCIES.includes(proposalCurrency)) {
        form.elements.currency.value = proposalCurrency;
        form.elements.currency.dispatchEvent(new Event("change"));
      }
      if (form && proposal.merchant) form.elements.description.value = proposal.merchant;
      if (form && proposal.total) form.elements.amount.value = proposal.total;
      showToast(t("msg.photo.attached.and.a"));
    } catch (error) { output(error.message); }
  });

  document.querySelector("#member-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name").trim();
    if (!name || current.members.length >= 100) return showToast(t("msg.enter.a.name.the"));
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
    if (!memberIds.length) return showToast(t("msg.choose.at.least.one"));
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
      if (!memberIds.length) throw new Error(t("msg.select.at.least.one.participant.who"));
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const allocations = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(form, "COMMITMENT_RECORDED", { commitmentId: crypto.randomUUID(), description: String(data.get("description")).trim(), amountMinor, payerMemberId: data.get("payer"), allocations, refundability: data.get("refundability") }, t("msg.commitment.recorded.its.final"));
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
      if (!memberIds.length) throw new Error(t("msg.select.at.least.one.gift"));
      if (memberIds.includes(recipientMemberId) || payerMemberId === recipientMemberId) throw new Error(t("msg.the.recipient.cannot.pay"));
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const contributions = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(giftForm, "SURPRISE_GIFT_RECORDED", { giftId: crypto.randomUUID(), recipientMemberId, payerMemberId, privateDescription: String(data.get("description")).trim(), amountMinor, contributions }, t("msg.surprise.gift.recorded.its"));
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
      if (!period) throw new Error(t("msg.name.the.trip.or"));
      commitFromForm(budgetForm, "BUDGET_SET", { amountMinor, currency: ledgerCurrency(), period }, t("msg.budget.recorded.future.expenses"));
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
      output.textContent = t("msg.add.at.least.one");
      output.hidden = false;
      return;
    }
    commitFromForm(agreementForm, "SESSION_RULES_RECORDED", { sessionId: current.session.id, rules }, t("msg.agreement.recorded.in.the"));
  });

  const recurringRuleForm = document.querySelector("#recurring-rule-form");
  recurringRuleForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(recurringRuleForm);
      const amountMinor = parseLedgerAmount(data.get("amount"));
      const memberIds = data.getAll("recurringMember");
      if (!memberIds.length) throw new Error(t("msg.select.at.least.one.participant"));
      const base = Math.floor(amountMinor / memberIds.length);
      let remainder = amountMinor - base * memberIds.length;
      const allocations = memberIds.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      commitFromForm(recurringRuleForm, "RECURRING_RULE_APPROVED", { ruleId: crypto.randomUUID(), description: String(data.get("description")).trim(), amountMinor, allocations, cadence: String(data.get("cadence")).trim() }, t("msg.recurring.rule.approved.each"));
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
      output.textContent = alreadyRecorded ? t("msg.this.rule.already.has") : t("msg.this.recurring.rule.is");
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
      if (!item || amountMinor > Number(form.dataset.maxRefund)) throw new Error(t("msg.refund.must.be.no"));
      const allocations = allocateWeighted(amountMinor, item.allocations);
      commitFromForm(form, "COMMITMENT_REFUND_RECORDED", { commitmentId: item.commitmentId, amountMinor, allocations, reason: t("msg.refund.recorded.against.the") }, t("msg.commitment.refund.recorded"));
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
    if (!linkedExpense && outcome === "consumed" && remaining <= 0) return showToast(t("msg.a.fully.refunded.commitment"));
    button.disabled = true;
    if (!linkedExpense && remaining > 0) {
      const allocations = allocateWeighted(remaining, item.allocations);
      const recorded = await commit("EXPENSE_RECORDED", { expenseId: crypto.randomUUID(), description: item.description, payerId: item.payerMemberId, totalCents: remaining, allocations, commitmentId: item.commitmentId }, outcome === "consumed" ? t("msg.final.commitment.cost.recorded") : t("msg.nonrefundable.cancellation.cost.recorded"));
      if (!recorded) return;
    }
    commit("COMMITMENT_UPDATED", { commitmentId: item.commitmentId, status: outcome, reason: outcome === "consumed" ? t("msg.commitment.cost.was.recorded") : t("msg.commitment.was.cancelled.any") }, outcome === "consumed" ? t("msg.commitment.marked.as.used") : t("msg.commitment.cancelled.with.its"));
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
    document.querySelector("#source-total-label").textContent = t("expenses.form.originalTotal", { currency: currencySelect.value });
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
        const saved = await commit("EXPENSE_UNASSIGNED", { description: String(data.get("description")).trim(), amountMinor: details.amountMinor, currency: details.currency, baseAmountMinor: details.baseAmountMinor, totalCents: details.baseAmountMinor, fx: details.fx, allocations: [], evidenceIds: [...pendingEvidenceIds] }, t("msg.charge.recorded.as.unassigned"));
        if (saved) pendingEvidenceIds = [];
        return;
      }
      const ids = data.getAll("beneficiary");
      if (!ids.length) throw new Error(t("msg.select.at.least.one"));
      let allocations;
      if (data.get("splitMode") === "custom") {
        allocations = ids.map((memberId) => ({ memberId, cents: parseLedgerAmount(data.get(`share-${memberId}`)) }));
        if (allocations.reduce((sum, row) => sum + row.cents, 0) !== totalMinor) throw new Error(t("msg.custom.shares.must.sum"));
      } else {
        const base = Math.floor(totalMinor / ids.length);
        let remainder = totalMinor - base * ids.length;
        allocations = ids.map((memberId) => ({ memberId, cents: base + (remainder-- > 0 ? 1 : 0) }));
      }
      const groupId = data.get("group");
      const saved = await commit("EXPENSE_RECORDED", { description: String(data.get("description")).trim(), payerId, amountMinor: details.amountMinor, currency: details.currency, baseAmountMinor: details.baseAmountMinor, totalCents: details.baseAmountMinor, fx: details.fx, allocations, groupIds: groupId ? [groupId] : [], evidenceIds: [...pendingEvidenceIds] }, t("msg.expense.entered.into.the"));
      if (saved) pendingEvidenceIds = [];
    } catch (error) { showToast(error.message); }
  });

  document.querySelectorAll(".expense-confirm").forEach((button) => button.addEventListener("click", () => {
    const access = getAccessContext();
    commit("MEMBER_CONFIRMED_EXPENSE", { expenseId: button.dataset.expenseId, memberId: access.memberId, decision: "accepted" }, t("msg.your.share.confirmation.was"));
  }));

  document.querySelectorAll(".discrepancy-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const claim = String(new FormData(form).get("claim")).trim();
    if (!claim) { const output = form.querySelector("[data-action-error]"); output.textContent = t("msg.describe.what.does.not"); output.hidden = false; form.elements.claim.focus(); return; }
    commitFromForm(form, "EXPENSE_DISCREPANCY_RECORDED", { expenseId: form.dataset.expenseId, discrepancyId: crypto.randomUUID(), raisedByMemberId: getAccessContext().memberId, claim }, t("msg.discrepancy.recorded.for.organizer"));
  }));

  document.querySelectorAll(".resolution-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const resolution = String(new FormData(form).get("resolution")).trim();
    if (!resolution) { const output = form.querySelector("[data-action-error]"); output.textContent = t("msg.record.how.this.discrepancy"); output.hidden = false; form.elements.resolution.focus(); return; }
    commitFromForm(form, "EXPENSE_DISCREPANCY_RESOLVED", { discrepancyId: form.dataset.discrepancyId, resolution }, t("msg.discrepancy.resolution.recorded"));
  }));

  document.querySelector("#payment-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(event.currentTarget);
      const fromId = data.get("from"); const toId = data.get("to");
      if (fromId === toId) throw new Error(t("msg.choose.two.different.participants"));
      const cents = parseLedgerAmount(data.get("amount"));
      commit("SETTLEMENT_ASSERTED", { settlementId: crypto.randomUUID(), fromMemberId: fromId, toMemberId: toId, amountMinor: cents, rail: "other" }, t("msg.payment.claim.is.pending"));
    } catch (error) { showToast(error.message); }
  });

  document.querySelectorAll(".confirm-payment").forEach((button) => button.addEventListener("click", () => {
    const access = getAccessContext();
    commit("SETTLEMENT_CONFIRMED", { settlementId: button.dataset.settlementId, confirmedByMemberId: access.memberId, confirmationSource: "recipient_confirmation" }, t("msg.you.confirmed.receipt.the"));
  }));

  document.querySelector("#paypal-checkout")?.addEventListener("click", async () => {
    try {
      const data = new FormData(document.querySelector("#payment-form"));
      const fromMemberId = data.get("from"); const toMemberId = data.get("to");
      if (!fromMemberId || !toMemberId || fromMemberId === toMemberId) throw new Error(t("msg.choose.two.different.participants"));
      const amountMinor = parseLedgerAmount(data.get("amount"));
      const sessionId = localStorage.getItem("the-black-ledger.session.v1");
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ fromMemberId, toMemberId, amountMinor }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? t("msg.could.not.create.paypal"));
      if (!result.approvalUrl) throw new Error(t("msg.paypal.returned.no.buyer"));
      location.assign(result.approvalUrl);
    } catch (error) { showToast(error.message); }
  });

  document.querySelectorAll(".forgiveness-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(form);
      const amountMinor = parseLedgerAmount(data.get("amount"));
      if (amountMinor > Number(form.dataset.max)) throw new Error(t("msg.forgiveness.cannot.exceed.the"));
      const saved = commitFromForm(form, "OBLIGATION_FORGIVEN", { debtorId: form.dataset.debtor, creditorId: form.dataset.creditor, amountMinor, reason: String(data.get("reason")).trim() }, t("msg.partial.forgiveness.recorded.no"));
      void saved;
    } catch (error) {
      const output = form.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  }));

  document.querySelectorAll(".assumption-form").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const data = new FormData(form);
      const amountMinor = parseLedgerAmount(data.get("amount"));
      if (amountMinor > Number(form.dataset.max)) throw new Error(t("msg.you.cannot.assume.more"));
      commitFromForm(form, "RESPONSIBILITY_ASSUMED", { fromMemberId: form.dataset.debtor, toMemberId: getAccessContext().memberId, creditorMemberId: form.dataset.creditor, amountMinor, reason: String(data.get("reason")).trim() }, t("msg.responsibility.transfer.recorded.with"));
    } catch (error) {
      const output = form.querySelector("[data-action-error]");
      output.textContent = error.message;
      output.hidden = false;
    }
  }));
}

let evidenceObjectUrls = [];
async function hydrateEvidenceImages() {
  for (const url of evidenceObjectUrls) URL.revokeObjectURL(url);
  evidenceObjectUrls = [];
  const sessionId = localStorage.getItem("the-black-ledger.session.v1");
  const token = localStorage.getItem("the-black-ledger.access.v1");
  if (!sessionId || !token) return;
  for (const image of document.querySelectorAll("img[data-evidence]")) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/evidence/${encodeURIComponent(image.dataset.evidence)}`, { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) { image.replaceWith(Object.assign(document.createElement("small"), { textContent: t("msg.photo.unavailable") })); continue; }
      const url = URL.createObjectURL(await response.blob());
      evidenceObjectUrls.push(url);
      image.src = url;
    } catch { image.replaceWith(Object.assign(document.createElement("small"), { textContent: t("msg.photo.unavailable") })); }
  }
}

// The shell is static HTML, so its text is filled from the dictionary rather
// than rebuilt. Defaults in the markup stay readable if this never runs.
function applyShellTranslations() {
  document.documentElement.lang = currentLanguage();
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-html]")) node.innerHTML = t(node.dataset.i18nHtml);
  for (const node of document.querySelectorAll("[data-i18n-attr]")) {
    const [attribute, key] = node.dataset.i18nAttr.split(":");
    if (attribute && key) node.setAttribute(attribute, t(key));
  }
  const toggle = document.querySelector("#language-toggle");
  if (toggle) toggle.textContent = currentLanguage().toUpperCase();
}

function render() {
  applyShellTranslations();
  if (!events) return;
  const current = ledger();
  document.querySelector("#export-button").hidden = getAccessContext().role !== "organizer";
  if (!routes.has(route)) route = "home";
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
  const pages = { home: homePage, members: membersPage, expenses: expensePage, history: historyPage, payments: paymentPage, verdict: verdictPage };
  view.innerHTML = pages[route](current);
  bindPage(current);
  hydrateEvidenceImages();
  if (route === "history" && location.hash.startsWith("#history/")) {
    let id;
    try { id = decodeURIComponent(location.hash.slice("#history/".length)); } catch { id = ""; }
    const target = document.getElementById(`event-${id}`);
    if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); }
  }
  document.querySelector("#archive-button")?.addEventListener("click", () => {
    const dialog = document.querySelector("#confirm-dialog");
    const blockers = current.closureBlockers;
    document.querySelector("#archive-balance-note").textContent = blockers.length ? `This will be a provisional close. ${blockers.map((item) => item.message).join(" ")}` : t("msg.all.records.are.resolved");
    dialog.showModal();
  });
}

document.querySelector("#main-nav").addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (link) route = link.dataset.route;
});
window.addEventListener("hashchange", () => { route = location.hash.slice(1).split("/")[0] || "home"; render(); });

// Bound once: the badge sits outside the rendered view, so it survives renders.
document.querySelector("#language-toggle")?.addEventListener("click", () => {
  setLanguage(currentLanguage() === "es" ? "en" : "es");
  render();
});
const syncChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("the-black-ledger-sync-v1");
syncChannel?.addEventListener("message", async (event) => {
  if (event.data?.sessionId !== localStorage.getItem("the-black-ledger.session.v1")) return;
  try { events = await loadLedger(); render(); showToast(t("msg.the.ledger.was.refreshed")); }
  catch (error) { showToast(error.message); }
});
document.querySelector("#export-button").addEventListener("click", async () => {
  try { await exportLedger(); showToast(t("msg.the.integritychecked.evidence.package")); }
  catch (error) { showToast(error.message); }
});
document.querySelector("#cancel-archive").addEventListener("click", () => document.querySelector("#confirm-dialog").close());
document.querySelector("#confirm-archive").addEventListener("click", () => {
  const current = ledger();
  const provisional = current.closureBlockers.length > 0;
  document.querySelector("#confirm-dialog").close();
  commit(provisional ? "SESSION_CLOSED_PROVISIONAL" : "SESSION_CLOSED_FINAL", { reason: provisional ? t("msg.organizer.accepted.a.provisional") : t("msg.all.closure.checks.passed") }, provisional ? t("msg.provisional.close.recorded.the") : t("msg.the.journey.was.finally"));
});
render();
const paymentReturn = new URLSearchParams(location.search);
if (paymentReturn.get("payment") === "return" && paymentReturn.get("token")) {
  const orderId = paymentReturn.get("token");
  history.replaceState(null, "", `${location.pathname}#payments`);
  const sessionId = localStorage.getItem("the-black-ledger.session.v1");
  fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments/${encodeURIComponent(orderId)}/capture`, { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` } })
    .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? t("msg.paypal.capture.failed")); return result; })
    .then(async (result) => { events = await loadLedger(); render(); showToast(result.status === "COMPLETED" ? t("msg.paypal.capture.confirmed.by") : result.status === "RECONCILIATION_REQUIRED" ? t("msg.paypal.completed.the.capture") : t("msg.paypal.payment.is.still")); })
    .catch((error) => showToast(error.message));
} else if (paymentReturn.get("payment") === "cancel") {
  const orderId = paymentReturn.get("token");
  history.replaceState(null, "", `${location.pathname}#payments`);
  if (orderId) {
    const sessionId = localStorage.getItem("the-black-ledger.session.v1");
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/payments/${encodeURIComponent(orderId)}/cancel`, { method: "POST", headers: { authorization: `Bearer ${localStorage.getItem("the-black-ledger.access.v1")}` } })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? t("msg.could.not.record.checkout")); events = await loadLedger(); render(); showToast(t("msg.paypal.checkout.was.cancelled")); })
      .catch((error) => showToast(error.message));
  } else showToast(t("msg.paypal.checkout.was.cancelled"));
}
