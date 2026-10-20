import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buyEbookAction, getFreeEbookAction } from "@/app/[lang]/(public)/books/[slug]/actions";
import { AnalyticsEvent } from "@/components/analytics/analytics-event";
import { CoverImage } from "@/components/catalog/cover-image";
import { ViewerBookAction } from "@/components/catalog/viewer-book-action";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCardById, publicBookAction } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { splitGraphemes } from "@/lib/reader/quote";
import { absoluteUrl, SITE_NAME } from "@/lib/seo/metadata";

// S16 quote card. Dynamic: a removed card must 404 at once, and the card is one reader's choice,
// not catalog content, so it is never prerendered, never in the sitemap, and noindex. `follow` is
// kept so the link to the book page carries weight; the canonical points there too.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ lang: string; code: string }> };

const TITLE_GRAPHEMES = 60;
const textLink = "underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink";

async function load(code: string) {
  const card = await getSharedQuote(code);
  if (!card) return null;
  // The card's own locale, not the path's: the quote is in that language and so is the book copy.
  const book = await getBookCardById(card.locale, card.bookId);
  return book ? { card, book } : null;
}

function titleFor(quote: string, bookTitle: string): string {
  const units = splitGraphemes(quote);
  const cut = units.length > TITLE_GRAPHEMES ? `${units.slice(0, TITLE_GRAPHEMES).join("")}…` : quote;
  return `“${cut}” - ${bookTitle}`;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, code } = await params;
  if (!isLocale(lang)) return {};
  const loaded = await load(code);
  if (!loaded) return {};
  const { card, book } = loaded;
  const { siteUrl } = getServerEnv();
  const routes = getCatalogRoutes(card.locale);
  const title = titleFor(card.quote, book.title);
  const description = `${book.title}, ${book.author.name}`;
  return {
    title,
    description,
    robots: { index: false, follow: true },
    alternates: { canonical: absoluteUrl(siteUrl, routes.book(book.slug)) },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title,
      description,
      url: absoluteUrl(siteUrl, routes.quoteCard(card.code)),
      // No `images`: the sibling opengraph-image.tsx is injected by the file convention, which wins
      // over this object. Next serves it at a hashed path (`opengraph-image-<hash>`), so a hand-built
      // `/opengraph-image` URL here would 404.
    },
  };
}

export default async function QuoteCardPage({ params }: Props) {
  const { lang, code } = await params;
  if (!isLocale(lang)) notFound();
  const loaded = await load(code);
  if (!loaded) notFound();
  const { card, book } = loaded;
  const locale = card.locale;
  const dictionary = await getDictionary(locale);
  const copy = dictionary.catalog;
  const routes = getCatalogRoutes(locale);
  const bookPath = routes.book(book.slug);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="books" locale={locale} />
      <main className="mx-auto max-w-[48rem] px-4 py-12 sm:px-8 lg:py-20" id="main-content">
        <AnalyticsEvent bookId={book.bookId} eventName="view_quote" locale={locale} sharedQuoteId={card.id} />
        <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.quoteCard.eyebrow}</p>
        <blockquote className="mt-6 font-serif text-3xl leading-[1.3] sm:text-4xl" lang={locale}>
          {`“${card.quote}”`}
        </blockquote>
        <div className="mt-10 grid gap-8 border-t border-hairline pt-8 sm:grid-cols-[8rem_1fr] sm:items-start">
          <div className="w-32">
            <CoverImage card={book} size="md" sizes="8rem" />
          </div>
          <div>
            <p className="font-serif text-xl">
              <Link className={textLink} href={bookPath}>
                {book.title}
              </Link>
            </p>
            <p className="mt-1 text-[0.9375rem] text-ink-soft">
              {book.author.slug ? (
                <Link className={textLink} href={routes.entity("author", book.author.slug)}>
                  {book.author.name}
                </Link>
              ) : (
                book.author.name
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <ViewerBookAction
                bookId={book.bookId}
                bookPath={bookPath}
                buyAction={buyEbookAction.bind(null, locale, book.bookId, book.slug)}
                copy={copy.actions}
                getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug)}
                locale={locale}
                publicAction={publicBookAction(book)}
              />
              {book.hasSample ? (
                <Link className={`inline-flex min-h-11 items-center ${textLink}`} href={routes.sample(book.slug)}>
                  {copy.quoteCard.readSample}
                </Link>
              ) : null}
            </div>
            <p className="mt-8 text-xs text-sage-text">{copy.quoteCard.sharedFrom}</p>
          </div>
        </div>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
