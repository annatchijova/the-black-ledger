import { currencyExponent, convertMinorUnits } from "./money.js";

export const MAX_EVENTS = 10_000;
export const MAX_MEMBERS = 100;
export const MAX_LINE_ITEMS = 500;
export const MAX_AMOUNT_MINOR = 1_000_000_000_000;

const EVENT_TYPES = new Set([
  "SESSION_CREATED", "SESSION_RULES_RECORDED", "MEMBER_ADDED", "MEMBER_STATUS_CHANGED", "MEMBER_INVITED", "MEMBER_JOINED",
  "GROUP_CREATED", "GROUP_MEMBERS_CHANGED", "MEMBER_CONFIRMED_EXPENSE", "EXPENSE_RECORDED", "EXPENSE_CORRECTED",
  "EXPENSE_DISCREPANCY_RECORDED", "EXPENSE_DISCREPANCY_RESOLVED", "EXPENSE_UNASSIGNED", "COMMITMENT_RECORDED",
  "COMMITMENT_UPDATED", "COMMITMENT_REFUND_RECORDED", "SETTLEMENT_ASSERTED", "SETTLEMENT_CONFIRMED", "SETTLEMENT_STATUS_RECORDED", "SETTLEMENT_REFUNDED", "SETTLEMENT_REVERSED",
  "SETTLEMENT_RECORDED", "OBLIGATION_FORGIVEN", "RESPONSIBILITY_ASSUMED", "BUDGET_SET", "RECURRING_RULE_APPROVED",
  "OBLIGATION_CARRIED",
  "OBLIGATION_CARRIED_OUT",
  "RECURRING_INSTANCE_RECORDED", "EVIDENCE_ATTACHED", "SURPRISE_GIFT_RECORDED", "SESSION_CLOSED_PROVISIONAL",
  "SESSION_CLOSED_FINAL", "SESSION_REOPENED", "SESSION_ARCHIVED"
]);
const ID = /^[a-zA-Z0-9_-]{1,100}$/;

export function validId(value) { return typeof value === "string" && ID.test(value); }
export function validText(value, limit = 240) { return typeof value === "string" && value.trim().length > 0 && value.length <= limit; }
export function validMinor(value, { zero = false } = {}) {
  return Number.isSafeInteger(value) && value >= (zero ? 0 : 1) && value <= MAX_AMOUNT_MINOR;
}
function fail(message) { throw new Error(message); }
function requireId(value, label) { if (!validId(value)) fail(`${label} must be a valid ID.`); }
function requireText(value, label, limit) { if (!validText(value, limit)) fail(`${label} is required and must be at most ${limit} characters.`); }
function requireAmount(value, label = "Amount", zero = false) { if (!validMinor(value, { zero })) fail(`${label} must be a safe integer minor-unit amount.`); }
function requireMemberPair(fromId, toId) {
  requireId(fromId, "Source participant"); requireId(toId, "Target participant");
  if (fromId === toId) fail("An obligation must involve two different participants.");
}
function requireAllocations(rows, field = "allocations") {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_MEMBERS) fail(`${field} must contain between 1 and ${MAX_MEMBERS} rows.`);
  const ids = new Set(); let sum = 0n;
  for (const row of rows) {
    const memberId = row?.memberId;
    requireId(memberId, "Allocation participant");
    if (ids.has(memberId)) fail("An allocation may mention each participant once.");
    ids.add(memberId);
    const amount = row.baseMinor ?? row.amountMinor ?? row.cents;
    requireAmount(amount, "Allocation", true);
    sum += BigInt(amount);
  }
  if (sum > BigInt(MAX_AMOUNT_MINOR)) fail("Allocation total is outside the supported range.");
  return Number(sum);
}
function validateFx(fx, sourceCurrency, targetCurrency, originalMinor, baseMinor) {
  if (!fx || typeof fx !== "object") fail("A cross-currency expense must preserve its exchange-rate evidence.");
  if (fx.sourceCurrency !== sourceCurrency || fx.targetCurrency !== targetCurrency) fail("Exchange-rate currencies do not match the expense.");
  if (typeof fx.numerator !== "string" || !/^\d{1,24}$/.test(fx.numerator) || typeof fx.denominator !== "string" || !/^\d{1,24}$/.test(fx.denominator)) fail("Exchange rates must be stored as positive integer strings.");
  if (BigInt(fx.numerator) <= 0n || BigInt(fx.denominator) <= 0n) fail("Exchange rates must be positive.");
  requireText(fx.source, "Exchange-rate source", 120);
  if (typeof fx.observedAt !== "string" || !Number.isFinite(Date.parse(fx.observedAt))) fail("Exchange-rate observation time is invalid.");
  if (!Number.isSafeInteger(originalMinor) || !Number.isSafeInteger(baseMinor)) fail("Converted amounts must be integer minor units.");
  const expected = convertMinorUnits(originalMinor, sourceCurrency, targetCurrency, fx.numerator, fx.denominator);
  const fee = fx.feeMinor ?? 0;
  requireAmount(fee, "Conversion fee", true);
  if (expected + fee !== baseMinor) fail("Converted amount and recorded conversion fee do not reconcile to the base total.");
  if (fee > 0) requireId(fx.feePayerMemberId, "Participant who paid the conversion fee");
}

