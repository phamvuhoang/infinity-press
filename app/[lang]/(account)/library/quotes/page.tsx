import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SharedQuoteList } from "@/components/account/shared-quote-list";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { listMySharedQuotes } from "@/lib/data/shared-quotes";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getLocaleRoutes } from "@/lib/i18n/routes";

import { removeSharedQuoteAction } from "./actions";

export default async function SharedQuotesPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, getLocaleRoutes(locale).myQuotes);
  const [dictionary, items] = await Promise.all([getDictionary(locale), listMySharedQuotes()]);
  const copy = dictionary.library.quotes;
  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "library")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[40rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
          <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
          <SharedQuoteList
            copy={copy}
            items={items}
            locale={locale}
            removeAction={removeSharedQuoteAction.bind(null, locale)}
            siteUrl={getServerEnv().siteUrl}
          />
        </main>
      </div>
    </div>
  );
}
