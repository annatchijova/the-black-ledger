import { parseAmountToMinor, formatMoney, divideMinorUnits, sumMinor } from "./domain/money.js";
import { validateEvent, parseEventLog, normalizeExpense, makeEvent } from "./domain/events.js";
import { canonicalStringify } from "./domain/canonical.js";

export { parseAmountToMinor, formatMoney, divideMinorUnits, sumMinor, parseEventLog, makeEvent };
export { parseAmountToCents } from "./domain/money.js";

const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
const keyOf = (a, b) => `${a}\0${b}`;

function closureBlockers(state) {
  const blockers = [];
  for (const expense of state.expenses.values()) {
    if (expense.status === "unassigned") blockers.push({ code: "unassigned_expense", id: expense.id, message: `Expense “${expense.description}” has no confirmed allocation.` });
  }
  for (const [id, confirmation] of state.confirmations) {
    if (confirmation.decision === "disputed") blockers.push({ code: "disputed_expense", id, message: `Expense ${id} has an unresolved participant dispute.` });
  }
  for (const commitment of state.commitments.values()) {
    if (commitment.status !== "consumed" && commitment.status !== "cancelled") blockers.push({ code: "open_commitment", id: commitment.id, message: `Commitment “${commitment.description}” is still ${commitment.status ?? "open"}.` });
  }
  for (const [id, discrepancy] of state.discrepancies) {
    if (!discrepancy.resolution) blockers.push({ code: "unresolved_discrepancy", id, message: `Discrepancy ${id} has no resolution.` });
  }
  for (const settlement of state.settlements.values()) {
    if (settlement.status === "pending" || settlement.status === "asserted") blockers.push({ code: "pending_payment", id: settlement.id, message: `Payment ${settlement.id} has not been confirmed.` });
  }
  if (state.balances && [...state.balances.values()].some((balance) => balance !== 0)) blockers.push({ code: "outstanding_balances", message: "One or more participant balances remain unsettled." });
  return blockers;
}