export function normalizeExpense(event, baseCurrency = "USD") {
  const originalMinor = event.amountMinor ?? event.totalMinor ?? event.totalCents;
  const originalCurrency = String(event.currency ?? baseCurrency).toUpperCase();
  currencyExponent(originalCurrency);
  const baseAmountMinor = event.baseAmountMinor ?? event.totalCents ?? originalMinor;
  const paidByMemberId = event.paidByMemberId ?? event.payerId;
  const allocations = Array.isArray(event.allocations) ? event.allocations.map((row) => ({
    memberId: row.memberId,
    baseMinor: row.baseMinor ?? row.amountMinor ?? row.cents
  })) : [];
  const description = event.description ?? event.merchant;
  const isUnassigned = event.status === "unassigned" || event.type === "EXPENSE_UNASSIGNED";
  if (!isUnassigned || paidByMemberId !== undefined && paidByMemberId !== null) requireId(paidByMemberId, "Paying participant");
  if (isUnassigned && allocations.length) fail("An unassigned expense cannot contain guessed allocations.");
  requireText(description, "Expense description", 240);
  requireAmount(originalMinor, "Original expense amount");
  requireAmount(baseAmountMinor, "Base-currency expense amount");
  const allocationTotal = allocations.length ? requireAllocations(allocations) : 0;
  if (!isUnassigned && allocationTotal !== baseAmountMinor) fail("Expense allocations must reconcile exactly to the base-currency total.");
  if (originalCurrency !== baseCurrency) validateFx(event.fx, originalCurrency, baseCurrency, originalMinor, baseAmountMinor);
  const groupIds = event.groupIds ?? [];
  const evidenceIds = event.evidenceIds ?? [];
  if (!Array.isArray(groupIds) || groupIds.length > MAX_MEMBERS || new Set(groupIds).size !== groupIds.length) fail("Expense subgroup references are invalid.");
  groupIds.forEach((id) => requireId(id, "Expense subgroup"));
  if (!Array.isArray(evidenceIds) || evidenceIds.length > 50 || new Set(evidenceIds).size !== evidenceIds.length) fail("Expense evidence references are invalid.");
  evidenceIds.forEach((id) => requireId(id, "Expense evidence"));
  if (event.duplicateOf != null) requireId(event.duplicateOf, "Possible duplicate expense");
  if (!new Set(["participants", "organizer", "private"]).has(event.visibility ?? "participants")) fail("Expense visibility is invalid.");
  if (event.anonymousPayer !== undefined && typeof event.anonymousPayer !== "boolean") fail("Anonymous payer flag must be boolean.");
  const itemRows = event.lineItems ?? event.items ?? [];
  if (!Array.isArray(itemRows) || itemRows.length > MAX_LINE_ITEMS) fail(`An expense may contain at most ${MAX_LINE_ITEMS} line items.`);
  if (itemRows.length) {
    let itemTotal = 0n;
    for (const item of itemRows) {
      requireId(item.id, "Line-item ID");
      requireText(item.description, "Line-item description", 180);
      requireAmount(item.amountMinor ?? item.cents, "Line-item amount", true);
      itemTotal += BigInt(item.amountMinor ?? item.cents);
    }
    if (event.itemsIncludeAdjustments === true && itemTotal !== BigInt(originalMinor)) fail("Line items and adjustments do not reconcile to the receipt total.");
  }
  const totals = event.totals;
  if (totals) {
    const expected = BigInt(totals.subtotalMinor ?? 0) + BigInt(totals.taxMinor ?? 0) + BigInt(totals.tipMinor ?? 0) + BigInt(totals.feeMinor ?? 0) - BigInt(totals.discountMinor ?? 0);
    if (expected !== BigInt(originalMinor)) fail("Subtotal, tax, tip, fee, and discount do not reconcile to the expense total.");
  }
  return {
    id: event.expenseId ?? event.id,
    description,
    payerId: paidByMemberId,
    amountMinor: originalMinor,
    currency: originalCurrency,
    baseAmountMinor,
    fx: event.fx ?? null,
    allocations,
    status: isUnassigned ? "unassigned" : "posted",
    groupIds,
    lineItems: itemRows,
    evidenceIds,
    duplicateOf: event.duplicateOf ?? null,
    visibility: event.visibility ?? "participants",
    anonymousPayer: event.anonymousPayer === true,
    commitmentId: event.commitmentId ?? null,
    recurringRuleId: event.recurringRuleId ?? null,
    sourceEventId: event.id,
    at: event.at
  };
}

