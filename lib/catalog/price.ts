import { currencyExponent } from "@/lib/commerce/money";
import { type Locale, localeRegistry } from "@/lib/i18n/config";

// offers.price_minor is in the currency's minor unit. VND has none, so 129000 is 129000 ₫ and
// USD 1299 is 12.99.
export function priceInMajorUnits(priceMinor: number, currency: string): number {
  return priceMinor / 10 ** currencyExponent(currency);
}

// The last UTC day a sale price applies (S19), as YYYY-MM-DD. The end is exclusive, so a sale
// ending at 00:00 last applies the day before.
export function saleLastDay(saleEndsAt: string): string {
  return new Date(Date.parse(saleEndsAt) - 1).toISOString().slice(0, 10);
}

// offers.price_minor is in the currency's minor unit. VND has none, so 129000 is 129.000 ₫.
export function formatPrice(priceMinor: number, currency: string, locale: Locale): string {
  const formatter = new Intl.NumberFormat(localeRegistry[locale].intlTag, { style: "currency", currency });
  return formatter.format(priceInMajorUnits(priceMinor, currency));
}
