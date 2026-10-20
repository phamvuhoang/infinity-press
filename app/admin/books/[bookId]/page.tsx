import Link from "next/link";

import {
  saveBookLocalizationAction,
  saveRetailLinksAction,
  setBookRelationsAction,
  setRelatedBooksAction,
  updateBookDetailsAction,
  updateEditionAction,
  updateOfferAction,
} from "@/app/admin/books/[bookId]/editor-actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { CoverUploadForm } from "@/components/admin/book-editor/cover-upload-form";
import { DetailsForm } from "@/components/admin/book-editor/details-form";
import { EditionForm, OfferForm } from "@/components/admin/book-editor/edition-offer-forms";
import { LocalizationForm } from "@/components/admin/book-editor/localization-form";
import { PublishPanel } from "@/components/admin/book-editor/publish-panel";
import { RelatedBooksPicker } from "@/components/admin/book-editor/related-books-picker";
import { RelationsForm } from "@/components/admin/book-editor/relations-form";
import { RetailLinksForm } from "@/components/admin/book-editor/retail-links-form";
import { SectionNav, type EditorSectionLink } from "@/components/admin/book-editor/section-nav";
import { EpubUploadForm } from "@/components/admin/epub-upload-form";
import { ReadinessBadge } from "@/components/admin/readiness-badge";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminBook, listAdminBooks } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

const sections: EditorSectionLink[] = [
  { id: "details", label: "Details" },
  { id: "localizations", label: "Localizations" },
  { id: "offer", label: "Edition & offer" },
  { id: "retail", label: "Paperback retailers" },
  { id: "cover", label: "Cover" },
  { id: "relations", label: "Relations" },
  { id: "epub", label: "EPUB" },
  { id: "publish", label: "Publish" },
];

export default async function AdminBookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const [book, authors, topics, series, allBooks] = await Promise.all([
    getAdminBook(bookId),
    listCatalogEntityOptions("author"),
    listCatalogEntityOptions("topic"),
    listCatalogEntityOptions("series"),
    listAdminBooks(),
  ]);

  // A book cannot be pinned to itself - admin_set_related_books refuses it with a 22023 - so the
  // choice is never offered.
  const pinCandidates = allBooks
    .filter((candidate) => candidate.id !== book.id)
    .map((candidate) => ({ id: candidate.id, title: candidate.title, authorName: candidate.authorName, status: candidate.status }));

  return (
    <div className="min-w-0 max-w-[48rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Book" title={book.localization?.title ?? book.canonicalKey}>
        <p>
          {book.authorName} &middot; {book.canonicalKey} &middot; {book.status}
        </p>
        {book.offer ? (
          <p>
            Price: {book.offer.priceMinor} {book.offer.currency} ({book.offer.marketCode})
          </p>
        ) : null}
        <div className="mt-3">
          <ReadinessBadge issues={book.readinessIssues} />
        </div>
        <p className="mt-3">
          <Link className="underline decoration-sand underline-offset-4" href={`/admin/quotes?book=${book.id}`}>
            Shared quotes from this book
          </Link>
        </p>
      </AdminPageHeader>

      <SectionNav sections={sections} />

      <div className="space-y-12">
        <AdminSection id="details" title="Details">
          <DetailsForm
            action={updateBookDetailsAction.bind(null, book.id)}
            authors={authors}
            defaults={{ canonicalKey: book.canonicalKey, originalLanguage: book.originalLanguage, primaryAuthorId: book.primaryAuthorId }}
          />
        </AdminSection>

        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {(["vi", "en"] as const).map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {locale === "vi" ? "Vietnamese" : "English"}
                </h3>
                <LocalizationForm
                  action={saveBookLocalizationAction.bind(null, book.id, locale)}
                  locale={locale}
                  localization={book.localizations.find((localization) => localization.locale === locale) ?? null}
                />
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection id="offer" title="Edition & offer">
          <div className="space-y-10">
            {book.edition ? <EditionForm action={updateEditionAction.bind(null, book.id, book.edition.id)} edition={book.edition} /> : null}
            {book.offer ? (
              <OfferForm action={updateOfferAction.bind(null, book.id, book.offer.id)} offer={book.offer} />
            ) : (
              <p className="text-sm text-sage-text">No offer recorded.</p>
            )}
          </div>
        </AdminSection>

        <AdminSection id="retail" title="Paperback retailers">
          <p className="mb-4 text-sm text-sage-text">
            Where the printed book is sold. Links open in a new tab from the book page and carry UTM parameters; paste the plain marketplace URL.
          </p>
          <RetailLinksForm action={saveRetailLinksAction.bind(null, book.id)} links={book.retailLinks} />
        </AdminSection>

        <AdminSection id="cover" title="Cover">
          <CoverUploadForm
            bookId={book.id}
            cover={book.cover ? { publicUrl: book.cover.publicUrl, altText: book.cover.altText } : null}
          />
        </AdminSection>

        <AdminSection id="relations" title="Relations">
          <div className="space-y-12">
            <RelationsForm
              action={setBookRelationsAction.bind(null, book.id)}
              defaults={{ topicIds: book.topicIds, seriesId: book.series?.seriesId ?? null, seriesPosition: book.series?.position ?? null }}
              series={series}
              topics={topics}
            />
            <div>
              <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">Editorial pins</h3>
              <RelatedBooksPicker
                action={setRelatedBooksAction.bind(null, book.id)}
                books={pinCandidates}
                pinnedBookIds={book.relatedBookIds}
              />
            </div>
          </div>
        </AdminSection>

        <AdminSection id="epub" title="EPUB">
          <p className="mb-4 text-sm text-sage-text">
            {book.activePublicationId ? "An EPUB version is published for this book." : "No EPUB version is published yet."}
          </p>
          {book.edition ? (
            <EpubUploadForm bookId={book.id} />
          ) : (
            <p className="text-sm text-sage-text">This book has no edition yet, so it cannot accept an EPUB upload.</p>
          )}
        </AdminSection>
        <AdminSection id="publish" title="Publish">
          <PublishPanel bookId={book.id} issues={book.readinessIssues} status={book.status} />
        </AdminSection>
      </div>
    </div>
  );
}