export function validateEvent(event, baseCurrency = "USD") {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("Event must be an object.");
  requireId(event.id, "Event ID");
  if (typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at))) fail("Event timestamp must be a valid date-time.");
  if (!EVENT_TYPES.has(event.type)) fail(`Unsupported event type: ${String(event.type)}.`);
  switch (event.type) {
    case "SESSION_CREATED":
      requireId(event.sessionId, "Session ID"); requireText(event.name, "Session name", 100); currencyExponent(event.baseCurrency);
      break;
    case "SESSION_RULES_RECORDED":
      requireId(event.sessionId, "Session ID"); if (!Array.isArray(event.rules) || event.rules.length > 50) fail("Session rules must be a bounded list.");
      break;
    case "MEMBER_ADDED":
      requireId(event.memberId, "Participant ID"); requireText(event.name, "Participant name", 80);
      break;
    case "MEMBER_INVITED":
      requireId(event.memberId, "Participant ID"); requireText(event.name, "Participant name", 80);
      if (!new Set(["member", "witness", "organizer"]).has(event.role)) fail("Invitation role is invalid.");
      break;
    case "MEMBER_JOINED":
    case "MEMBER_STATUS_CHANGED":
      requireId(event.memberId, "Participant ID");
      if (event.type === "MEMBER_STATUS_CHANGED" && !new Set(["active", "departed", "removed"]).has(event.status)) fail("Participant status is invalid.");
      break;
    case "GROUP_CREATED":
      requireId(event.groupId, "Group ID"); requireText(event.name, "Group name", 80);
      if (!Array.isArray(event.memberIds) || event.memberIds.length < 1 || event.memberIds.length > MAX_MEMBERS || new Set(event.memberIds).size !== event.memberIds.length) fail("A subgroup requires a bounded, unique participant list.");
      event.memberIds.forEach((id) => requireId(id, "Subgroup participant"));
      break;
    case "GROUP_MEMBERS_CHANGED":
      requireId(event.groupId, "Group ID");
      if (!Array.isArray(event.memberIds) || event.memberIds.length > MAX_MEMBERS || new Set(event.memberIds).size !== event.memberIds.length) fail("Subgroup membership is invalid.");
      event.memberIds.forEach((id) => requireId(id, "Subgroup participant"));
      break;
    case "MEMBER_CONFIRMED_EXPENSE":
      requireId(event.expenseId, "Expense ID"); requireId(event.memberId, "Participant ID");
      if (!new Set(["accepted", "disputed"]).has(event.decision)) fail("Expense confirmation must be accepted or disputed.");
      if (event.decision === "disputed") requireText(event.reason, "Dispute reason", 500);
      break;
    case "EXPENSE_RECORDED":
    case "EXPENSE_UNASSIGNED":
      normalizeExpense(event, baseCurrency);
      break;
    case "EXPENSE_CORRECTED":
      requireId(event.expenseId, "Expense ID"); requireId(event.supersedesEventId, "Superseded event ID"); requireText(event.reason, "Correction reason", 500);
      normalizeExpense({ ...event.replacement, id: event.id, at: event.at, type: "EXPENSE_RECORDED" }, baseCurrency);
      break;
    case "EXPENSE_DISCREPANCY_RECORDED":
      requireId(event.expenseId, "Expense ID"); requireId(event.discrepancyId, "Discrepancy ID"); requireId(event.raisedByMemberId, "Participant ID"); requireText(event.claim, "Discrepancy", 500);
      break;
    case "EXPENSE_DISCREPANCY_RESOLVED":
      requireId(event.discrepancyId, "Discrepancy ID"); requireText(event.resolution, "Resolution", 500);
      break;
    case "COMMITMENT_RECORDED":
      requireId(event.commitmentId, "Commitment ID"); requireText(event.description, "Commitment description", 240); requireAmount(event.amountMinor);
      requireId(event.payerMemberId, "Commitment payer");
      requireAllocations(event.allocations);
      if (requireAllocations(event.allocations) !== event.amountMinor) fail("Commitment allocations must reconcile exactly.");
      if (!new Set(["refundable", "partially_refundable", "nonrefundable"]).has(event.refundability)) fail("Refundability must be explicit.");
      break;
    case "COMMITMENT_UPDATED":
      requireId(event.commitmentId, "Commitment ID"); requireText(event.reason, "Commitment update reason", 500);
      if (!new Set(["open", "consumed", "cancelled"]).has(event.status)) fail("Commitment status must be open, consumed, or cancelled.");
      break;
    case "COMMITMENT_REFUND_RECORDED":
      requireId(event.commitmentId, "Commitment ID"); requireAmount(event.amountMinor); requireText(event.reason, "Refund reason", 500);
      requireAllocations(event.allocations);
      if (requireAllocations(event.allocations) !== event.amountMinor) fail("Refund allocations must reconcile exactly.");
      break;
    case "SETTLEMENT_ASSERTED":
      requireId(event.settlementId, "Settlement ID"); requireMemberPair(event.fromMemberId, event.toMemberId); requireAmount(event.amountMinor);
      if (!new Set(["cash", "bank_transfer", "paypal", "other"]).has(event.rail)) fail("Settlement rail is invalid.");
      break;
    case "SETTLEMENT_CONFIRMED":
      requireId(event.settlementId, "Settlement ID"); requireId(event.confirmedByMemberId, "Confirming participant");
      if (!new Set(["recipient_confirmation", "organizer_record", "provider_capture"]).has(event.confirmationSource)) fail("Settlement confirmation source is invalid.");
      if (event.confirmationSource === "provider_capture") {
        requireText(event.provider, "Payment provider", 40); requireText(event.providerCaptureId, "Provider capture ID", 120);
        if (event.providerStatus !== "COMPLETED") fail("A payment is posted only after the provider reports completion.");
      }
      break;
    case "SETTLEMENT_REVERSED":
      requireId(event.settlementId, "Settlement ID"); requireText(event.reason, "Reversal reason", 500);
      break;
    case "SETTLEMENT_STATUS_RECORDED":
      requireId(event.settlementId, "Settlement ID");
      if (!new Set(["pending", "denied", "cancelled"]).has(event.status)) fail("Settlement status must be pending, denied, or cancelled.");
      requireText(event.reason, "Settlement status reason", 500);
      break;
    case "SETTLEMENT_REFUNDED":
      requireId(event.settlementId, "Settlement ID"); requireAmount(event.amountMinor); requireText(event.reason, "Refund reason", 500);
      break;
    case "SETTLEMENT_RECORDED":
      requireMemberPair(event.fromId, event.toId); requireAmount(event.cents);
      break;
    case "OBLIGATION_FORGIVEN":
      requireMemberPair(event.debtorId, event.creditorId); requireAmount(event.amountMinor); requireText(event.reason, "Forgiveness reason", 500);
      break;
    case "OBLIGATION_CARRIED":
      requireId(event.originSessionId, "Origin session ID"); requireId(event.originObligationId, "Origin obligation ID");
      requireId(event.sourceDebtorId, "Origin debtor"); requireId(event.sourceCreditorId, "Origin creditor");
      requireMemberPair(event.debtorId, event.creditorId); requireAmount(event.amountMinor);
      break;
    case "OBLIGATION_CARRIED_OUT":
      requireId(event.targetSessionId, "Target session ID"); requireId(event.transferId, "Transfer ID");
      requireMemberPair(event.debtorId, event.creditorId); requireAmount(event.amountMinor);
      break;
    case "RESPONSIBILITY_ASSUMED":
      requireMemberPair(event.fromMemberId, event.toMemberId); requireId(event.creditorMemberId, "Obligation creditor");
      if (event.creditorMemberId === event.fromMemberId || event.creditorMemberId === event.toMemberId) fail("The creditor and both responsible participants must be different.");
      requireAmount(event.amountMinor); requireText(event.reason, "Responsibility-transfer reason", 500);
      break;
    case "BUDGET_SET":
      requireAmount(event.amountMinor); currencyExponent(event.currency); requireText(event.period, "Budget period", 80);
      break;
    case "RECURRING_RULE_APPROVED":
      requireId(event.ruleId, "Recurring-rule ID"); requireText(event.description, "Recurring expense", 180); requireAmount(event.amountMinor);
      requireAllocations(event.allocations);
      if (requireAllocations(event.allocations) !== event.amountMinor) fail("Recurring allocations must reconcile exactly.");
      requireText(event.cadence, "Recurrence cadence", 40);
      break;
    case "RECURRING_INSTANCE_RECORDED":
      requireId(event.ruleId, "Recurring-rule ID"); requireText(event.periodKey, "Recurrence period key", 40); requireId(event.expenseEventId, "Generated expense event ID");
      break;
    case "EVIDENCE_ATTACHED":
      requireId(event.evidenceId, "Evidence ID"); requireText(event.contentHash, "Evidence content hash", 64); requireText(event.mediaType, "Evidence media type", 80);
      if (!/^[a-f0-9]{64}$/i.test(event.contentHash)) fail("Evidence content hash must be a SHA-256 digest.");
      if (!Number.isSafeInteger(event.byteLength) || event.byteLength < 1 || event.byteLength > 8_000_000) fail("Evidence file exceeds the 8 MB limit.");
      break;
    case "SURPRISE_GIFT_RECORDED":
      requireId(event.giftId, "Gift ID"); requireId(event.recipientMemberId, "Gift recipient"); requireId(event.payerMemberId, "Gift payer"); requireText(event.privateDescription, "Gift description", 240); requireAmount(event.amountMinor);
      requireAllocations(event.contributions);
      if (requireAllocations(event.contributions) !== event.amountMinor) fail("Gift contributions must reconcile exactly.");
      break;
    case "SESSION_CLOSED_PROVISIONAL":
      requireText(event.reason, "Provisional-close reason", 500);
      break;
    case "SESSION_CLOSED_FINAL":
    case "SESSION_REOPENED":
    case "SESSION_ARCHIVED":
      break;
    default: fail(`No validator is defined for ${event.type}.`);
  }
  return event;
}

export function parseEventLog(input, baseCurrency = "USD") {
  if (!Array.isArray(input) || input.length > MAX_EVENTS) fail(`Event log must contain at most ${MAX_EVENTS} entries.`);
  const ids = new Set();
  const result = input.map((event) => {
    validateEvent(event, baseCurrency);
    if (ids.has(event.id)) fail("Event IDs must be unique.");
    ids.add(event.id);
    return event;
  });
  return result;
}

export function makeEvent(type, fields = {}) {
  return { id: crypto.randomUUID(), at: new Date().toISOString(), type, ...fields };
}
