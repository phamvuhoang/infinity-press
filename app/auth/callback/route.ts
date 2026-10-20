import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { readAuthCallback } from "@/lib/auth/callback";
import { createClient } from "@/lib/supabase/server";

// NextRequest rewrites loopback hosts to localhost, so an absolute redirect built from
// request.url can move the browser away from the host that received the session cookie.
function redirectTo(path: string) {
  return new NextResponse(null, { status: 307, headers: { location: path } });
}

export async function GET(request: NextRequest) {
  const { credential, destination, errorPath } = readAuthCallback(
    request.nextUrl.searchParams,
  );

  if (credential) {
    const supabase = await createClient();
    const { error } =
      credential.type === "code"
        ? await supabase.auth.exchangeCodeForSession(credential.code)
        : await supabase.auth.verifyOtp({
            type: credential.otpType,
            token_hash: credential.tokenHash,
          });

    if (!error) return redirectTo(destination);
  }

  return redirectTo(errorPath);
}
