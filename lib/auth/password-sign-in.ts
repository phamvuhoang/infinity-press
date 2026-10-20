import { getSafeRedirect } from "@/lib/auth/redirect";
import { type Locale, withInternalLocale, withLocale } from "@/lib/i18n/config";

export function getPasswordSignInRoutes(locale: Locale, next: string | null | undefined) {
  const destination = getSafeRedirect(next, withLocale(locale, "/account"));

  return {
    destination,
    errorPath(error: string) {
      const searchParams = new URLSearchParams({ next: destination, error });
      return `${withInternalLocale(locale, "/sign-in")}?${searchParams}`;
    },
  };
}
