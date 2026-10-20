import { type Locale, locales } from "@/lib/i18n/config";

// The translation-completeness view in the admin lists: which UI locales an entity still lacks.
export function missingLocales(present: readonly string[]): Locale[] {
  return locales.filter((locale) => !present.includes(locale));
}
