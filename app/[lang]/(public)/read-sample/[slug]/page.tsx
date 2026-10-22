import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookActionControl } from "@/components/catalog/book-action-control";
import { ReaderMount } from "@/components/reader/reader-mount";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookPage, getSampleReaderBook } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { buildPageMetadata } from "@/lib/seo/metadata";

import { buyEbookAction, getFreeEbookAction } from "../../books/[slug]/actions";

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: Promise<{ edition?: string | string[] }> };

// `?edition=` names the edition whose sample to open; absent, the default edition's.
function requestedEdition(params: { edition?: string | string[] }): string | null {
  const value = Array.isArray(params.edition) ? params.edition[0] : params.edition;
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

// The sample's CONTENT is public - that is the point of a sample, and /api/samples/* serves it to
// anonymous callers by design. This surface is still noindex: it is a reading application rather
// than a page. The book page is what search engines should find.
const sampleRobots = { index: false, follow: false } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return { robots: sampleRobots };
  // getBookPage is request-cached, so this shares the page's own catalog read.
  const book = await getBookPage(locale, slug);
  if (!book || !book.hasSample) return { robots: sampleRobots };
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: { [locale]: getCatalogRoutes(locale).sample(book.slug) },
    title: book.title,
    image: book.cover,
    index: "noindex-nofollow",
  });
}

export default async function ReadSamplePage({ params, searchParams }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();

  // No requireUser: this is the one reading surface with no sign-in wall, and lib/auth/route-access
  // leaves /{locale}/read-sample public for the same reason. The sample allowlist in
  // lib/reader/session.ts is the entire trust boundary here.
  const editionId = requestedEdition(await searchParams);
  const book = await getSampleReaderBook(locale, slug, editionId);
  if (!book) notFound();

  const dictionary = await getDictionary(locale);
  const routes = getCatalogRoutes(locale);
  const bookPath = routes.book(book.slug);
  // Signing in from the sample (its whole-book banner) comes back to this same sample.
  const samplePath = routes.sample(book.slug) + (editionId ? `?${new URLSearchParams({ edition: editionId })}` : "");

  return (
    <main className="min-h-dvh bg-white" id="main-content">
      <h1 className="sr-only">{book.title}</h1>
      <ReaderMount
        backHref={bookPath}
        bookId={book.bookId}
        bookTitle={book.title}
        copy={dictionary.reader}
        // The end-of-sample card itself (title, body) is rendered by the reader client - this is
        // only the Get/Buy/Read control that goes inside it, built here because BookActionControl
        // needs bound Server Actions and those cannot be created inside a client module.
        endSlot={
          <BookActionControl
            action={book.action}
            bookPath={bookPath}
            buyAction={
              book.offer
                ? buyEbookAction.bind(null, locale, book.bookId, book.slug, book.editionId, book.offer.offerId, book.offer.priceMinor)
                : async () => undefined
            }
            copy={dictionary.catalog.actions}
            getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug, book.editionId)}
            locale={locale}
            readHref={routes.readEdition(book.editionId)}
            signedIn={book.signedIn}
          />
        }
        initialLocator={null}
        libraryHref={bookPath}
        locale={locale}
        manifestUrl={`/api/samples/${book.publicationId}/manifest`}
        mode="sample"
        publicationId={book.publicationId}
        // A sample visitor holds no edition, so there is nothing to report against.
        reportHref={null}
        sampleFullNotice={book.sampleFull && !book.signedIn ? dictionary.journeys.signInToTrack : undefined}
        signInHref={routes.signInFor(samplePath)}
      />
    </main>
  );
}