export function deriveLedger(rawEvents, { baseCurrency = "USD" } = {}) {
  const events = parseEventLog(rawEvents, baseCurrency);
  const members = new Map(); const groups = new Map(); const expenses = new Map();
  const settlements = new Map(); const commitments = new Map(); const discrepancies = new Map();
  const confirmations = new Map(); const forgiven = new Map(); const assumed = [];
  const carried = [];
  const carriedOut = [];
  const budgets = []; const recurringRules = new Map(); const recurringPeriods = new Set();
  const eventById = new Map(); const superseded = new Set(); const evidence = new Map();
  const gifts = new Map(); const rules = []; const stateChanges = [];
  let session = null; let archived = false; let closure = null;
  for (const event of events) {
    if (archived) throw new Error("This ledger contains events after its final archive record.");
    eventById.set(event.id, event);
    switch (event.type) {
      case "SESSION_CREATED":
        if (session) throw new Error("A ledger may contain only one session creation event.");
        session = { id: event.sessionId, name: event.name, baseCurrency: event.baseCurrency, createdAt: event.at };
        break;
      case "SESSION_RULES_RECORDED": rules.push(...event.rules); break;
      case "MEMBER_ADDED": case "MEMBER_INVITED": case "MEMBER_JOINED":
        if (members.has(event.memberId) && event.type !== "MEMBER_JOINED") throw new Error("Participant IDs must be unique.");
        if (event.type === "MEMBER_JOINED" && !members.has(event.memberId)) throw new Error("Only an invited participant can join this session.");
        if (!members.has(event.memberId) && members.size >= 100) throw new Error("A ledger can contain at most 100 participants.");
        members.set(event.memberId, { ...(members.get(event.memberId) ?? {}), id: event.memberId, name: event.name ?? members.get(event.memberId)?.name, role: event.role ?? members.get(event.memberId)?.role ?? "member", status: "active" });
        break;
      case "MEMBER_STATUS_CHANGED": {
        const member = members.get(event.memberId); if (!member) throw new Error("Participant status references an unknown participant.");
        members.set(event.memberId, { ...member, status: event.status }); break;
      }
      case "GROUP_CREATED":
        if (groups.has(event.groupId) || event.memberIds.some((id) => !members.has(id))) throw new Error("A subgroup needs a new ID and existing participants.");
        groups.set(event.groupId, { id: event.groupId, name: event.name, memberIds: [...event.memberIds] }); break;
      case "GROUP_MEMBERS_CHANGED": {
        const group = groups.get(event.groupId); if (!group || event.memberIds.some((id) => !members.has(id))) throw new Error("Subgroup membership references an unknown group or participant.");
        groups.set(event.groupId, { ...group, memberIds: [...event.memberIds] }); break;
      }
      case "EXPENSE_RECORDED": case "EXPENSE_UNASSIGNED": {
        const expense = normalizeExpense(event, baseCurrency); if (expenses.has(expense.id)) throw new Error("Expense IDs must be unique.");
        if (expense.status !== "unassigned" && (!members.has(expense.payerId) || expense.allocations.some((row) => !members.has(row.memberId)))) throw new Error("An expense must refer to participants already in this ledger.");
        if (expense.groupIds.some((groupId) => !groups.has(groupId))) throw new Error("An expense refers to an unknown subgroup.");
        if (expense.commitmentId && (!commitments.has(expense.commitmentId) || commitments.get(expense.commitmentId).status !== "open" || [...expenses.values()].some((prior) => prior.commitmentId === expense.commitmentId))) throw new Error("A commitment can be converted to one expense only while it is open.");
        expenses.set(expense.id, { ...expense, eventId: event.id }); break;
      }
      case "EXPENSE_CORRECTED": {
        const previous = eventById.get(event.supersedesEventId);
        const currentExpense = expenses.get(event.expenseId);
        if (!previous || !currentExpense || !["EXPENSE_RECORDED", "EXPENSE_UNASSIGNED", "EXPENSE_CORRECTED"].includes(previous.type) || previous.id !== currentExpense.sourceEventId) throw new Error("A correction must point to the current expense event.");
        superseded.add(currentExpense.sourceEventId);
        const replacement = normalizeExpense({ ...event.replacement, id: event.expenseId, at: event.at, type: "EXPENSE_RECORDED" }, baseCurrency);
        if (!members.has(replacement.payerId) || replacement.allocations.some((row) => !members.has(row.memberId)) || replacement.groupIds.some((groupId) => !groups.has(groupId))) throw new Error("A corrected expense must refer to existing participants and groups.");
        expenses.set(replacement.id, { ...replacement, eventId: event.id, correctionReason: event.reason }); break;
      }
      case "MEMBER_CONFIRMED_EXPENSE": {
        const expense = expenses.get(event.expenseId);
        if (!expense || !members.has(event.memberId)) throw new Error("Expense confirmation references an unknown record.");
        if (expense.status !== "unassigned" && expense.payerId !== event.memberId && !expense.allocations.some((row) => row.memberId === event.memberId)) throw new Error("Participants can only confirm expenses assigned to them.");
        confirmations.set(`${event.expenseId}:${event.memberId}`, event); break;
      }
      case "EXPENSE_DISCREPANCY_RECORDED": discrepancies.set(event.discrepancyId, { ...event }); break;
      case "EXPENSE_DISCREPANCY_RESOLVED": {
        const discrepancy = discrepancies.get(event.discrepancyId); if (!discrepancy) throw new Error("Discrepancy resolution references an unknown issue.");
        discrepancies.set(event.discrepancyId, { ...discrepancy, resolution: event.resolution, resolvedAt: event.at }); break;
      }
      case "COMMITMENT_RECORDED":
        if (commitments.has(event.commitmentId) || event.allocations.some((row) => !members.has(row.memberId))) throw new Error("Commitment IDs must be unique and allocations must refer to current participants.");
        commitments.set(event.commitmentId, { ...event, status: "open" }); break;
      case "COMMITMENT_UPDATED": {
        const item = commitments.get(event.commitmentId); if (!item) throw new Error("Commitment update references an unknown commitment.");
        if (item.status !== "open") throw new Error("Only an open commitment can change status.");
        if (event.status === "consumed" || event.status === "cancelled") {
          const linkedExpense = [...expenses.values()].find((expense) => expense.commitmentId === event.commitmentId && expense.status !== "unassigned");
          const unrefunded = item.amountMinor - (item.refundedMinor ?? 0);
          if (event.status === "consumed" && !linkedExpense) throw new Error("A consumed commitment must be represented by a linked expense event.");
          if (event.status === "cancelled" && unrefunded > 0 && (!linkedExpense || linkedExpense.baseAmountMinor !== unrefunded)) throw new Error("A non-refundable or partially refunded cancellation must be recorded as a linked expense for its remaining cost.");
        }
        commitments.set(event.commitmentId, { ...item, status: event.status, updateReason: event.reason }); break;
      }
      case "COMMITMENT_REFUND_RECORDED": {
        const item = commitments.get(event.commitmentId); if (!item) throw new Error("Refund references an unknown commitment.");
        if (item.refundability === "nonrefundable") throw new Error("A non-refundable commitment cannot record a refund.");
        if ((item.refundedMinor ?? 0) + event.amountMinor > item.amountMinor) throw new Error("Commitment refunds exceed the original committed amount.");
        commitments.set(event.commitmentId, { ...item, refundedMinor: (item.refundedMinor ?? 0) + event.amountMinor }); break;
      }
      case "SETTLEMENT_ASSERTED":
        if (settlements.has(event.settlementId) || !members.has(event.fromMemberId) || !members.has(event.toMemberId)) throw new Error("Payment IDs must be unique and reference current participants.");
        settlements.set(event.settlementId, { ...event, status: "pending" }); break;
      case "SETTLEMENT_CONFIRMED": {
        const item = settlements.get(event.settlementId); if (!item) throw new Error("Payment confirmation references an unknown payment.");
        settlements.set(event.settlementId, { ...item, status: "completed", confirmation: event }); break;
      }
      case "SETTLEMENT_STATUS_RECORDED": {
        const item = settlements.get(event.settlementId); if (!item) throw new Error("Payment status references an unknown payment.");
        if (item.status === "completed" || item.status === "refunded") throw new Error("A completed payment cannot be changed by a client status claim.");
        settlements.set(event.settlementId, { ...item, status: event.status, statusReason: event.reason }); break;
      }
      case "SETTLEMENT_REFUNDED": {
        const item = settlements.get(event.settlementId); if (!item || item.status !== "completed") throw new Error("Only a completed payment can be refunded.");
        const amount = (item.amountMinor ?? item.cents) - (item.refundedMinor ?? 0);
        if (event.amountMinor > amount) throw new Error("Refund exceeds the unrefunded captured payment.");
        const refundedMinor = (item.refundedMinor ?? 0) + event.amountMinor;
        settlements.set(event.settlementId, { ...item, refundedMinor, status: refundedMinor === (item.amountMinor ?? item.cents) ? "refunded" : "completed", refundReason: event.reason }); break;
      }
      case "SETTLEMENT_REVERSED": {
        const item = settlements.get(event.settlementId); if (!item) throw new Error("Payment reversal references an unknown payment.");
        if (item.status !== "completed" && item.status !== "refunded") throw new Error("Only a completed or refunded payment can be reversed.");
        settlements.set(event.settlementId, { ...item, status: "reversed", reversalReason: event.reason }); break;
      }
      case "SETTLEMENT_RECORDED": settlements.set(event.id, { id: event.id, fromMemberId: event.fromId, toMemberId: event.toId, amountMinor: event.cents, status: "completed", legacy: true }); break;
      case "OBLIGATION_FORGIVEN":
        if (!members.has(event.debtorId) || !members.has(event.creditorId)) throw new Error("Forgiveness references an unknown participant.");
        add(forgiven, keyOf(event.debtorId, event.creditorId), event.amountMinor); break;
      case "OBLIGATION_CARRIED":
        if (!members.has(event.debtorId) || !members.has(event.creditorId) || carried.some((item) => item.originSessionId === event.originSessionId && item.originObligationId === event.originObligationId)) throw new Error("Carried obligations must be unique and map to current participants.");
        carried.push(event); break;
      case "OBLIGATION_CARRIED_OUT":
        if (event.targetSessionId === session?.id || !members.has(event.debtorId) || !members.has(event.creditorId) || carriedOut.some((item) => item.transferId === event.transferId)) throw new Error("Carried-out obligations must be unique and map to this session's participants.");
        carriedOut.push(event); break;
      case "RESPONSIBILITY_ASSUMED":
        if (![event.fromMemberId, event.toMemberId, event.creditorMemberId].every((id) => members.has(id))) throw new Error("Responsibility transfer references an unknown participant.");
        assumed.push(event); break;
      case "BUDGET_SET": budgets.push({ ...event }); break;
      case "RECURRING_RULE_APPROVED":
        if (recurringRules.has(event.ruleId) || event.allocations.some((row) => !members.has(row.memberId))) throw new Error("Recurring rules need a new ID and existing participants.");
        recurringRules.set(event.ruleId, event); break;
      case "RECURRING_INSTANCE_RECORDED": {
        if (!recurringRules.has(event.ruleId)) throw new Error("Recurring instance references an unapproved rule.");
        const key = `${event.ruleId}:${event.periodKey}`; if (recurringPeriods.has(key)) throw new Error("A recurring rule can create only one instance per period.");
        recurringPeriods.add(key); break;
      }
      case "EVIDENCE_ATTACHED": evidence.set(event.evidenceId, event); break;
      case "SURPRISE_GIFT_RECORDED":
        if (gifts.has(event.giftId) || !members.has(event.recipientMemberId) || event.contributions.some((row) => !members.has(row.memberId))) throw new Error("Gift records must have a unique ID and known participants.");
        gifts.set(event.giftId, { ...event }); break;
      case "SESSION_CLOSED_PROVISIONAL": closure = { type: "provisional", at: event.at, reason: event.reason, blockers: closureBlockers({ expenses, confirmations, commitments, discrepancies, settlements }) }; break;
      case "SESSION_CLOSED_FINAL": {
        const blockers = closureBlockers({ expenses, confirmations, commitments, discrepancies, settlements });
        if (blockers.length) throw new Error(`Final closure blocked: ${blockers.map((item) => item.code).join(", ")}.`);
        closure = { type: "final", at: event.at, blockers: [] }; archived = true; break;
      }
      case "SESSION_REOPENED": closure = null; break;
      case "SESSION_ARCHIVED": archived = true; closure = { type: "legacy", at: event.at, provisional: event.provisional }; break;
      default: break;
    }
    stateChanges.push({ event, state: { members, expenses, settlements, forgiven, assumed } });
  }

  // Recompute direct balances from confirmed records; open claims and pending payments never move money.
  const balances = new Map([...members.keys()].map((id) => [id, 0]));
  const pairObligations = new Map();
  for (const expense of expenses.values()) {
    if (superseded.has(expense.sourceEventId) || expense.status === "unassigned") continue;
    if (!members.has(expense.payerId)) throw new Error("An expense refers to an unknown payer.");
    if (expense.allocations.some((row) => !members.has(row.memberId))) throw new Error("An expense refers to an unknown participant.");
    for (const row of expense.allocations) {
      if (row.memberId === expense.payerId) continue;
      add(pairObligations, keyOf(row.memberId, expense.payerId), row.baseMinor);
    }
  }
  for (const item of carried) add(pairObligations, keyOf(item.debtorId, item.creditorId), item.amountMinor);
  for (const item of carriedOut) add(pairObligations, keyOf(item.debtorId, item.creditorId), -item.amountMinor);
  for (const [key, amount] of forgiven) add(pairObligations, key, -amount);
  for (const event of assumed) {
    const oldKey = keyOf(event.fromMemberId, event.creditorMemberId);
    const old = pairObligations.get(oldKey) ?? 0;
    if (old < event.amountMinor) throw new Error("Assumed responsibility exceeds the outstanding obligation.");
    add(pairObligations, oldKey, -event.amountMinor);
    add(pairObligations, keyOf(event.toMemberId, event.creditorMemberId), event.amountMinor);
  }
  for (const payment of settlements.values()) {
    if (payment.status !== "completed" && payment.status !== "refunded") continue;
    const fromId = payment.fromMemberId ?? payment.fromId; const toId = payment.toMemberId ?? payment.toId;
    const amount = payment.amountMinor ?? payment.cents;
    if (!members.has(fromId) || !members.has(toId)) throw new Error("A payment refers to an unknown participant.");
    add(pairObligations, keyOf(fromId, toId), -(amount - (payment.refundedMinor ?? 0)));
  }
  const pendingClaims = new Map();
  for (const payment of settlements.values()) {
    if (payment.status !== "pending" && payment.status !== "asserted") continue;
    const fromId = payment.fromMemberId ?? payment.fromId; const toId = payment.toMemberId ?? payment.toId;
    if (!members.has(fromId) || !members.has(toId) || fromId === toId) throw new Error("A pending payment refers to an invalid participant pair.");
    add(pendingClaims, keyOf(fromId, toId), payment.amountMinor ?? payment.cents);
  }
  for (const [pair, claimed] of pendingClaims) {
    if (claimed > (pairObligations.get(pair) ?? 0)) throw new Error("Pending payment claims exceed the currently outstanding obligation.");
  }
  for (const [pair, amount] of pairObligations) {
    const [debtor, creditor] = pair.split("\0");
    if (amount < 0) throw new Error("A payment, forgiveness, or transfer exceeds the recorded obligation.");
    add(balances, debtor, -amount); add(balances, creditor, amount);
  }
  for (const value of balances.values()) if (!Number.isSafeInteger(value)) throw new Error("Ledger balance exceeds the supported range.");
  if (sumMinor([...balances.values()]) !== 0) throw new Error("Ledger value is not conserved.");
  if (closure?.type === "final" && [...balances.values()].some((balance) => balance !== 0)) throw new Error("Final closure blocked: outstanding_balances.");

  const outstanding = [...pairObligations].filter(([, amount]) => amount > 0).map(([pair, amount]) => {
    const [debtorId, creditorId] = pair.split("\0"); return { debtorId, creditorId, amountMinor: amount };
  }).sort((a, b) => a.debtorId.localeCompare(b.debtorId) || a.creditorId.localeCompare(b.creditorId));
  const blockers = closureBlockers({ expenses, confirmations, commitments, discrepancies, settlements, balances });
  return {
    events, eventById, session, members: [...members.values()], groups: [...groups.values()], expenses: [...expenses.values()].map((expense) => ({ ...expense, totalCents: expense.baseAmountMinor })),
    settlements: [...settlements.values()].map((payment) => ({ ...payment, fromId: payment.fromMemberId ?? payment.fromId, toId: payment.toMemberId ?? payment.toId, cents: payment.amountMinor ?? payment.cents })), commitments: [...commitments.values()], carriedObligations: carried, carriedOut, discrepancies: [...discrepancies.values()],
    confirmations: [...confirmations.values()], evidence: [...evidence.values()], gifts: [...gifts.values()], budgets,
    recurringRules: [...recurringRules.values()], recurringPeriods: [...recurringPeriods], rules, balances, outstanding,
    pendingClaims: [...pendingClaims].map(([pair, amountMinor]) => { const [fromMemberId, toMemberId] = pair.split("\0"); return { fromMemberId, toMemberId, amountMinor }; }),
    archived, closure, closureBlockers: blockers,
    totalExpensesMinor: sumMinor([...expenses.values()].filter((e) => !superseded.has(e.sourceEventId) && e.status !== "unassigned").map((e) => e.baseAmountMinor)),
    totalExpenses: sumMinor([...expenses.values()].filter((e) => !superseded.has(e.sourceEventId) && e.status !== "unassigned").map((e) => e.baseAmountMinor)),
    auditHead: events.length ? canonicalStringify(events.at(-1)) : null,
    stateChanges
  };
}

