import Link from "next/link";

import { updateOfferAction } from "@/app/admin/books/[bookId]/editor-actions";
import {
  createOfferAction,
  recomputeAlignmentAction,
  setDefaultEditionAction,
  saveProvenanceAction,
  setDefaultOfferAction,
  setReviewAction,
  setSampleFullAction,
  updateEditionAction,
} from "@/app/admin/books/[bookId]/editions/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import {
  CreateOfferForm,
  DefaultButtonForm,
  EditionForm,
  OfferForm,
  SampleFullForm,
} from "@/components/admin/book-editor/edition-offer-forms";
import { ProvenanceForm, ReviewForm } from "@/components/admin/book-editor/edition-editorial-forms";
import { EpubUploadForm } from "@/components/admin/epub-upload-form";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminEdition, getAlignmentCoverage, listPricingDefaults } from "@/lib/data/admin-editions";
import { getAdminBook } from "@/lib/data/books";
import { getPublicationVersionHistory } from "@/lib/data/publications";
import { listContentLanguages } from "@/lib/i18n/settings";

const lifecycleLabel: Record<string, string> = {
  queued: "Queued",
  processing: "Processing",
  failed: "Failed",
  ready_for_preview: "Ready for preview",
  published: "Published",
  rejected: "Rejected",
  superseded: "Superseded",
};

// One language edition of a work: its details and credits, its offers, and its EPUB versions. The
// work-level page (copy, cover, relations) stays at /admin/books/[bookId]. Everything here is
// keyed by the edition id in the route, never inferred from the work.
export default async function AdminEditionPage({ params }: { params: Promise<{ bookId: string; editionId: string }> }) {
  const { bookId, editionId } = await params;
  await requireAdmin({ next: `/admin/books/${bookId}/editions/${editionId}` });

  const [edition, book, languages] = await Promise.all([
    getAdminEdition(bookId, editionId),
    getAdminBook(bookId),
    listContentLanguages(),
  ]);
  const [pricingDefaults, versions, alignmentCoverage] = await Promise.all([
    listPricingDefaults(edition.languageCode),
    getPublicationVersionHistory(editionId),
    edition.activePublicationId ? getAlignmentCoverage(edition.activePublicationId) : null,
  ]);
  const languageName = languages.find((language) => language.code === edition.languageCode)?.name ?? edition.languageCode;
  const title = book.localization?.title ?? book.canonicalKey;

  return (
    <div className="min-w-0 max-w-[48rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Edition" title={`${languageName} edition${edition.editionNumber > 1 ? ` ${edition.editionNumber}` : ""}`}>
        <p>
          <Link className="underline decoration-sand underline-offset-4" href={`/admin/books/${bookId}`}>
            Back to {title}
          </Link>{" "}
          &middot; {edition.status}
        </p>
      </AdminPageHeader>

      <div className="space-y-12">
        <AdminSection id="details" title="Details & credits">
          <div className="space-y-6">
            {edition.isDefault ? (
              <p className="text-sm">This is the default {languageName} edition.</p>
            ) : edition.status === "published" ? (
              <DefaultButtonForm
                action={setDefaultEditionAction.bind(null, bookId, editionId, edition.languageCode)}
                label={`Make default ${languageName} edition`}
                pendingLabel="Saving…"
              />
            ) : (
              // admin_set_default_edition refuses it too: a draft or archived default would hide the
              // work from its language even while another edition of that language is live.
              <p className="text-sm text-ink-soft">Only a published edition can be the default {languageName} edition.</p>
            )}
            <EditionForm
              action={updateEditionAction.bind(null, bookId, editionId)}
              edition={edition}
              languages={languages}
            />
          </div>
        </AdminSection>

        <AdminSection id="offers" title="Offers">
          <p className="mb-4 text-sm text-sage-text">
            An edition with no offer is visible but not for sale. The default offer is the one shown to readers.
          </p>
          <div className="space-y-10">
            {edition.offers.map((offer) => (
              <div key={offer.id}>
                <h3 className="mb-3 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {offer.currency} &middot; {offer.marketCode}
                  {offer.isDefault ? " · default" : ""}
                </h3>
                <OfferForm action={updateOfferAction.bind(null, bookId, offer.id)} offer={offer} />
                {offer.isDefault ? null : (
                  <div className="mt-4">
                    <DefaultButtonForm
                      action={setDefaultOfferAction.bind(null, bookId, editionId, offer.id)}
                      label="Make default offer"
                      pendingLabel="Saving…"
                    />
                  </div>
                )}
              </div>
            ))}
            <div>
              <h3 className="mb-3 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">New offer</h3>
              <CreateOfferForm action={createOfferAction.bind(null, bookId, editionId)} defaults={pricingDefaults} />
            </div>
          </div>
        </AdminSection>

        <AdminSection id="editorial" title="Provenance & editorial review">
          <p className="mb-4 text-sm text-sage-text">
            Press republishes works with a translation history. Record where the text and translation come from and what supports
            publishing them; a new EPUB version can go live only while this edition is approved. This stores evidence and a decision, not
            a legal opinion. Changing the evidence after approval withdraws the approval.
          </p>
          <div className="space-y-10">
            <ProvenanceForm action={saveProvenanceAction.bind(null, bookId, editionId)} editorial={edition.editorial} />
            <ReviewForm action={setReviewAction.bind(null, bookId, editionId)} editorial={edition.editorial} />
          </div>
        </AdminSection>

        <AdminSection id="epub" title="EPUB">
          <p className="mb-4 text-sm text-sage-text">
            {edition.activePublicationId
              ? "An EPUB version is live for this edition."
              : "No EPUB version is live for this edition yet."}{" "}
            Publishing or rolling back here never changes another language&apos;s edition.
          </p>
          <EpubUploadForm bookId={bookId} editionId={editionId} />
          {edition.activePublicationId ? (
            <div className="mt-6">
              <SampleFullForm
                action={setSampleFullAction.bind(null, bookId, editionId)}
                sampleFull={edition.sampleFull}
              />
            </div>
          ) : null}
          {alignmentCoverage !== null ? (
            <div className="mt-6 space-y-2">
              {/* Computed after every publish; a resource that cannot be paired has no compare. */}
              <p className="text-sm">
                Passage alignment: {Math.round(alignmentCoverage * 100)}% of passages line up with another edition.
              </p>
              <DefaultButtonForm
                action={recomputeAlignmentAction.bind(null, bookId, editionId)}
                label="Recompute alignment"
                pendingLabel="Recomputing…"
              />
            </div>
          ) : null}
          {versions.length > 0 ? (
            <ul className="mt-6 space-y-1 text-sm">
              {versions.map((version) => (
                <li key={version.assetId}>
                  <Link
                    className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink"
                    href={`/admin/publications/${version.assetId}`}
                  >
                    {`Version ${version.version} · ${lifecycleLabel[version.lifecycle] ?? version.lifecycle}`}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </AdminSection>
      </div>
    </div>
  );
}
