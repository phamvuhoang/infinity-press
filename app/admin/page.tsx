import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminSummary } from "@/lib/data/admin";

export default async function AdminDashboardPage() {
  await requireAdmin({ next: "/admin" });
  const summary = await getAdminSummary();

  const stats = [
    { label: "Books", value: summary.bookCount },
    { label: "Publications", value: summary.publicationCount },
    { label: "Failed processing jobs", value: summary.failedProcessingJobCount },
    { label: "Users", value: summary.userCount },
    { label: "Active entitlements", value: summary.activeEntitlementCount },
    { label: "Pending reviews", value: summary.pendingReviewCount },
    { label: "New questions", value: summary.newQuestionCount },
  ];

  return (
    <div>
      <AdminPageHeader title="Admin dashboard">
        Operational counts across the catalog, publishing, and access.
      </AdminPageHeader>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3 lg:grid-cols-4">
        {stats.map((stat) => (
          <div className="border-t border-ink pt-3" key={stat.label}>
            <dt className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">{stat.label}</dt>
            <dd
              className={
                stat.label === "Failed processing jobs" && stat.value > 0
                  ? "mt-2 font-serif text-5xl text-error"
                  : "mt-2 font-serif text-5xl"
              }
            >
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
