import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { REVIEW_STATUSES, ReviewList } from "@/components/admin/reviews/review-list";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminReviews, type AdminReviewStatus } from "@/lib/data/admin-reviews";

export default async function AdminReviewsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/reviews" });
  const { status: raw } = await searchParams;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const status: AdminReviewStatus = REVIEW_STATUSES.find((s) => s === value) ?? "pending";
  const reviews = await listAdminReviews(status);

  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Readers" title="Reviews">
        Publish or reject reader reviews and reply as the author. The 200 newest in each status are shown.
      </AdminPageHeader>
      <ReviewList reviews={reviews} status={status} />
    </div>
  );
}
