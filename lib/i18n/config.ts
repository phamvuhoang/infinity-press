// The one registry of customer UI locales (spec section 5). `Locale` and everything that used to
// branch on "vi" or "en" derives from it. The dictionary loader for each locale lives in
// lib/i18n/dictionary.ts (server-only), typed over Locale so adding a code here fails the build
// until a dictionary exists. A matching row in supported_locales (migration) is checked by
// supabase/tests/press_locales.sql and lib/i18n/registry-db.test.ts.
export const locales = ["vi", "en", "ja"] as const;
export type Locale = (typeof locales)[number];

export const localeRegistry: Record<Locale, { englishName: string; nativeName: string; intlTag: string; openGraph: string; dir: "ltr" | "rtl" }> = {
  vi: { englishName: "Vietnamese", nativeName: "Tiếng Việt", intlTag: "vi-VN", openGraph: "vi_VN", dir: "ltr" },
  en: { englishName: "English", nativeName: "English", intlTag: "en-US", openGraph: "en_US", dir: "ltr" },
  ja: { englishName: "Japanese", nativeName: "日本語", intlTag: "ja-JP", openGraph: "ja_JP", dir: "ltr" },
};

export const defaultLocale: Locale = "en";
export const localeHeader = "x-infinity-locale";

export function isLocale(value: string): value is Locale {
  return Object.hasOwn(localeRegistry, value);
}

export function resolveLocale(value: unknown): Locale {
  return typeof value === "string" && isLocale(value) ? value : defaultLocale;
}

export function withLocale(locale: Locale, path: `/${string}`) {
  return `/${locale}${path === "/" ? "" : path}`;
}

export function withInternalLocale(locale: Locale, path: `/${string}`) {
  return `/internal/${locale}${path}`;
}

export function getPathLocale(pathname: string): Locale {
  const [, first, second] = pathname.split("/");
  return resolveLocale(first === "internal" ? second : first);
}

// The language a page renders in, which is not always the language its route
// belongs to. /admin is an internal English-only tool - its pages are written
// in English rather than the dictionaries - so everything that renders from
// the locale header (the 403 copy in app/admin/forbidden.tsx and
// app/internal/[lang]/forbidden.tsx) has to say `en` there too when the
// route is under /admin. Otherwise a denied admin reads Vietnamese on the
// same route an admitted admin reads in English. Route decisions keep using
// getPathLocale, so an anonymous /admin visitor still lands on the
// default-locale sign-in page.
export function getInterfaceLocale(pathname: string): Locale {
  const [, first] = pathname.split("/");
  return first === "admin" ? "en" : getPathLocale(pathname);
}
