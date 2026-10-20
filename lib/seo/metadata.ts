import type { Metadata } from "next";

import { BRAND_NAME } from "@/lib/config/brand";
import { defaultLocale, type Locale, locales } from "@/lib/i18n/config";

// Public page metadata (S5 spec 7.1 and 7.2). Builders take public DTO values and the validated
// SITE_URL origin; they never query the database.

export const SITE_NAME = BRAND_NAME;

// app/opengraph-image.tsx serves this. A page that sets `openGraph` replaces the root segment's
// Open Graph object, file-based image included, so every page names its image explicitly.
export const DEFAULT_OG_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: SITE_NAME } as const;

const openGraphLocales: Record<Locale, string> = { vi: "vi_VN", en: "en_US" };

// The page path for each locale that has this page. The current locale is always present.
export type LocalePaths = Partial<Record<Locale, string>>;

export type IndexRule = "index" | "noindex-follow" | "noindex-nofollow";

// Canonical and alternate URLs identify a page, never a view of it, so a filter, sort, search,
// action error, or return path in `path` is dropped rather than published.
export function absoluteUrl(siteUrl: string, path: string): string {
  const url = new URL(path, new URL(siteUrl).origin);
  return `${url.origin}${url.pathname}`;
}

// A fixed page has both locales. An entity page has the other locale only when it is localized.
export function localePaths(locale: Locale, path: string, otherPath: string | null): LocalePaths {
  if (!otherPath) return { [locale]: path };
  const other = locales.find((candidate) => candidate !== locale);
  return other ? { [locale]: path, [other]: otherPath } : { [locale]: path };
}

export function buildPageMetadata({
  siteUrl,
  locale,
  paths,
  title,
  description,
  image,
  index = "index",
}: {
  siteUrl: string;
  locale: Locale;
  paths: LocalePaths;
  title?: string;
  description?: string;
  image?: { url: string; alt: string } | null;
  index?: IndexRule;
}): Metadata {
  const currentPath = paths[locale];
  if (!currentPath) throw new Error(`buildPageMetadata needs a ${locale} path`);
  const canonical = absoluteUrl(siteUrl, currentPath);

  const languages: Record<string, string> = {};
  for (const candidate of locales) {
    const path = paths[candidate];
    if (path) languages[candidate] = absoluteUrl(siteUrl, path);
  }
  // x-default is what Google serves a searcher whose language matches no alternate. `/` redirects to
  // the default locale, so that page answers for everyone else; an entity localized in the other
  // locale only names the one page it has.
  languages["x-default"] = absoluteUrl(siteUrl, paths[defaultLocale] ?? currentPath);
  const alternateLocale = locales
    .filter((candidate) => candidate !== locale && paths[candidate])
    .map((candidate) => openGraphLocales[candidate]);

  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    alternates: { canonical, languages },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: openGraphLocales[locale],
      ...(alternateLocale.length > 0 ? { alternateLocale } : {}),
      url: canonical,
      images: [image ? { url: image.url, alt: image.alt } : { ...DEFAULT_OG_IMAGE, url: absoluteUrl(siteUrl, DEFAULT_OG_IMAGE.url) }],
    },
    ...(index === "noindex-follow" ? { robots: { index: false, follow: true } } : {}),
    ...(index === "noindex-nofollow" ? { robots: { index: false, follow: false } } : {}),
  };
}
