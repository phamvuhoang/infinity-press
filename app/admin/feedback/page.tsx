import Link from "next/link";

import { resolveFeedbackAction } from "@/app/admin/feedback/actions";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { FeedbackRow } from "@/components/admin/feedback/feedback-row";
import { requireAdmin } from "@/lib/auth/admin";
import { type AdminFeedbackStatus, listEditionFeedback } from "@/lib/data/edition-feedback";

const STATUSES: readonly AdminFeedbackStatus[] = ["new", "resolved", "dismissed"];
const label = (status: string) => status.charAt(0).toUpperCase() + status.slice(1);

export default async function AdminFeedbackPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/feedback" });
  const { status: raw } = await searchParams;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const status = STATUSES.find((candidate) => candidate === value) ?? "new";
  const items = await listEditionFeedback(status);

  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Editorial" title="Translation reports">
        What readers flagged while reading. Reports go to the editors only; nothing is sent to the original author. The 200 newest in each
        status are shown.
      </AdminPageHeader>
      <nav aria-label="Report status" className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-sm font-medium">
        {STATUSES.map((tab) => (
          <Link
            aria-current={tab === status ? "page" : undefined}
            className={`inline-flex min-h-11 items-center underline-offset-[6px] hover:underline ${tab === status ? "text-forest underline" : "text-ink"}`}
            href={`/admin/feedback?status=${tab}`}
            key={tab}
          >
            {label(tab)}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <p className="text-sage-text">{`No ${status} reports.`}</p>
      ) : (
        <div aria-label="Reports" className="max-w-full overflow-x-auto" role="region" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">{`${label(status)} translation reports`}</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Edition</th>
                <th className="py-2 pr-3 font-medium" scope="col">Report</th>
                <th className="py-2 font-medium" scope="col">Triage</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <FeedbackRow action={resolveFeedbackAction.bind(null, item.id)} item={item} key={item.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
