import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";

import { type Locale, withInternalLocale, withLocale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

export type AccessRole = "reader" | "admin";
export type AccessProfile = { role: AccessRole };
export type AccessDecision = "allow" | "sign-in" | "forbidden";

// Pure decision: no user is always told to sign in, even when the required
// level is "admin". An authenticated user is only ever forbidden - never
// asked to sign in again - when their role doesn't meet the requirement.
// Only requireAdmin (lib/auth/admin.ts) switches on this; requireUser below
// needs no role check, so it doesn't call it.
export function decideAccess(profile: AccessProfile | null, required: AccessRole): AccessDecision {
  if (!profile) return "sign-in";
  if (required === "admin" && profile.role !== "admin") return "forbidden";
  return "allow";
}

// Memoized per render so repeated calls in the same request share one
// round-trip to Supabase instead of re-checking the session for every caller.
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

// Builds the sign-in redirect for a denied request, matching the optimistic
// Proxy's route-area convention (lib/auth/route-access.ts): a `next`
// destination under /internal/** goes back through the internal sign-in
// page, everything else through the public one.
export function buildSignInRedirect(locale: Locale, next?: string) {
  const signIn = next?.startsWith("/internal/")
    ? withInternalLocale(locale, "/sign-in")
    : withLocale(locale, "/sign-in");
  const query = next ? `?${new URLSearchParams({ next })}` : "";
  return `${signIn}${query}`;
}

// Hard gate for server components, actions, and route handlers that require
// any signed-in user. Redirects to sign-in (carrying `next` when given)
// rather than trusting a client-supplied session flag.
export const requireUser = cache(async (locale: Locale, next?: string) => {
  const user = await getSessionUser();
  if (!user) {
    redirect(buildSignInRedirect(locale, next));
  }
  return user;
});
