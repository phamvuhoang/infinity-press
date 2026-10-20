import Link from "next/link";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { formatDate } from "@/lib/i18n/format";
import {
  OPS_RULE_NAMES,
  RULE_LABELS,
  type OperationsAlertState,
  type OperationsReport,
  type OpsFinding,
} from "@/lib/ops/types";

// Presentational only (spec S5 10.3): app/admin/operations/page.tsx calls requireAdmin(), loads
// the live report and the worker's alert state, then hands both plus its own `now` here. Nothing
// below reaches Supabase, so this needs no client in its test - only the OpsFinding/
// OperationsAlertState shapes, which never carry a customer email, a provider payload, or book
// text (lib/ops/types.ts).

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// English-only relative age against the page's own `now`, so a finding's age never depends on the
// viewer's clock or locale (admin pages are English-only per AGENTS.md).
function relativeAge(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const magnitude = Math.abs(diffMs);
  if (magnitude < MINUTE_MS) return "Just now";
  // "always" (not "auto") so a one-day-old finding reads "1 day ago" rather than the ambiguous
  // "yesterday" - an operator needs the exact elapsed time, not a calendar-day label.
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (magnitude < HOUR_MS) return rtf.format(Math.round(-diffMs / MINUTE_MS), "minute");
  if (magnitude < DAY_MS) return rtf.format(Math.round(-diffMs / HOUR_MS), "hour");
  return rtf.format(Math.round(-diffMs / DAY_MS), "day");
}

function absoluteTime(iso: string): string {
  return formatDate(iso, "en", { withTime: true });
}

function FindingRow({ finding, now }: { finding: OpsFinding; now: Date }) {
  return (
    <li className="flex flex-col gap-1 border-b border-sand py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm text-ink">{finding.summary}</p>
        <p className="text-xs text-sage-text">
          <time dateTime={finding.occurredAt}>{relativeAge(finding.occurredAt, now)}</time>
        </p>
      </div>
      <Link
        className="inline-flex min-h-11 shrink-0 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
        href={finding.repairPath}
      >
        Review
      </Link>
    </li>
  );
}

export function OperationsPanel({
  report,
  alertStates,
  now,
}: {
  report: OperationsReport;
  alertStates: OperationsAlertState[];
  now: Date;
}) {
  const totalFindings = OPS_RULE_NAMES.reduce((sum, rule) => sum + report.findings[rule].length, 0);
  // Null until the scheduled worker has evaluated at least one rule: the migration seeds every
  // row unevaluated, so the page shows "Not yet run" rather than a migration timestamp.
  const lastSchedulerEvaluation = alertStates.reduce<string | null>((latest, state) => {
    if (state.lastEvaluatedAt === null) return latest;
    return latest === null || Date.parse(state.lastEvaluatedAt) > Date.parse(latest) ? state.lastEvaluatedAt : latest;
  }, null);
  const activeAlerts = alertStates.filter((state) => state.active);

  return (
    <div className="max-w-[48rem]">
      <AdminPageHeader eyebrow="Operations" title="Operations">
        Live findings from the scheduled operational checks. Findings clear on their own once the
        underlying row is fixed - S5 does not add repair actions to this page.
      </AdminPageHeader>

      <div className="mb-8 border-t border-ink pt-4">
        <p className="text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
          Last scheduler evaluation
        </p>
        <p className="mt-1 text-sm">{lastSchedulerEvaluation ? absoluteTime(lastSchedulerEvaluation) : "Not yet run"}</p>
      </div>

      {activeAlerts.length > 0 ? (
        <div className="mb-8 border-t border-ink pt-4">
          <h2 className="mb-3 text-[0.6875rem] font-medium tracking-[0.08em] text-sage-text uppercase">
            Last successful alert
          </h2>
          <ul className="space-y-1 text-sm">
            {activeAlerts.map((state) => (
              <li key={state.ruleName}>
                <span className="font-medium">{RULE_LABELS[state.ruleName]}:</span>{" "}
                <span>{state.lastAlertedAt ? absoluteTime(state.lastAlertedAt) : "Not yet sent"}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {totalFindings === 0 ? (
        <p className="border-t border-ink pt-6 text-success" role="status">
          All operational checks are clear.
        </p>
      ) : (
        <div className="space-y-10">
          {OPS_RULE_NAMES.filter((rule) => report.findings[rule].length > 0).map((rule) => (
            <AdminSection key={rule} title={`${RULE_LABELS[rule]} (${report.findings[rule].length})`}>
              <ul>
                {report.findings[rule].map((finding) => (
                  <FindingRow finding={finding} key={finding.id} now={now} />
                ))}
              </ul>
            </AdminSection>
          ))}
        </div>
      )}
    </div>
  );
}
