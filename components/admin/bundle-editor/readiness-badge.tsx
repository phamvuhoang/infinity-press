import { bundleReadinessIssueMessage, type BundleReadiness } from "@/lib/catalog/bundle-readiness";

// Two badges, because a bundle's verdict has two halves. Blocking issues stop publication;
// warnings never do - an unpublished member book is hidden on the bundle page rather than a
// reason to take the whole bundle down (spec 6.2) - so a warning is shown beside "Ready to
// publish" rather than folded into a single count that would make a ready bundle look broken.
export function BundleReadinessBadge({ readiness }: { readiness: BundleReadiness }) {
  const titleOf = (codes: BundleReadiness["blocking"]) => codes.map((code) => bundleReadinessIssueMessage[code]).join("\n");

  return (
    <span className="flex flex-wrap items-center gap-2">
      {readiness.blocking.length === 0 ? (
        <span className="rounded-full border border-success px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-success uppercase whitespace-nowrap">
          Ready to publish
        </span>
      ) : (
        <span
          className="rounded-full border border-sand px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-ink uppercase whitespace-nowrap"
          title={titleOf(readiness.blocking)}
        >
          {readiness.blocking.length} to fix
        </span>
      )}
      {readiness.warnings.length > 0 ? (
        <span
          className="rounded-full border border-sand px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] text-sage-text uppercase whitespace-nowrap"
          title={titleOf(readiness.warnings)}
        >
          {readiness.warnings.length} {readiness.warnings.length === 1 ? "warning" : "warnings"}
        </span>
      ) : null}
    </span>
  );
}
