import type { Locale } from "@/lib/i18n/config";

// Fills "{name}" placeholders in dictionary copy.
export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

// Picks the singular or plural copy for `count` with the locale's plural rules, then fills
// "{count}". Vietnamese has no plural, so it always gets `other`.
export function fillCountTemplate(locale: Locale, count: number, forms: { one: string; other: string }): string {
  const template = new Intl.PluralRules(locale).select(count) === "one" ? forms.one : forms.other;
  return fillTemplate(template, { count });
}

const dateLocaleTags: Record<Locale, string> = { vi: "vi-VN", en: "en-US" };

// Order dates render on the server, so the time zone is fixed to the launch market rather than the
// server's own zone.
export function formatDate(iso: string, locale: Locale, options: { withTime?: boolean } = {}): string {
  return new Intl.DateTimeFormat(dateLocaleTags[locale], {
    dateStyle: "medium",
    ...(options.withTime ? { timeStyle: "short" as const } : {}),
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(iso));
}
