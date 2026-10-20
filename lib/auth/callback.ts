import { getSafeRedirect } from "@/lib/auth/redirect";
import {
  getPathLocale,
  isLocale,
  type Locale,
  withInternalLocale,
  withLocale,
} from "@/lib/i18n/config";

const otpTypes = ["email", "recovery"] as const;
type OtpType = (typeof otpTypes)[number];

export type AuthCallbackCredential =
  | { type: "code"; code: string }
  | { type: "token_hash"; tokenHash: string; otpType: OtpType };

function isOtpType(value: string | null): value is OtpType {
  return otpTypes.some((type) => type === value);
}

export function getAuthCallbackUrl(siteUrl: string, locale: Locale, destination: string) {
  const callbackUrl = new URL("/auth/callback", siteUrl);
  callbackUrl.search = new URLSearchParams({ next: destination, locale }).toString();

  return callbackUrl.toString();
}

// Email templates start at the Site URL and carry the requested callback in redirect_to.
// Only its query is read, so a Supabase fallback to the bare Site URL loses the destination
// but still produces a working link.
function readRedirectToParams(searchParams: URLSearchParams) {
  const redirectTo = searchParams.get("redirect_to");
  if (!redirectTo) return new URLSearchParams();

  try {
    return new URL(redirectTo).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

export function readAuthCallback(searchParams: URLSearchParams) {
  const redirectParams = readRedirectToParams(searchParams);
  const next = searchParams.get("next") ?? redirectParams.get("next");
  const localeParam = searchParams.get("locale") ?? redirectParams.get("locale") ?? "";
  const locale = isLocale(localeParam) ? localeParam : getPathLocale(next ?? "/");
  const destination = getSafeRedirect(next, withLocale(locale, "/library"));
  const errorPath = destination.startsWith("/internal/")
    ? `${withInternalLocale(locale, "/forgot-password")}?error=callback`
    : `${withLocale(locale, "/sign-in")}?${new URLSearchParams({ next: destination, error: "callback" })}`;

  const tokenHash = searchParams.get("token_hash");
  const otpType = searchParams.get("type");
  const code = searchParams.get("code");
  let credential: AuthCallbackCredential | null = null;
  if (tokenHash && isOtpType(otpType)) {
    credential = { type: "token_hash", tokenHash, otpType };
  } else if (code) {
    credential = { type: "code", code };
  }

  return { credential, destination, errorPath };
}
