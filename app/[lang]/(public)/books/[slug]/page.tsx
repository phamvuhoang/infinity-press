import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsEvent } from "@/components/analytics/analytics-event";
import { ActionErrorBanner } from "@/components/catalog/action-error-banner";
import { BookReviews } from "@/components/catalog/book-reviews";
import { CoverImage } from "@/components/catalog/cover-image";
import { PriceLabel } from "@/components/catalog/price-label";
import { RetailLinkButton } from "@/components/catalog/retail-link-button";
import { ViewerBookAction } from "@/components/catalog/viewer-book-action";
import { KnowledgeLinkList } from "@/components/knowledge/knowledge-link-list";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import { formatPrice } from "@/lib/catalog/price";
import { retailerLabel, withRetailUtm } from "@/lib/catalog/retail";
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookAcceptsQuestions, getBookPage, publicBookAction } from "@/lib/data/catalog";
import { getKnowledgeForBook } from "@/lib/data/knowledge";
import { getBookReviews } from "@/lib/data/reviews";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getLocaleRoutes, otherLocale } from "@/lib/i18n/routes";
import { bookSchema, breadcrumbSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, localePaths, SITE_NAME } from "@/lib/seo/metadata";

import { buyEbookAction, getFreeEbookAction } from "./actions";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
};

const sectionTitle = "mb-4 font-serif text-2xl font-normal";
const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink";

// Prerendered per published book. revalidateStorefront() invalidates this on publish - confirmed by
// e2e/seo-operations.spec.ts ("publishing a new book makes its detail page answer 200 ... and reach
// the sitemap"), which publishes a draft book through the real admin path and re-fetches the raw
// page: 404 before, 200 after, within seconds, no redeploy. Otherwise this is stale-while-revalidate
// on request: once 5 minutes pass, the next request still gets the stale page while a fresh one
// builds in the background, and the request after that gets it. A slug not listed here is still
// served: it renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { lang: string } }) {
  if (!isLocale(params.lang)) return [];
  const { books } = await catalogStaticParams(params.lang);
  return books.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const book = await getBookPage(locale, slug);
  if (!book) return {};
  const other = otherLocale(locale);
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: localePaths(
      locale,
      getCatalogRoutes(locale).book(book.slug),
      book.alternateSlug ? getCatalogRoutes(other).book(book.alternateSlug) : null,
    ),
    title: book.seoTitle ?? book.title,
    description: book.seoDescription ?? book.shortDescription ?? undefined,
    image: book.cover,
  });
}

