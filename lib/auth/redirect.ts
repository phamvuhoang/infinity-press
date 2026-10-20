import { locales } from "@/lib/i18n/config";

const origin = "https://infinity-books.invalid";
const localePattern = locales.join("|");
const allowedPaths = [
  new RegExp(`^/(${localePattern})(/|$)`),
  /^\/admin(\/|$)/,
  new RegExp(`^/internal/(${localePattern})/`),
];

export function getSafeRedirect(value: string | null | undefined, fallback: string) {
  if (!value?.startsWith("/")) return fallback;

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return fallback;
  }

  if (url.origin !== origin || !allowedPaths.some((path) => path.test(url.pathname))) {
    return fallback;
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
