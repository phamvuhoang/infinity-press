import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

import { decideRouteAccess } from "@/lib/auth/route-access";
import { getInterfaceLocale, localeHeader } from "@/lib/i18n/config";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { getSupabaseEnv } from "@/lib/supabase/env";

export async function updateSession(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  request.headers.set(localeHeader, getInterfaceLocale(pathname));
  const requestId = getRequestId(request.headers);
  request.headers.set(REQUEST_ID_HEADER, requestId);

  let response = NextResponse.next({ request });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  const { url, publishableKey } = getSupabaseEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });

  const supabase = createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        response.headers.set(REQUEST_ID_HEADER, requestId);
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const redirectTo = decideRouteAccess({ pathname, search, signedIn: Boolean(user) });
  if (!redirectTo) return response;

  const redirect = NextResponse.redirect(new URL(redirectTo, request.url));
  redirect.headers.set(REQUEST_ID_HEADER, requestId);
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}