export default async function BookPage({ params }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const book = await getBookPage(locale, slug);
  if (!book) notFound();

  // Backlinks and reviews load only after getBookPage passed its public/missing-locale gate, keyed
  // by the id it resolved, so a draft or unlocalized book never reaches the knowledge or review DALs.
  const [dictionary, knowledgeLinks, reviews, acceptsQuestions] = await Promise.all([
    getDictionary(locale),
    getKnowledgeForBook(locale, book.bookId),
    getBookReviews(book.bookId, 5),
    getBookAcceptsQuestions(book.bookId),
  ]);
  const publicAction = publicBookAction(book);
  const copy = dictionary.catalog;
  const routes = getCatalogRoutes(locale);
  const other = otherLocale(locale);
  const env = getServerEnv();
  const bookPath = routes.book(book.slug);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={book.alternateSlug ? { [other]: getCatalogRoutes(other).book(book.alternateSlug) } : undefined}
        current="books"
        locale={locale}
      />
      <JsonLd
        data={[
          bookSchema({
            siteUrl: env.siteUrl,
            locale,
            path: bookPath,
            book,
            paymentsEnabled: arePaymentsEnabled(env),
            reviews,
            anonymousReviewer: copy.reviews.anonymousReader,
          }),
          breadcrumbSchema(env.siteUrl, [
            { name: SITE_NAME, path: getLocaleRoutes(locale).home },
            { name: dictionary.navigation.books, path: getLocaleRoutes(locale).books },
            { name: book.title, path: bookPath },
          ]),
        ]}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20" id="main-content">
        {/* Rendered only once the public book was found; it reports the view from the browser. */}
        <AnalyticsEvent bookId={book.bookId} eventName="view_book" locale={locale} />
        <article className="grid gap-12 lg:grid-cols-[22rem_1fr] lg:gap-20">
          <div className="mx-auto w-full max-w-[16rem] lg:max-w-none">
            <CoverImage card={book} preload size="lg" sizes="(min-width: 1024px) 22rem, 16rem" />
          </div>

          <div className="max-w-[40rem]">
            <h1 className="font-serif text-4xl leading-[1.08] font-normal tracking-[-0.01em] sm:text-5xl">{book.title}</h1>
            {book.subtitle ? <p className="mt-3 font-serif text-xl text-ink-soft">{book.subtitle}</p> : null}
            <p className="mt-4 text-[0.9375rem] text-ink-soft">
              {copy.book.by}{" "}
              {book.author.slug ? (
                <Link className={textLink} href={routes.entity("author", book.author.slug)}>
                  {book.author.name}
                </Link>
              ) : (
                book.author.name
              )}
            </p>

            <div className="mt-8 flex flex-wrap items-start gap-x-6 gap-y-4 border-y border-hairline py-6">
              <div className="min-h-11 space-y-1">
                <PriceLabel className="block text-2xl font-medium text-ink" copy={copy.book} locale={locale} offer={book.offer} />
                <span className="block text-xs text-sage-text">{copy.book.format}</span>
              </div>
              <ViewerBookAction
                bookId={book.bookId}
                bookPath={bookPath}
                buyAction={buyEbookAction.bind(null, locale, book.bookId, book.slug)}
                copy={copy.actions}
                getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug)}
                locale={locale}
                publicAction={publicAction}
              />
            </div>

            <Suspense fallback={null}>
              <ActionErrorBanner messages={copy.actionErrors} />
            </Suspense>

            {book.retailLinks.length > 0 ? (
              <section aria-labelledby="book-retail" className="mt-6">
                <h2 className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase" id="book-retail">
                  {copy.retail.title}
                </h2>
                <p className="mt-1 text-[0.9375rem] text-ink-soft">{copy.retail.intro}</p>
                <ul className="mt-3 flex flex-wrap gap-3">
                  {book.retailLinks.map((link) => (
                    <li className="space-y-1" key={link.id}>
                      <RetailLinkButton
                        bookId={book.bookId}
                        href={withRetailUtm(link.url, locale)}
                        label={retailerLabel(link, copy.retail.labels)}
                        locale={locale}
                        retailer={link.retailer}
                      />
                      {link.priceMinor !== null && link.currency !== null ? (
                        <span className="block text-xs text-sage-text">
                          {fillTemplate(copy.retail.listPrice, { price: formatPrice(link.priceMinor, link.currency, locale) })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {book.hasSample ? (
              <p className="mt-4">
                <Link className={textLink} href={routes.sample(book.slug)}>
                  {copy.book.sample}
                </Link>
              </p>
            ) : null}

            {book.shortDescription ? <p className="mt-10 font-serif text-xl leading-normal">{book.shortDescription}</p> : null}
            {book.description ? (
              <p className="mt-6 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{book.description}</p>
            ) : null}

            {book.audience ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.audience}</h2>
                <p className="text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{book.audience}</p>
              </section>
            ) : null}

            {book.keyIdeas.length > 0 ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.keyIdeas}</h2>
                <ol className="space-y-5">
                  {book.keyIdeas.map((idea, index) => (
                    <li className="grid grid-cols-[2rem_1fr] gap-2" key={`${index}-${idea.title}`}>
                      <span className="text-xs font-medium text-sage-text">{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <p className="font-medium">{idea.title}</p>
                        {idea.summary ? <p className="mt-1 text-[0.9375rem] leading-relaxed text-ink-soft">{idea.summary}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            {book.series || book.topics.length > 0 ? (
              <section className="mt-12 space-y-4">
                {book.series ? (
                  <p>
                    <Link className={textLink} href={routes.entity("series", book.series.slug)}>
                      {fillTemplate(copy.book.seriesPosition, { position: book.series.position, series: book.series.name })}
                    </Link>
                  </p>
                ) : null}
                {book.topics.length > 0 ? (
                  <div>
                    <h2 className={sectionTitle}>{copy.book.topics}</h2>
                    <ul className="flex flex-wrap gap-x-5">
                      {book.topics.map((topic) => (
                        <li key={topic.slug}>
                          <Link className={textLink} href={routes.entity("topic", topic.slug)}>
                            {topic.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            {book.faq.length > 0 ? (
              <section className="mt-12">
                <h2 className={sectionTitle}>{copy.book.faq}</h2>
                <div className="divide-y divide-hairline border-y border-hairline">
                  {book.faq.map((item, index) => (
                    <details className="group" key={`${index}-${item.question}`}>
                      <summary className="flex min-h-11 cursor-pointer items-center py-3 font-medium">{item.question}</summary>
                      <p className="pb-4 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{item.answer}</p>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}

            {knowledgeLinks.length > 0 ? (
              <section aria-labelledby="book-knowledge" className="mt-12">
                <h2 className={sectionTitle} id="book-knowledge">
                  {copy.book.knowledgeTitle}
                </h2>
                <KnowledgeLinkList
                  items={knowledgeLinks}
                  kindLabels={{ idea: dictionary.knowledge.idea.eyebrow, article: dictionary.knowledge.article.eyebrow }}
                  locale={locale}
                />
              </section>
            ) : null}

            <section aria-labelledby="book-reviews" className="mt-12">
              <h2 className={sectionTitle} id="book-reviews">
                {copy.reviews.title}
              </h2>
              <BookReviews
                askHref={acceptsQuestions ? routes.ask({ book: book.bookId }) : null}
                copy={copy.reviews}
                locale={locale}
                reviewHref={routes.review(book.bookId)}
                reviews={reviews}
                summary={book.reviewSummary}
              />
            </section>
          </div>
        </article>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
