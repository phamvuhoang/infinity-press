import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JourneySessionList } from "@/components/journeys/journey-session-list";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getServerEnv } from "@/lib/config/server-env";
import { getPublishedJourney } from "@/lib/data/journeys";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { buildPageMetadata, fixedPaths } from "@/lib/seo/metadata";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
};

// Dynamic: no static params, so every request reads the published journey. The admin journey
// actions still call revalidateJourneyAdmin(), for the journey cards on the prerendered book page.

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const journey = await getPublishedJourney(locale, slug);
  if (!journey) return {};
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    // One slug for every locale; the copy falls back per locale like the rest of the catalog.
    paths: fixedPaths((l) => getCatalogRoutes(l).journey(journey.slug)),
    title: journey.title,
    description: journey.summary || undefined,
  });
}

// Cookie-less, like the rest of the storefront: the list shows no progress here. Each session is an
// account route, so "start" sends a signed-out reader through sign-in and back.
export default async function JourneyPage({ params }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const journey = await getPublishedJourney(locale, slug);
  if (!journey) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.journeys;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="books" locale={locale} />
      <main className="mx-auto max-w-[45rem] px-4 py-12 sm:px-8 lg:py-20" id="main-content">
        <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
        <h1 className="font-serif text-4xl leading-[1.1] font-normal tracking-[-0.01em] sm:text-5xl">{journey.title}</h1>
        <p className="mt-3 text-[0.9375rem] text-ink-soft">
          <Link className="text-forest underline decoration-sand underline-offset-4 hover:text-ink" href={getCatalogRoutes(locale).book(journey.bookSlug)}>
            {journey.bookTitle}
          </Link>
        </p>
        {journey.summary ? <p className="mt-6 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{journey.summary}</p> : null}
        <div className="mt-10">
          <JourneySessionList completedPositions={[]} copy={copy} locale={locale} sessions={journey.sessions} slug={journey.slug} />
        </div>
        {journey.sessions.length > 0 ? <p className="mt-4 text-[0.8125rem] text-sage-text">{copy.signInToTrack}</p> : null}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
