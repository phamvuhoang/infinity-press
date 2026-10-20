import { notFound } from "next/navigation";

import { requestPasswordReset } from "@/app/auth/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthMessage } from "@/components/auth/auth-message";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isLocale, withInternalLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export default async function ForgotPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const [{ lang: locale }, { error, message }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();
  const dictionary = await getDictionary(locale);
  const copy = dictionary.authentication.forgotPassword;

  return (
    <AuthCard
      description={copy.description}
      footer={{ href: withInternalLocale(locale, "/sign-in"), label: copy.backToSignIn, prompt: copy.rememberPrompt }}
      homeHref={withLocale(locale, "/")}
      title={copy.title}
    >
      <AuthMessage alerts={dictionary.authentication.alerts} error={error} message={message} />
      <form action={requestPasswordReset} className="space-y-5">
        <input name="locale" type="hidden" value={locale} />
        <div className="space-y-2">
          <Label htmlFor="email">{dictionary.authentication.email}</Label>
          <Input autoComplete="email" id="email" name="email" required type="email" />
        </div>
        <SubmitButton pendingLabel={copy.pending}>{copy.submit}</SubmitButton>
      </form>
    </AuthCard>
  );
}
