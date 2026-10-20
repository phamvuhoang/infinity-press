// Money crosses the app as integer minor units. The exponent comes from the currency (VND and JPY
// have none, USD has two); nothing here multiplies or divides by 100, and decimal text is parsed
// as digits, never through a binary float.

// Provider and database amounts stay exact as JS numbers only up to 2^53 - 1. Past that the value
// would be rounded silently, so it is refused instead.
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export function currencyExponent(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`currencyExponent: ${JSON.stringify(currency)} is not an ISO 4217 code`);
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 0;
}

// "19.99" in USD is 1999. Null when the text is not a plain non-negative decimal, has more fraction
// digits than the currency allows, or exceeds MAX_MINOR.
export function minorFromMajorText(text: string, currency: string): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const fraction = match[2] ?? "";
  if (fraction.length > exponent) return null;
  const minor = BigInt(match[1] + fraction.padEnd(exponent, "0"));
  return minor > BigInt(MAX_MINOR) ? null : Number(minor);
}

export function minorToMajorText(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new Error("minorToMajorText: not a safe non-negative integer");
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(minor);
  const digits = String(minor).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}

// A bigint column reaches the app as a number or a decimal string. Either is accepted when it is a
// whole, non-negative, safe amount; anything else throws rather than being coerced.
export function minorFromTransport(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("minorFromTransport: not a safe whole amount");
    return value;
  }
  if (!/^\d+$/.test(value)) throw new Error("minorFromTransport: not a decimal integer");
  const minor = BigInt(value);
  if (minor > BigInt(MAX_MINOR)) throw new Error("minorFromTransport: amount exceeds the safe range");
  return Number(minor);
}
