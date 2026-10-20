import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { AuthMessage } from "@/components/auth/auth-message";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getCurrentProfile } from "@/lib/data/profiles";
import { isLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ message?: string }>;
}) {
  const [{ lang: locale }, { message }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  // The same gate the library and reader pages use, so the sign-in redirect
  // convention lives in one place (lib/auth/session.ts) instead of being
  // rebuilt here.
  const user = await requireUser(locale, withLocale(locale, "/account"));
  const [profile, dictionary] = await Promise.all([getCurrentProfile(), getDictionary(locale)]);
  const copy = dictionary.account;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="account" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "account")} label={dictionary.navigation.library} />
        <main className="max-w-[42.5rem] space-y-10" id="main-content">
          <div>
            <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
            <h1 className="mb-4 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">
              {copy.title}
            </h1>
            <p className="font-serif text-lg leading-normal text-ink-soft">{copy.description}</p>
          </div>
          <AuthMessage alerts={dictionary.authentication.alerts} message={message} />
          <section aria-labelledby="account-details-title">
            <h2 className="mb-2 font-serif text-[1.75rem] font-normal" id="account-details-title">
              {copy.detailsTitle}
            </h2>
            <p className="mb-5 text-sm text-sage-text">{copy.detailsDescription}</p>
            <div className="border-y border-sand py-4">
              {/* A profile with no display_name yet - every account starts
                  that way - falls back to the email, which stays visible
                  either way because it is the identity the sign-in used. */}
              <p className="min-w-0 font-medium break-all">{profile?.display_name ?? user.email}</p>
              {profile?.display_name ? (
                <p className="mt-1 min-w-0 text-sm break-all text-sage-text">{user.email}</p>
              ) : null}
            </div>
          </section>
          <SignOutButton label={dictionary.navigation.signOut} locale={locale} />
        </main>
      </div>
    </div>
  );
}
