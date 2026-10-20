"use server";

import { redirect } from "next/navigation";

import { requireAdmin, resolveIsAdmin } from "@/lib/auth/admin";
import { getAuthCallbackUrl } from "@/lib/auth/callback";
import { getMagicLinkOutcome, getMagicLinkRoutes } from "@/lib/auth/magic-link";
import { getPasswordRecoveryOutcome } from "@/lib/auth/password-recovery";
import { getPasswordSignInRoutes } from "@/lib/auth/password-sign-in";
import { readCredentials, readEmail, readPasswordUpdate } from "@/lib/auth/validation";
import { getServerEnv } from "@/lib/config/server-env";
import { resolveLocale, withInternalLocale, withLocale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

function validationCode(error: string) {
  if (error === "Enter a valid email address.") return "email";
  if (error === "Passwords do not match.") return "password-match";
  return "password-length";
}

function readText(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

export async function requestMagicLink(formData: FormData) {
  const locale = resolveLocale(formData.get("locale"));
  const routes = getMagicLinkRoutes(locale, readText(formData, "next"));
  const email = readEmail(formData);
  if (!email.ok) redirect(routes.errorPath("email"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data.email,
    options: {
      emailRedirectTo: getAuthCallbackUrl(getServerEnv().siteUrl, locale, routes.destination),
      shouldCreateUser: true,
    },
  });
  if (getMagicLinkOutcome(error) === "failed") redirect(routes.errorPath("magic-link"));

  redirect(routes.messagePath("check-email"));
}

export async function signIn(formData: FormData) {
  const locale = resolveLocale(formData.get("locale"));
  const routes = getPasswordSignInRoutes(locale, readText(formData, "next"));
  const credentials = readCredentials(formData);
  if (!credentials.ok) {
    redirect(routes.errorPath(validationCode(credentials.error)));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials.data);
  if (error) redirect(routes.errorPath("credentials"));

  // Password access is an internal staff fallback, not a second customer
  // sign-in (spec 5.3). A role can only be read once the caller is
  // authenticated, so the check belongs here rather than on the form: a
  // passworded non-admin - one minted by auth.admin.createUser({ password })
  // or through the Supabase dashboard - is signed straight back out instead
  // of landing on /{locale}/account. Same predicate the DAL gates on,
  // public.is_admin(), through the same fail-closed normalization.
  // /internal/{locale}/forgot-password stays open by Ruling G: a locked-out
  // admin has no session to prove admin-ness with.
  const { data: isAdmin, error: isAdminError } = await supabase.rpc("is_admin");
  if (!resolveIsAdmin(isAdmin, isAdminError)) {
    await supabase.auth.signOut();
    redirect(routes.errorPath("staff-only"));
  }

  redirect(routes.destination);
}

export async function requestPasswordReset(formData: FormData) {
  const locale = resolveLocale(formData.get("locale"));
  const forgotPassword = withInternalLocale(locale, "/forgot-password");
  const email = readEmail(formData);
  if (!email.ok) redirect(`${forgotPassword}?error=email`);

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email.data.email, {
    redirectTo: getAuthCallbackUrl(
      getServerEnv().siteUrl,
      locale,
      withInternalLocale(locale, "/update-password"),
    ),
  });
  if (getPasswordRecoveryOutcome(error) === "failed") {
    redirect(`${forgotPassword}?error=recovery`);
  }

  redirect(`${forgotPassword}?message=check-email`);
}

export async function updatePassword(formData: FormData) {
  const locale = resolveLocale(formData.get("locale"));
  const updatePasswordPath = withInternalLocale(locale, "/update-password");
  // Password sign-in is an internal fallback, not the customer magic-link
  // flow: the page-level check does not extend to this action, so it must
  // re-verify admin access on its own.
  await requireAdmin({ locale, next: updatePasswordPath });
  const password = readPasswordUpdate(formData);
  if (!password.ok) {
    redirect(`${updatePasswordPath}?error=${validationCode(password.error)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser(password.data);
  if (error) redirect(`${updatePasswordPath}?error=update`);

  redirect(`${withLocale(locale, "/account")}?message=password-updated`);
}

export async function signOut(formData: FormData) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect(withLocale(resolveLocale(formData.get("locale")), "/"));
}
