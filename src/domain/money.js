const EXPONENTS = Object.freeze({
  USD: 2, EUR: 2, ARS: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, CHF: 2, CNY: 2, BRL: 2, MXN: 2,
  CLP: 0, COP: 0, UYU: 2, PEN: 2, JPY: 0, KRW: 0, INR: 2, SGD: 2, HKD: 2, TWD: 2, THB: 2,
  IDR: 2, TRY: 2, ZAR: 2, AED: 2, SAR: 2, KWD: 3, BHD: 3, OMR: 3, SEK: 2, NOK: 2, DKK: 2,
  PLN: 2, CZK: 2, HUF: 2, RON: 2, BGN: 2, ILS: 2, PHP: 2, MYR: 2, VND: 0, PKR: 2, BDT: 2,
  EGP: 2, NGN: 2, KES: 2, MAD: 2, ISK: 0
});
const MAX_MINOR = 1_000_000_000_000;

export function currencyExponent(currency) {
  if (typeof currency !== "string" || !(currency.toUpperCase() in EXPONENTS)) {
    throw new Error(`Unsupported currency: ${String(currency)}.`);
  }
  return EXPONENTS[currency.toUpperCase()];
}

export function parseAmountToMinor(value, currency = "USD") {
  const exponent = currencyExponent(currency);
  const text = String(value ?? "").trim();
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Enter a non-negative amount using digits and a decimal point.");
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) throw new Error(`This currency supports at most ${exponent} decimal places.`);
  const scale = 10 ** exponent;
  const minor = Number(match[1]) * scale + Number((fraction + "0".repeat(exponent)).slice(0, exponent) || "0");
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) throw new Error("Amount is outside the supported range.");
  return minor;
}

export function parseAmountToCents(value) {
  const cents = parseAmountToMinor(value, "USD");
  if (cents === 0) throw new Error("Enter an amount greater than zero.");
  return cents;
}

export function formatMoney(minor, currency = "USD", locale = "en-US") {
  if (!Number.isSafeInteger(minor)) throw new Error("Invalid minor-unit amount.");
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? "−" : "";
  const absolute = Math.abs(minor);
  const divisor = 10 ** exponent;
  const major = Math.floor(absolute / divisor).toLocaleString(locale);
  const fraction = exponent ? `.${String(absolute % divisor).padStart(exponent, "0")}` : "";
  return `${sign}${currency.toUpperCase()} ${major}${fraction}`;
}

export function roundHalfEven(numerator, denominator) {
  if (denominator <= 0n) throw new Error("Rounding denominator must be positive.");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const twice = remainder * 2n;
  const rounded = twice > denominator || (twice === denominator && quotient % 2n === 1n)
    ? quotient + 1n
    : quotient;
  const result = negative ? -rounded : rounded;
  const safe = Number(result);
  if (!Number.isSafeInteger(safe) || Math.abs(safe) > MAX_MINOR) throw new Error("Converted amount is outside the supported range.");
  return safe;
}

// The rate means target major units per source major unit.
export function convertMinorUnits(amountMinor, sourceCurrency, targetCurrency, numerator, denominator) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || amountMinor > MAX_MINOR) throw new Error("Invalid source amount.");
  const sourceExponent = currencyExponent(sourceCurrency);
  const targetExponent = currencyExponent(targetCurrency);
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (n <= 0n || d <= 0n) throw new Error("Exchange rate must be a positive rational number.");
  return roundHalfEven(BigInt(amountMinor) * n * (10n ** BigInt(targetExponent)), d * (10n ** BigInt(sourceExponent)));
}

export function divideMinorUnits(totalMinor, memberIds) {
  if (!Number.isSafeInteger(totalMinor) || totalMinor < 0 || totalMinor > MAX_MINOR) throw new Error("Invalid total amount.");
  if (!Array.isArray(memberIds) || memberIds.length < 1 || memberIds.length > 100) throw new Error("Select between 1 and 100 participants.");
  const unique = new Set(memberIds);
  if (unique.size !== memberIds.length || memberIds.some((id) => typeof id !== "string" || !id)) throw new Error("Participants must be unique valid IDs.");
  const quotient = Math.floor(totalMinor / memberIds.length);
  let remainder = totalMinor - quotient * memberIds.length;
  return memberIds.map((memberId) => ({ memberId, minor: quotient + (remainder-- > 0 ? 1 : 0) }));
}

export function divideCents(totalCents, memberIds) {
  return divideMinorUnits(totalCents, memberIds).map(({ memberId, minor }) => ({ memberId, cents: minor }));
}

export function sumMinor(values) {
  let sum = 0n;
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error("All monetary inputs must be safe integer minor units.");
    sum += BigInt(value);
  }
  const result = Number(sum);
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_MINOR) throw new Error("Monetary total is outside the supported range.");
  return result;
}
