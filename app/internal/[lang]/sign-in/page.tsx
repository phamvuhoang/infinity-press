import { notFound } from "next/navigation";

import { signIn } from "@/app/auth/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthMessage } from "@/components/auth/auth-message";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getPasswordSignInRoutes } from "@/lib/auth/password-sign-in";
import { isLocale, withInternalLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export default async function PasswordSignInFallbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ error?: string; message?: string; next?: string }>;
}) {
  const [{ lang: locale }, { error, message, next }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();
  const dictionary = await getDictionary(locale);
  const copy = dictionary.authentication.passwordSignIn;
  const routes = getPasswordSignInRoutes(locale, next);

  return (
    <AuthCard
      description={copy.description}
      footer={{ href: withInternalLocale(locale, "/forgot-password"), label: copy.forgotLink, prompt: copy.forgotPrompt }}
      homeHref={withLocale(locale, "/")}
      title={copy.title}
    >
      <AuthMessage alerts={dictionary.authentication.alerts} error={error} message={message} />
      <form action={signIn} className="space-y-5">
        <input name="locale" type="hidden" value={locale} />
        <input name="next" type="hidden" value={routes.destination} />
        <div className="space-y-2">
          <Label htmlFor="email">{dictionary.authentication.email}</Label>
          <Input autoComplete="email" id="email" name="email" required type="email" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{dictionary.authentication.password}</Label>
          <Input autoComplete="current-password" id="password" minLength={8} name="password" required type="password" />
        </div>
        <SubmitButton pendingLabel={copy.pending}>{copy.submit}</SubmitButton>
      </form>
    </AuthCard>
  );
}
