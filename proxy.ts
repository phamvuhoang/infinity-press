import { type NextRequest, NextResponse } from "next/server";

import { defaultLocale } from "@/lib/i18n/config";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { findPublicRedirect } from "@/lib/redirects/resolve";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  // Resolved once here so a redirect, its log line, and the session refresh share one request ID.
  const requestId = getRequestId(request.headers);
  request.headers.set(REQUEST_ID_HEADER, requestId);

  // Stored public redirects run before session refresh (S5 spec 7.6), and before the default `/`
  // redirect below, so an operator-stored redirect with source `/` still wins. A lookup failure
  // continues.
  const destination = await findPublicRedirect(request, requestId);
  if (destination) {
    const redirect = NextResponse.redirect(destination, 308);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    return redirect;
  }

  // `/` has no page of its own any more: the app has one root layout per top-level area, so there
  // is no layout for a bare `/` page to render under. The proxy already runs on this path.
  //
  // The query survives the hop, and an auth credential on `/` is handed to /auth/callback rather
  // than to the home page. Supabase falls back to the bare Site URL whenever the requested
  // emailRedirectTo is missing from its redirect allow-list, so every magic link then lands here
  // carrying `code` (PKCE) or `token_hash` instead of on /auth/callback. Dropping the search string
  // made that fallback silently unrecoverable: the link opened the home page, signed out, with
  // nothing in the response to say why. lib/auth/callback.ts reads the destination back out of
  // `redirect_to`, so the session still lands on the right page. A bogus credential is rejected by
  // the callback route exactly as it would be on its own URL.
  if (request.nextUrl.pathname === "/") {
    const carriesCredential =
      request.nextUrl.searchParams.has("code") || request.nextUrl.searchParams.has("token_hash");
    const target = new URL(carriesCredential ? "/auth/callback" : `/${defaultLocale}`, request.url);
    target.search = request.nextUrl.search;
    const redirect = NextResponse.redirect(target, 307);
    redirect.headers.set(REQUEST_ID_HEADER, requestId);
    return redirect;
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
