// Narrative is a deterministic observer. It receives financial facts and returns text only.
const lines = {
  midnight: ["The account closed at the hour the clocks briefly agree."],
  return: ["The ledger has returned to an earlier balance. The pages remember the route."],
  zero: ["For one quiet moment, every name stands at zero."],
  palindrome: ["A mirrored amount has entered the record."],
  repeated: ["This pattern has appeared in an earlier journey."],
  circle: ["A chain of obligations has folded back upon itself."],
  budget: ["The agreed allowance has crossed a recorded threshold."]
};

const stable = (kind, source) => `${kind}:${source}`;
function isPalindrome(value) { const text = String(value); return text.length > 2 && text === [...text].reverse().join(""); }

export function deriveNarrativeEvents(ledger, { priorLedgers = [] } = {}) {
  const found = [];
  const emit = (kind, source, at, detail = {}) => found.push({ id: stable(kind, source), kind, at, text: lines[kind][0], ...detail });
  for (const expense of ledger.expenses ?? []) {
    const numeric = String(expense.baseAmountMinor ?? expense.amountMinor ?? "");
    if (isPalindrome(numeric)) emit("palindrome", expense.id, expense.at, { expenseId: expense.id });
  }
  for (const event of ledger.events ?? []) {
    if (event.type === "SESSION_CLOSED_FINAL" && new Date(event.at).getHours() === 0 && new Date(event.at).getMinutes() === 0) emit("midnight", event.id, event.at);
  }
  if (ledger.members?.length && [...ledger.balances.values()].every((balance) => balance === 0)) {
    emit("zero", ledger.events?.at(-1)?.id ?? "empty", ledger.events?.at(-1)?.at ?? new Date(0).toISOString());
  }
  const financialEvents = (ledger.events ?? []).filter((event) => ["EXPENSE_RECORDED", "SETTLEMENT_RECORDED", "SETTLEMENT_CONFIRMED", "OBLIGATION_FORGIVEN", "RESPONSIBILITY_ASSUMED"].includes(event.type));
  if (financialEvents.length > 1 && ledger.members?.length && [...ledger.balances.values()].every((balance) => balance === 0)) {
    emit("return", financialEvents.at(-1).id, financialEvents.at(-1).at);
  }
  const pattern = narrativePattern(ledger);
  if (pattern && priorLedgers.some((prior) => prior.pattern === pattern)) emit("repeated", ledger.session?.id ?? "session", ledger.events?.at(-1)?.at ?? new Date(0).toISOString());
  for (const budget of ledger.budgets ?? []) {
    const spent = (ledger.expenses ?? []).filter((expense) => expense.currency === budget.currency).reduce((sum, expense) => sum + (expense.baseAmountMinor ?? 0), 0);
    if (spent >= budget.amountMinor) emit("budget", budget.id, budget.at, { spentMinor: spent, budgetMinor: budget.amountMinor });
  }
  return found;
}

export function narrativePattern(ledger) {
  return (ledger.expenses ?? []).map((expense) => {
    const payer = ledger.members?.find((member) => member.id === expense.payerId)?.name ?? "unknown";
    return `${payer.normalize("NFKD").toLowerCase()}:${expense.baseAmountMinor}`;
  }).sort().join("|");
}

export function narrativeLibrary() { return Object.fromEntries(Object.entries(lines).map(([key, values]) => [key, [...values]])); }
