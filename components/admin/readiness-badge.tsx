import { readinessIssueMessage, type ReadinessIssueCode } from "@/lib/catalog/readiness";

export function ReadinessBadge({ issues }: { issues: ReadinessIssueCode[] }) {
  if (issues.length === 0) {
    return (
      <span className="rounded-full border border-success px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-success uppercase whitespace-nowrap">
        Ready to publish
      </span>
    );
  }

  return (
    <span
      className="rounded-full border border-sand px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-ink uppercase whitespace-nowrap"
      title={issues.map((issue) => readinessIssueMessage[issue]).join("\n")}
    >
      {issues.length} to fix
    </span>
  );
}
