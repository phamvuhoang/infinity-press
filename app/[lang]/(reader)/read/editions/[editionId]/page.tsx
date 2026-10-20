import { notFound } from "next/navigation";

import { ReaderMount } from "@/components/reader/reader-mount";
import { requireUser } from "@/lib/auth/session";
import { getReadableEdition } from "@/lib/data/library";
import { isLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

export default async function ReadEditionPage({
  params,
}: {
  params: Promise<{ lang: string; editionId: string }>;
}) {
  const { lang: locale, editionId } = await params;
  if (!isLocale(locale)) notFound();

  await requireUser(locale, withLocale(locale, `/read/editions/${editionId}`));

  // One notFound() for "you hold no entitlement", "no such book", and "this book has no active
  // publication" alike. A reader who does not own this book must not be able to tell that it
  // exists - the same non-disclosure property the reader API handlers enforce with their single
  // 404, applied to the page that links to them.
  const book = await getReadableEdition(locale, editionId);
  if (!book) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.reader;

  // Board 1k: the reader owns the whole viewport and draws its own chrome, so no site header.
  return (
    <main className="min-h-dvh bg-white" id="main-content">
      <h1 className="sr-only">{book.title}</h1>
      {/* This page deliberately does not mint the reader session itself: the session is created by
          POST /api/reader/sessions from the client that is about to fetch the manifest, so its
          short TTL starts when reading actually begins rather than when the page happens to render.

          Only the manifest URL, active publication id, reader presentation fields, and this
          reader's saved position cross to the client - never a storage key, never a service-role
          client, never another publication id, and never the publication's storage layout.
          `initialLocator` comes from the server rather than a client fetch so the engine is handed
          its starting position at mount time; applying it afterwards would render the opening page
          and then jump, which reads as a bug.

          The back-to-library link lives inside the reader client, not here, because leaving has to
          flush an unsaved position before it navigates - which a plain <Link> in a Server
          Component cannot do. */}
      {/* `copy={copy}` rather than a field-by-field literal: `ReaderCopy` is exactly
          `Dictionary["reader"]`, and listing forty-odd keys by hand is a transcription error
          waiting to happen. */}
      <ReaderMount
        backHref={withLocale(locale, "/library")}
        askHref={book.acceptsQuestions ? getCatalogRoutes(locale).ask({ book: book.bookId }) : null}
        authorName={book.authorName}
        bookId={book.bookId}
        bookTitle={book.title}
        canonicalBookUrl={book.canonicalBookUrl}
        copy={copy}
        initialLocator={book.initialLocator}
        libraryHref={withLocale(locale, "/library")}
        locale={locale}
        manifestUrl={`/api/reader/publications/${book.publicationId}/manifest`}
        mode="entitled"
        publicationId={book.publicationId}
        relatedBooks={book.relatedBooks.map(({ title, authorName, href, coverUrl }) => ({
          title,
          authorName,
          href,
          coverUrl,
        }))}
        reviewHref={getCatalogRoutes(locale).review(book.bookId)}
        signInHref={getCatalogRoutes(locale).signInFor(withLocale(locale, `/read/editions/${book.editionId}`))}
      />
    </main>
  );
}
