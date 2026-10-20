import { notFound } from "next/navigation";

import { requestMagicLink } from "@/app/auth/actions";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthMessage } from "@/components/auth/auth-message";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getMagicLinkRoutes } from "@/lib/auth/magic-link";
import { isLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export default async function SignInPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ error?: string; message?: string; next?: string }>;
}) {
  const [{ lang: locale }, { error, message, next }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();
  const dictionary = await getDictionary(locale);
  const copy = dictionary.authentication.magicLink;
  const routes = getMagicLinkRoutes(locale, next);

  return (
    <AuthCard description={copy.description} homeHref={withLocale(locale, "/")} title={copy.title}>
      <AuthMessage alerts={dictionary.authentication.alerts} error={error} message={message} />
      <form action={requestMagicLink} className="space-y-5">
        <input name="locale" type="hidden" value={locale} />
        <input name="next" type="hidden" value={routes.destination} />
        <div className="space-y-2">
          <Label htmlFor="email">{dictionary.authentication.email}</Label>
          <Input autoComplete="email" id="email" name="email" required type="email" />
        </div>
        <SubmitButton pendingLabel={copy.pending}>{copy.submit}</SubmitButton>
      </form>
    </AuthCard>
  );
}
