export const locales = ["vi", "en"] as const;
export const defaultLocale = "vi" as const;
export const localeHeader = "x-infinity-locale";
export type Locale = (typeof locales)[number];

export function isLocale(value: string): value is Locale {
  return locales.some((locale) => locale === value);
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
