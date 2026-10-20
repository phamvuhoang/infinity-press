import { getSafeRedirect } from "@/lib/auth/redirect";
import { getPathLocale, isLocale, withInternalLocale, withLocale } from "@/lib/i18n/config";

type RouteArea = "public" | "guest" | "member";

const readerPages = new Set(["account", "ask", "checkout", "library", "read"]);
const internalGuestPages = new Set(["sign-in", "forgot-password"]);

function getRouteArea(pathname: string): RouteArea {
  const [, first, second, third] = pathname.split("/");

  if (first === "admin") return "member";
  if (isLocale(first)) {
    if (second === "sign-in") return "guest";
    return readerPages.has(second) ? "member" : "public";
  }
  if (first === "internal" && isLocale(second)) {
    if (internalGuestPages.has(third)) return "guest";
    return third === "update-password" ? "member" : "public";
  }
  return "public";
}

// Optimistic Proxy decision only. Pages, actions, and RLS repeat authorization.
export function decideRouteAccess({
  pathname,
  search,
  signedIn,
}: {
  pathname: string;
  search: string;
  signedIn: boolean;
}): string | null {
  const locale = getPathLocale(pathname);
  const area = getRouteArea(pathname);

  if (area === "member" && !signedIn) {
    const signIn = pathname.startsWith("/internal/")
      ? withInternalLocale(locale, "/sign-in")
      : withLocale(locale, "/sign-in");
    return `${signIn}?${new URLSearchParams({ next: `${pathname}${search}` })}`;
  }

  if (area === "guest" && signedIn) {
    const account = withLocale(locale, "/account");
    const next = getSafeRedirect(new URLSearchParams(search).get("next"), account);
    const nextPathname = next.split(/[?#]/)[0];
    return getRouteArea(nextPathname) === "guest" ? account : next;
  }

  return null;
}