export function simulateLedger(events, proposedEvents, options) {
  if (!Array.isArray(proposedEvents) || proposedEvents.length > 100) throw new Error("A simulation may contain at most 100 proposed events.");
  const before = deriveLedger(events, options);
  const simulation = proposedEvents.map((entry) => ({ ...entry, id: entry.id ?? `simulation_${crypto.randomUUID()}`, at: entry.at ?? new Date().toISOString() }));
  const after = deriveLedger([...events, ...simulation], options);
  return { before: Object.fromEntries(before.balances), after: Object.fromEntries(after.balances), delta: Object.fromEntries([...after.balances.keys()].map((id) => [id, (after.balances.get(id) ?? 0) - (before.balances.get(id) ?? 0)])), proposedEvents: simulation };
}

export function findPossibleDuplicates(expenses, candidate) {
  const normalize = (s) => String(s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  return expenses.filter((expense) => expense.id !== candidate.id && expense.currency === candidate.currency && expense.amountMinor === candidate.amountMinor && Math.abs(Date.parse(expense.at) - Date.parse(candidate.at)) <= 36 * 60 * 60 * 1000 && normalize(expense.description) === normalize(candidate.description)).map((expense) => ({ expenseId: expense.id, reason: "same merchant, amount, currency, and date window", confidence: "possible" }));
}

export function settlementPlan(balances) {
  const debtors = [...balances].filter(([, n]) => n < 0).map(([id, n]) => ({ id, remaining: -n })).sort((a, b) => a.id.localeCompare(b.id));
  const creditors = [...balances].filter(([, n]) => n > 0).map(([id, n]) => ({ id, remaining: n })).sort((a, b) => a.id.localeCompare(b.id));
  const transfers = []; let d = 0; let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amountMinor = Math.min(debtors[d].remaining, creditors[c].remaining);
    transfers.push({ fromMemberId: debtors[d].id, toMemberId: creditors[c].id, amountMinor });
    debtors[d].remaining -= amountMinor; creditors[c].remaining -= amountMinor;
    if (!debtors[d].remaining) d++; if (!creditors[c].remaining) c++;
  }
  return transfers;
}

export function settleUp(balances) {
  return settlementPlan(balances).map(({ fromMemberId, toMemberId, amountMinor }) => ({ fromId: fromMemberId, toId: toMemberId, cents: amountMinor }));
}

export function validateDomainEvent(event, baseCurrency) { return validateEvent(event, baseCurrency); }
