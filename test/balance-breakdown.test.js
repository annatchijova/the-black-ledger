import assert from "node:assert/strict";
import test from "node:test";
import { deriveLedger } from "../src/domain.js";

let sequence = 0;
const event = (type, fields = {}) => ({ id: `event${++sequence}`, at: "2026-10-30T12:00:00.000Z", type, ...fields });
const seed = () => [event("SESSION_CREATED", { sessionId: "session", name: "Trip", baseCurrency: "USD" }), ...["alice", "bob", "carol"].map((memberId) => event("MEMBER_ADDED", { memberId, name: memberId }))];
const expense = (amount = 1000) => event("EXPENSE_RECORDED", { expenseId: "dinner", description: "Dinner", payerId: "alice", currency: "USD", amountMinor: amount, baseAmountMinor: amount, allocations: [{ memberId: "bob", cents: amount }] });
const check = (events) => {
  const ledger = deriveLedger(events);
  for (const [memberId, rows] of ledger.balanceBreakdowns) {
    assert.equal(rows.reduce((sum, row) => sum + row.deltaMinor, 0), ledger.balances.get(memberId));
    for (const row of rows) {
      assert.ok(row.eventIds.length > 0);
      for (const id of row.eventIds) assert.ok(ledger.eventById.has(id), `missing evidence ${id}`);
      assert.ok(!("description" in row), "explanations must not copy private gift text");
    }
  }
  return ledger;
};

test("expense contributions reconcile exactly and pending claims have no effect", () => {
  const events = [...seed(), expense()];
  const before = check(events);
  assert.equal(before.balances.get("alice"), 1000); assert.equal(before.balances.get("bob"), -1000);
  events.push(event("SETTLEMENT_ASSERTED", { settlementId: "payment", fromMemberId: "bob", toMemberId: "alice", amountMinor: 400, rail: "other" }));
  const pending = check(events);
  assert.deepEqual(pending.balanceBreakdowns, before.balanceBreakdowns);
});

test("confirmed payments and partial/full refunds remain separate traceable contributions", () => {
  const asserted = event("SETTLEMENT_ASSERTED", { settlementId: "payment", fromMemberId: "bob", toMemberId: "alice", amountMinor: 400, rail: "other" });
  const confirmation = event("SETTLEMENT_CONFIRMED", { settlementId: "payment", confirmedByMemberId: "alice", confirmationSource: "organizer_record" });
  const events = [...seed(), expense(), asserted, confirmation];
  assert.equal(check(events).balances.get("bob"), -600);
  events.push(event("SETTLEMENT_REFUNDED", { settlementId: "payment", amountMinor: 100, reason: "Partial return" }));
  const partial = check(events); assert.equal(partial.balances.get("bob"), -700);
  assert.deepEqual(partial.balanceBreakdowns.get("bob").map((row) => row.deltaMinor), [-1000, 400, -100]);
  events.push(event("SETTLEMENT_REFUNDED", { settlementId: "payment", amountMinor: 300, reason: "Remaining return" }));
  assert.equal(check(events).balances.get("bob"), -1000);
  events.push(event("SETTLEMENT_REVERSED", { settlementId: "payment", reason: "Reverse record" }));
  assert.deepEqual(check(events).balanceBreakdowns.get("bob").map((row) => row.kind), ["expense"]);
});

test("repeated corrections retain a stable expense ID and reference the latest correction", () => {
  const original = expense(); const events = [...seed(), original];
  let previous = original;
  for (const amount of [800, 650]) {
    const replacement = { description: "Corrected dinner", payerId: "alice", currency: "USD", amountMinor: amount, baseAmountMinor: amount, allocations: [{ memberId: "bob", cents: amount }] };
    const correction = event("EXPENSE_CORRECTED", { expenseId: "dinner", supersedesEventId: previous.id, reason: "Receipt reviewed", replacement });
    events.push(correction); previous = correction;
    const ledger = check(events);
    assert.equal(ledger.balances.get("bob"), -amount);
    assert.equal(ledger.totalExpensesMinor, amount);
    assert.deepEqual(ledger.balanceBreakdowns.get("bob")[0].eventIds, [correction.id]);
  }
});

test("forgiveness, responsibility transfer and cross-session debt have distinct sources", () => {
  const events = [...seed(), expense(),
    event("OBLIGATION_FORGIVEN", { debtorId: "bob", creditorId: "alice", amountMinor: 100, reason: "Gift" }),
    event("RESPONSIBILITY_ASSUMED", { fromMemberId: "bob", toMemberId: "carol", creditorMemberId: "alice", amountMinor: 300, reason: "I cover this" }),
    event("OBLIGATION_CARRIED", { originSessionId: "older", originObligationId: "old", sourceDebtorId: "bob", sourceCreditorId: "alice", debtorId: "bob", creditorId: "alice", amountMinor: 200 }),
    event("OBLIGATION_CARRIED_OUT", { targetSessionId: "next", transferId: "transfer", debtorId: "bob", creditorId: "alice", amountMinor: 100 })];
  const ledger = check(events);
  assert.equal(ledger.balances.get("bob"), -700); assert.equal(ledger.balances.get("carol"), -300);
  assert.deepEqual(ledger.balanceBreakdowns.get("bob").map((row) => row.kind), ["expense", "carried_in", "carried_out", "forgiveness", "responsibility_released"]);
});

test("unassigned and self-funded expenses do not create fictional contributions", () => {
  const events = [...seed(), event("EXPENSE_UNASSIGNED", { description: "Unassigned", currency: "USD", amountMinor: 500, allocations: [] }),
    event("EXPENSE_RECORDED", { description: "Own item", payerId: "alice", currency: "USD", amountMinor: 100, allocations: [{ memberId: "alice", cents: 100 }] })];
  for (const rows of check(events).balanceBreakdowns.values()) assert.equal(rows.length, 0);
});

test("conversion fees paid by a different participant preserve exact rounded shares", () => {
  const events = [...seed(), event("EXPENSE_RECORDED", { description: "Foreign booking", payerId: "alice", currency: "EUR", amountMinor: 1000, baseAmountMinor: 1101,
    fx: { sourceCurrency: "EUR", targetCurrency: "USD", numerator: "11", denominator: "10", source: "Recorded rate", observedAt: "2026-10-30T12:00:00.000Z", feeMinor: 1, feePayerMemberId: "carol" },
    allocations: [{ memberId: "bob", cents: 550 }, { memberId: "carol", cents: 551 }] })];
  const ledger = check(events);
  assert.equal(ledger.balances.get("alice"), 1100);
  assert.equal(ledger.balances.get("bob"), -550);
  assert.equal(ledger.balances.get("carol"), -550);
});
