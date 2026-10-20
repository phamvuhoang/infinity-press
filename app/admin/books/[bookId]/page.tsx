import Link from "next/link";

import {
  saveBookLocalizationAction,
  saveRetailLinksAction,
  setBookRelationsAction,
  setRelatedBooksAction,
  updateBookDetailsAction,
} from "@/app/admin/books/[bookId]/editor-actions";
import { createEditionAction } from "@/app/admin/books/[bookId]/editions/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { CoverUploadForm } from "@/components/admin/book-editor/cover-upload-form";
import { DetailsForm } from "@/components/admin/book-editor/details-form";
import { CreateEditionForm } from "@/components/admin/book-editor/edition-offer-forms";
import { LocalizationForm } from "@/components/admin/book-editor/localization-form";
import { PublishPanel } from "@/components/admin/book-editor/publish-panel";
import { RelatedBooksPicker } from "@/components/admin/book-editor/related-books-picker";
import { RelationsForm } from "@/components/admin/book-editor/relations-form";
import { RetailLinksForm } from "@/components/admin/book-editor/retail-links-form";
import { SectionNav, type EditorSectionLink } from "@/components/admin/book-editor/section-nav";
import { ReadinessBadge } from "@/components/admin/readiness-badge";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminBook, listAdminBooks, type AdminBookDTO } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";
import { locales, localeRegistry } from "@/lib/i18n/config";
import { listContentLanguages } from "@/lib/i18n/settings";

const sections: EditorSectionLink[] = [
  { id: "details", label: "Details" },
  { id: "localizations", label: "Localizations" },
  { id: "editions", label: "Editions" },
  { id: "retail", label: "Paperback retailers" },
  { id: "cover", label: "Cover" },
  { id: "relations", label: "Relations" },
  { id: "publish", label: "Publish" },
];

// "Published · default · 1 offer": the state of an edition at a glance.
function editionSummary(edition: AdminBookDTO["editions"][number]): string {
  const status = edition.status.charAt(0).toUpperCase() + edition.status.slice(1);
  const offers = edition.offerCount === 0 ? "no offer" : `${edition.offerCount} offer${edition.offerCount === 1 ? "" : "s"}`;
  return [status, edition.isDefault ? "default" : null, offers].filter(Boolean).join(" · ");
}

export default async function AdminBookPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const [book, authors, topics, series, allBooks, languages] = await Promise.all([
    getAdminBook(bookId),
    listCatalogEntityOptions("author"),
    listCatalogEntityOptions("topic"),
    listCatalogEntityOptions("series"),
    listAdminBooks(),
    listContentLanguages(),
  ]);
  const languageName = new Map(languages.map((language) => [language.code, language.name]));

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
            languages={languages}
            defaults={{ canonicalKey: book.canonicalKey, originalLanguage: book.originalLanguage, primaryAuthorId: book.primaryAuthorId }}
          />
        </AdminSection>

        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {locales.map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {localeRegistry[locale].englishName}
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

        <AdminSection id="editions" title="Editions">
          <p className="mb-4 text-sm text-sage-text">
            One edition per language translation. Each has its own EPUB, credits, offers and publication, and is published or rolled
            back on its own.
          </p>
          {book.editions.length === 0 ? (
            <p className="mb-6 text-sm text-sage-text">No editions yet. Add one to upload an EPUB.</p>
          ) : (
            <ul className="mb-8 divide-y divide-sand border-y border-sand">
              {book.editions.map((edition) => (
                <li className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3" key={edition.id}>
                  <Link
                    className="font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink"
                    href={`/admin/books/${book.id}/editions/${edition.id}`}
                  >
                    {languageName.get(edition.languageCode) ?? edition.languageCode}
                    {edition.editionNumber > 1 ? ` (edition ${edition.editionNumber})` : ""}
                  </Link>
                  <span className="text-sm text-sage-text">{editionSummary(edition)}</span>
                </li>
              ))}
            </ul>
          )}
          <CreateEditionForm action={createEditionAction.bind(null, book.id)} languages={languages} />
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

        <AdminSection id="publish" title="Publish">
          <PublishPanel bookId={book.id} issues={book.readinessIssues} status={book.status} />
        </AdminSection>
      </div>
    </div>
  );
}
