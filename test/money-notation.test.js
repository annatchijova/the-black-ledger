import assert from "node:assert/strict";
import test from "node:test";
import { parseAmountToMinor, formatMoney } from "../src/domain/money.js";

// The ledger offers ARS, so it has to accept the way an amount is written where
// ARS is spent: comma decimals and dot grouping.
test("amounts are accepted in both comma-decimal and dot-decimal notation", () => {
  for (const [text, minor] of [["15,99", 1599], ["1.500,00", 150000], ["1,50", 150], ["0,5", 50], ["1.234.567,89", 123456789], ["1 500,25", 150025]]) {
    assert.equal(parseAmountToMinor(text, "ARS"), minor, `es-AR notation ${text}`);
  }
  for (const [text, minor] of [["15.99", 1599], ["1,500.00", 150000], ["1500", 150000], ["0.5", 50], ["1,234,567.89", 123456789]]) {
    assert.equal(parseAmountToMinor(text, "USD"), minor, `en-US notation ${text}`);
  }
  // Non-breaking and thin spaces are grouping noise, not part of the number.
  assert.equal(parseAmountToMinor("1 500,25", "ARS"), 150025);
  assert.equal(parseAmountToMinor("1 500.25", "USD"), 150025);
});

test("an amount that could mean two things is refused, never guessed", () => {
  // "1.500" is fifteen hundred under dot grouping and one-and-a-half as a
  // decimal. Choosing either silently would put a wrong number in the ledger.
  for (const text of ["1.500", "1,500", "25.750"]) {
    assert.throws(() => parseAmountToMinor(text, "ARS"), (error) => /ambiguous/.test(error.message), text);
  }
  // The message has to name both readings so the person can pick one.
  assert.throws(() => parseAmountToMinor("1.500", "ARS"), (error) => error.message.includes("1500") && error.message.includes("1.50"));
});

test("currency precision settles the ambiguity where it can", () => {
  assert.equal(parseAmountToMinor("1.500", "CLP"), 1500, "a currency with no decimals can only be grouping");
  assert.equal(parseAmountToMinor("1,500", "JPY"), 1500);
  assert.equal(parseAmountToMinor("1.500", "KWD"), 1500, "three decimals makes three trailing digits a decimal");
  assert.throws(() => parseAmountToMinor("15,99", "CLP"), (error) => /0 decimal places/.test(error.message));
});

test("malformed amounts stay rejected", () => {
  for (const text of ["$1500", "1e3", "abc", "", "1500,", "1500.", ",50", ".50", "1.23.456", "1,2,3", "-5", "1..5"]) {
    assert.throws(() => parseAmountToMinor(text, "USD"), Error, `must reject ${JSON.stringify(text)}`);
  }
  assert.throws(() => parseAmountToMinor("99999999999999", "USD"), (error) => /supported range|digits/.test(error.message));
});

test("display uses the viewer's separators without mixing them", () => {
  // The server default must stay byte-stable: other code and tests read it.
  assert.equal(formatMoney(150000, "USD"), "USD 1,500.00");
  assert.equal(formatMoney(1599, "ARS"), "ARS 15.99");
  assert.equal(formatMoney(1500, "CLP"), "CLP 1,500");
  // Under a dot-grouping locale the decimal separator must follow suit.
  assert.equal(formatMoney(150000, "ARS", "es-AR"), "ARS 1.500,00");
  assert.equal(formatMoney(123456789, "ARS", "es-AR"), "ARS 1.234.567,89");
  assert.equal(formatMoney(-150000, "ARS", "es-AR"), "−ARS 1.500,00");
  // The defect this replaces rendered "ARS 1.500.00": locale grouping with a
  // hardcoded decimal dot. Under a dot-grouping locale the decimal separator
  // must be the comma, and it must appear exactly once.
  const shown = formatMoney(150000, "ARS", "es-AR");
  assert.equal((shown.match(/,/g) ?? []).length, 1, `one decimal separator in ${shown}`);
  assert.equal(shown.lastIndexOf(","), Math.max(shown.lastIndexOf(","), shown.lastIndexOf(".")), `the decimal separator must come last in ${shown}`);
  assert.equal(formatMoney(100, "ARS", "es-AR"), "ARS 1,00");
});

test("parsing and display round-trip through every supported precision", () => {
  for (const [currency, text] of [["USD", "1234.56"], ["ARS", "1234,56"], ["CLP", "1234"], ["KWD", "1,234"]]) {
    const minor = parseAmountToMinor(text, currency);
    const shown = formatMoney(minor, currency, "es-AR");
    assert.equal(parseAmountToMinor(shown.replace(/^[−]?[A-Z]{3}\s/, ""), currency), minor, `${currency} ${text} -> ${shown}`);
  }
});
