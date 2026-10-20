import "server-only";
import { cache } from "react";
import { forbidden, redirect } from "next/navigation";

import { buildSignInRedirect, decideAccess, getSessionUser } from "@/lib/auth/session";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

// Pure fail-closed normalization of the `public.is_admin()` RPC response.
// Anything other than a strict `true` with no error - null, undefined, an
// unexpected shape, or a Postgres error - denies admin access.
export function resolveIsAdmin(data: unknown, error: unknown): boolean {
  if (error) return false;
  return data === true;
}

// The memoization lives here rather than on requireAdmin() below: React
// `cache` keys on argument identity, so `requireAdmin({ next: "/admin" })`
// built a fresh options object on every call and never hit the cache, and a
// dashboard render that gates twice issued two `is_admin` round-trips. This
// takes no arguments, so one request resolves the role once however many
// gates run.
const isSessionAdmin = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_admin");
  return resolveIsAdmin(data, error);
});

// The secure authorization boundary for admin-only server code. Resolves the
// caller's role by asking the database's `is_admin()` (security definer,
// evaluated via the authenticated session) rather than trusting any
// client-supplied role, so application logic and RLS agree on one predicate.
// Callers under a locale-prefixed route (e.g. the /internal/{locale}
// password fallback) should pass `locale`/`next` so a denied anonymous
// visitor lands back on the correct sign-in page; `/admin` itself has no
// locale segment, so the default is used when omitted.
export async function requireAdmin(options?: { locale?: Locale; next?: string }) {
  const locale = options?.locale ?? defaultLocale;

  const user = await getSessionUser();
  const isAdmin = await isSessionAdmin();

  const decision = decideAccess(user ? { role: isAdmin ? "admin" : "reader" } : null, "admin");
  if (decision === "sign-in") {
    redirect(buildSignInRedirect(locale, options?.next));
  }
  if (decision === "forbidden") {
    forbidden();
  }

  // decideAccess stays the only authorization decision: it returns "sign-in"
  // for a null profile, and the profile is null exactly when `user` is, so
  // reaching here without a user is impossible. This is an unreachable
  // invariant check rather than a second gate - it replaces a `user!`
  // assertion that would have handed callers `null` typed as `User` if the
  // decision above ever stopped covering a case.
  if (!user) {
    throw new Error("requireAdmin: decideAccess allowed a request with no user");
  }

  return user;
}
