import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { JourneyStatusBadge } from "@/components/admin/journeys/journey-publish-panel";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminJourneys } from "@/lib/data/admin-journeys";
import { adminRoutes } from "@/lib/i18n/routes";

export default async function AdminJourneysPage() {
  await requireAdmin({ next: "/admin/journeys" });
  const journeys = await listAdminJourneys();

  return (
    <div className="max-w-[64rem] min-w-0">
      <AdminPageHeader eyebrow="Reading" title="Journeys">
        <Button render={<Link href="/admin/journeys/new" />}>New journey</Button>
      </AdminPageHeader>
      {journeys.length === 0 ? (
        <p className="text-sage-text">No journeys yet.</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[42rem] table-fixed border-t border-ink text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
                <th className="px-1 py-3 font-medium" scope="col">
                  Title
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Book
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Sessions
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Languages
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {journeys.map((journey) => (
                <tr className="border-b border-sand" key={journey.id}>
                  <th className="min-w-0 px-1 py-3 font-normal wrap-anywhere" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium wrap-anywhere text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                      href={adminRoutes.adminJourney(journey.id)}
                    >
                      {journey.title}
                    </Link>
                  </th>
                  <td className="px-1 py-3 wrap-anywhere">{`${journey.bookTitle} (${journey.languageCode})`}</td>
                  <td className="px-1 py-3">{journey.sessionCount}</td>
                  <td className="px-1 py-3 wrap-anywhere">{journey.locales.join(", ") || "—"}</td>
                  <td className="px-1 py-3">
                    <JourneyStatusBadge status={journey.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
