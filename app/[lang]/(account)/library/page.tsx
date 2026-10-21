import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AnalyticsEvent } from "@/components/analytics/analytics-event";
import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { LibraryCover } from "@/components/account/library-cover";
import { RecommendationShelf } from "@/components/catalog/recommendation-shelf";
import { ProgressLine } from "@/components/brand/progress-line";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { getLibrary } from "@/lib/data/library";
import { getShelfRecommendations } from "@/lib/data/recommendations";
import { listMySharedQuotes } from "@/lib/data/shared-quotes";
import { isLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

export default async function LibraryPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();

  await requireUser(locale, withLocale(locale, "/library"));
  const [dictionary, items, sharedQuotes] = await Promise.all([
    getDictionary(locale),
    getLibrary(locale),
    // The link is a convenience: a failed read (already logged) hides it rather than the shelf.
    listMySharedQuotes().catch(() => []),
  ]);
  const copy = dictionary.library;

  // The reader's complete owned set is both the seed and the exclude list, so a reader is never
  // recommended a book they already hold.
  const ownedBookIds = [...new Set(items.map((item) => item.bookId))];
  // This page is already request-scoped (requireUser reads cookies), so reading headers() here
  // costs nothing and lets a failed shelf read be correlated with the request that saw it.
  const recommendations = await getShelfRecommendations({
    seedBookIds: ownedBookIds,
    excludeBookIds: ownedBookIds,
    locale,
    limit: 6,
    requestId: getRequestId(await headers()),
  });

  // Board 1q leads with the book the reader is in the middle of. The DTO carries no last-read
  // timestamp, so "in the middle of" means the first book in progress, falling back to the first
  // book on the shelf.
  const featured = items.find((item) => item.state === "reading") ?? items[0];

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="library" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "library")} label={dictionary.navigation.library} />
        <main className="min-w-0" id="main-content">
          {/* Reached only after requireUser() and the library query; the route derives the profile
              from the session, so the event carries nothing about the reader. */}
          <AnalyticsEvent eventName="view_library" locale={locale} />
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">
            {copy.title}
          </h1>
          <p className={`${sharedQuotes.length > 0 ? "mb-3" : "mb-10"} text-[0.9375rem] text-ink-soft`}>{copy.description}</p>
          {sharedQuotes.length > 0 ? (
            <p className="mb-10">
              <Link className="inline-flex min-h-11 items-center underline decoration-sand underline-offset-4" href={getLocaleRoutes(locale).myQuotes}>
                {copy.quotes.link}
              </Link>
            </p>
          ) : null}

          {featured ? (
            <>
              <section
                aria-labelledby="featured-title"
                className="mb-12 grid gap-8 border-b border-sand pb-12 sm:grid-cols-[11rem_1fr] sm:items-center lg:grid-cols-[13.75rem_1fr] lg:gap-12"
              >
                <div className="w-36 sm:w-full">
                  <LibraryCover item={featured} preload sizes="(min-width: 1024px) 13.75rem, (min-width: 640px) 11rem, 9rem" size="lg" />
                </div>
                <div className="max-w-[35rem]">
                  <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.lastRead}</p>
                  <h2 className="mb-5 font-serif text-[1.875rem] leading-tight font-normal" id="featured-title">
                    {featured.title}
                    <span className="ml-3 inline-block rounded-sm border border-sand px-1.5 align-middle font-sans text-[0.75rem] font-medium tracking-[0.06em] text-sage-text uppercase" lang={featured.languageCode}>
                      {featured.languageCode}
                    </span>
                  </h2>
                  <div className="mb-1.5 flex justify-between text-[0.8125rem]">
                    <span>{copy.states[featured.state]}</span>
                    <span className="text-sage-text">
                      {featured.progressPercent}% {copy.progressLabel}
                    </span>
                  </div>
                  <ProgressLine className="mb-6" percent={featured.progressPercent} />
                  <Button render={<Link href={featured.continueReadingUrl} />} size="lg">
                    {copy.continueReading}
                  </Button>
                </div>
              </section>

              <section aria-labelledby="shelf-title">
                <div className="mb-8 border-b border-sand">
                  <h2 className="-mb-px inline-block border-b-2 border-ink py-2.5 text-sm font-medium" id="shelf-title">
                    {copy.shelfTitle} · {items.length}
                  </h2>
                </div>
                {/* The shelf: covers aligned to their base on a single Ink rule (board 1d). */}
                <ul className="grid grid-cols-2 items-end gap-x-6 gap-y-10 border-b border-ink pb-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 xl:gap-8">
                  {items.map((item) => (
                    <li key={item.editionId}>
                      <LibraryCover item={item} sizes="(min-width: 1280px) 12rem, (min-width: 640px) 15vw, 40vw" size="sm" />
                      <ProgressLine className="mt-3" percent={item.state === "completed" ? 100 : item.progressPercent} />
                      <p className="mt-2 font-serif text-[0.9375rem] leading-snug">
                        {item.title}
                        <span className="ml-2 inline-block rounded-sm border border-sand px-1.5 align-middle font-sans text-[0.6875rem] font-medium tracking-[0.06em] text-sage-text uppercase" lang={item.languageCode} title={new Intl.DisplayNames([locale], { type: "language" }).of(item.languageCode) ?? item.languageCode}>
                          {item.languageCode}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[0.8125rem] text-sage-text">
                        {copy.states[item.state]} · {item.progressPercent}% {copy.progressLabel}
                      </p>
                      <Link
                        className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-forest hover:text-ink"
                        href={item.continueReadingUrl}
                      >
                        {copy.continueReading}
                        <span aria-hidden="true" className="ml-1.5">→</span>
                      </Link>
                      {/* The review page is catalog-gated: an unpublished book would link to a 404. */}
                      {item.inCatalog ? (
                        <Link
                          className="mt-1 block min-h-11 text-sm text-sage-text hover:text-ink"
                          href={getCatalogRoutes(locale).review(item.bookId)}
                        >
                          {copy.review}
                        </Link>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          ) : (
            <section className="mx-auto mt-6 max-w-[35rem] border border-dashed border-sand px-6 py-14 text-center sm:px-14">
              <h2 className="mb-2.5 font-serif text-[1.625rem] font-normal">{copy.emptyStateTitle}</h2>
              <p className="text-[0.9375rem] leading-relaxed text-ink-soft">{copy.emptyStateDescription}</p>
            </section>
          )}

          <RecommendationShelf
            books={recommendations}
            copy={dictionary.catalog.book}
            heading={copy.recommendationsTitle}
            headingId="library-recommendations"
            locale={locale}
          />
        </main>
      </div>
    </div>
  );
}
