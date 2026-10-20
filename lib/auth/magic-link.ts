import { getSafeRedirect } from "@/lib/auth/redirect";
import { type Locale, withLocale } from "@/lib/i18n/config";

// These errors only occur for unknown addresses, so reporting them would
// reveal whether an account exists.
const undisclosedErrorCodes = new Set(["otp_disabled", "signup_disabled", "user_not_found"]);

export function getMagicLinkRoutes(locale: Locale, next: string | null | undefined) {
  const destination = getSafeRedirect(next, withLocale(locale, "/library"));
  const signIn = withLocale(locale, "/sign-in");

  return {
    destination,
    errorPath(error: string) {
      return `${signIn}?${new URLSearchParams({ next: destination, error })}`;
    },
    messagePath(message: string) {
      return `${signIn}?${new URLSearchParams({ next: destination, message })}`;
    },
  };
}

export function getMagicLinkOutcome(error: { code?: string } | null) {
  if (!error || (error.code && undisclosedErrorCodes.has(error.code))) return "sent";
  return "failed";
}
