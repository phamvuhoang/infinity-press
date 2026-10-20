import { z } from "zod";

import { isLocale, type Locale } from "@/lib/i18n/config";

// A localized page names its sibling pages as { locale: slug } (RPC `alternateSlugs`). A code the
// database knows but this build does not is dropped rather than failing the whole page.
export const alternateSlugsSchema = z
  .record(z.string(), z.string())
  .transform((slugs): Partial<Record<Locale, string>> =>
    Object.fromEntries(Object.entries(slugs).filter(([locale]) => isLocale(locale))),
  );

export type AlternateSlugs = z.output<typeof alternateSlugsSchema>;

// The other locales' URLs for one page, each built from that locale's own slug.
export function alternatePaths(
  slugs: AlternateSlugs,
  routeFor: (locale: Locale, slug: string) => string,
): Partial<Record<Locale, string>> {
  return Object.fromEntries(
    (Object.entries(slugs) as [Locale, string][]).map(([locale, slug]) => [locale, routeFor(locale, slug)]),
  );
}
