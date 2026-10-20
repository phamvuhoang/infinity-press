import "server-only";

import type en from "@/lib/i18n/dictionaries/en.json";
import type { Locale } from "@/lib/i18n/config";

export type Dictionary = typeof en;

const dictionaries: Record<Locale, () => Promise<Dictionary>> = {
  vi: () => import("./dictionaries/vi.json").then((module) => module.default),
  en: () => import("./dictionaries/en.json").then((module) => module.default),
};

export async function getDictionary(locale: Locale) {
  return dictionaries[locale]();
}
