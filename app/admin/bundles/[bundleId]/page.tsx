import {
  saveBundleLocalizationAction,
  setBundleMembersAction,
  setBundleOfferAction,
} from "@/app/admin/bundles/[bundleId]/actions";
import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { BundleCoverUploadForm } from "@/components/admin/bundle-editor/cover-upload-form";
import { BundleDetails } from "@/components/admin/bundle-editor/details-form";
import { BundleLocalizationForm } from "@/components/admin/bundle-editor/localization-form";
import { BundleMembersForm } from "@/components/admin/bundle-editor/members-form";
import { BundleOfferForm } from "@/components/admin/bundle-editor/offer-form";
import { BundlePublishPanel } from "@/components/admin/bundle-editor/publish-panel";
import { requireAdmin } from "@/lib/auth/admin";
import type { BundleEditorSection } from "@/lib/catalog/bundle-readiness";
import { listAdminBooks } from "@/lib/data/books";
import { getAdminBundle } from "@/lib/data/bundles";
import { locales, localeRegistry } from "@/lib/i18n/config";

// The anchors the readiness issues link to: bundleReadinessIssueSection names one of these for
// every issue code, so a verdict always points at a section that exists on this page.
const sections: { id: BundleEditorSection; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "localizations", label: "Localizations" },
  { id: "cover", label: "Cover" },
  { id: "members", label: "Editions" },
  { id: "offer", label: "Price" },
  { id: "publish", label: "Publish" },
];

export default async function AdminBundlePage({ params }: { params: Promise<{ bundleId: string }> }) {
  const { bundleId } = await params;
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });

  const [bundle, books] = await Promise.all([getAdminBundle(bundleId), listAdminBooks()]);
  // One option per EDITION, labelled with its language: a bundle sells editions, and an English +
  // Japanese bundle of one work is a deliberate product.
  const editionOptions = books.flatMap((book) =>
    book.editions.map((edition) => ({
      id: edition.id,
      title: `${book.title} (${edition.languageCode})`,
      published: edition.status === "published" && edition.activePublicationId !== null && book.status === "published",
    })),
  );

  return (
    <div className="min-w-0 max-w-[48rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Bundle" title={bundle.localizations[0]?.title ?? bundle.id}>
        <p>
          {bundle.members.length} {bundle.members.length === 1 ? "edition" : "editions"} &middot; {bundle.status}
        </p>
        {bundle.offers.map((offer) => (
          <p key={offer.id}>
            Price: {offer.priceMinor} {offer.currency} ({offer.marketCode}){offer.active ? "" : " — inactive"}
          </p>
        ))}
      </AdminPageHeader>

      <nav aria-label="Bundle editor sections" className="mb-10 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand pb-3 text-sm">
        {sections.map((section) => (
          <a
            className="inline-flex min-h-11 items-center text-forest hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
            href={`#${section.id}`}
            key={section.id}
          >
            {section.label}
          </a>
        ))}
      </nav>

      <div className="space-y-12">
        <AdminSection id="details" title="Details">
          <BundleDetails bundle={bundle} />
        </AdminSection>

        <AdminSection id="localizations" title="Localizations">
          <div className="space-y-12">
            {locales.map((locale) => (
              <div key={locale}>
                <h3 className="mb-4 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
                  {localeRegistry[locale].englishName}
                </h3>
                <BundleLocalizationForm
                  action={saveBundleLocalizationAction.bind(null, bundle.id, locale)}
                  locale={locale}
                  localization={bundle.localizations.find((localization) => localization.locale === locale) ?? null}
                />
              </div>
            ))}
          </div>
        </AdminSection>

        <AdminSection id="cover" title="Cover">
          <BundleCoverUploadForm
            bundleId={bundle.id}
            cover={bundle.cover ? { publicUrl: bundle.cover.publicUrl, altText: bundle.cover.altText } : null}
          />
        </AdminSection>

        <AdminSection id="members" title="Editions">
          <BundleMembersForm
            action={setBundleMembersAction.bind(null, bundle.id)}
            books={editionOptions}
            members={bundle.members}
          />
        </AdminSection>

        <AdminSection id="offer" title="Price">
          <BundleOfferForm action={setBundleOfferAction.bind(null, bundle.id)} offers={bundle.offers} />
        </AdminSection>

        <AdminSection id="publish" title="Publish">
          <BundlePublishPanel bundleId={bundle.id} readiness={bundle.readiness} status={bundle.status} />
        </AdminSection>
      </div>
    </div>
  );
}
