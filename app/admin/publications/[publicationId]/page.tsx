import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { PublicationPreview } from "@/components/admin/publication-preview";
import { PublicationStatus } from "@/components/admin/publication-status";
import { requireAdmin } from "@/lib/auth/admin";
import { getPublicationOverview, getPublicationVersionHistory } from "@/lib/data/publications";

// The `[publicationId]` route segment holds an ebook_asset id, not an ebook_publications id -
// see lib/data/publications.ts's header comment for why: it is the one identifier stable across
// this upload's whole lifecycle, from the moment finalizeEpubUpload() queues a job through to
// however many transitions its eventual publication goes through.
export default async function AdminPublicationPage({
  params,
}: {
  params: Promise<{ publicationId: string }>;
}) {
  const { publicationId: assetId } = await params;
  await requireAdmin({ next: `/admin/publications/${assetId}` });

  const overview = await getPublicationOverview(assetId);
  const versions = await getPublicationVersionHistory(overview.editionId);

  return (
    <div className="max-w-[56rem]">
      <AdminPageHeader eyebrow="Publication" title={overview.bookTitle}>
        <p>
          Version {overview.version} &middot;{" "}
          <a
            className="font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
            href={`/admin/books/${overview.bookId}`}
          >
            Back to book
          </a>
        </p>
      </AdminPageHeader>

      <div className="space-y-12">
        <AdminSection title="Processing status">
          <PublicationStatus
            isActivePublication={overview.isActivePublication}
            job={overview.job}
            lifecycle={overview.lifecycle}
          />
        </AdminSection>

        <AdminSection title="Preview & release">
          <PublicationPreview
            assetId={overview.assetId}
            bookId={overview.bookId}
            lifecycle={overview.lifecycle}
            publicationId={overview.publicationId}
            resources={overview.resources}
            toc={overview.toc}
            versions={versions}
          />
        </AdminSection>
      </div>
    </div>
  );
}
