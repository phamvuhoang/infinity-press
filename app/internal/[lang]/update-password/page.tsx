import { notFound } from "next/navigation";

import { updatePassword } from "@/app/auth/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthMessage } from "@/components/auth/auth-message";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { isLocale, withInternalLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export default async function UpdatePasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ lang: locale }, { error }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  // Password sign-in is an internal fallback, not the customer magic-link
  // flow, so this page stays admin-only. Redirects to the internal sign-in
  // page (carrying `next`) when signed out, or renders the built-in 403
  // (see next.config.ts authInterrupts) for a signed-in non-admin.
  const [, dictionary] = await Promise.all([
    requireAdmin({ locale, next: withInternalLocale(locale, "/update-password") }),
    getDictionary(locale),
  ]);
  const copy = dictionary.authentication.updatePassword;

  return (
    <AuthCard
      description={copy.description}
      footer={{ href: withInternalLocale(locale, "/forgot-password"), label: copy.restartLink, prompt: copy.restartPrompt }}
      homeHref={withLocale(locale, "/")}
      title={copy.title}
    >
      <AuthMessage alerts={dictionary.authentication.alerts} error={error} />
      <form action={updatePassword} className="space-y-5">
        <input name="locale" type="hidden" value={locale} />
        <div className="space-y-2">
          <Label htmlFor="password">{copy.newPassword}</Label>
          <Input autoComplete="new-password" id="password" minLength={8} name="password" required type="password" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{copy.confirmPassword}</Label>
          <Input autoComplete="new-password" id="confirmPassword" minLength={8} name="confirmPassword" required type="password" />
        </div>
        <SubmitButton pendingLabel={copy.pending}>{copy.submit}</SubmitButton>
      </form>
    </AuthCard>
  );
}
