import type { PublicationJobDTO } from "@/lib/data/publications";
import type { PublicationLifecycleState } from "@/lib/publishing/state";

const lifecycleLabel: Record<PublicationLifecycleState, string> = {
  queued: "Queued",
  processing: "Processing",
  failed: "Failed",
  ready_for_preview: "Ready for preview",
  published: "Published",
  rejected: "Rejected",
  superseded: "Superseded",
};

// Lifecycle pill tone: Success for a live version, Error for a failure, Sand hairline otherwise.
const lifecycleTone: Record<PublicationLifecycleState, string> = {
  queued: "border-sand text-ink",
  processing: "border-sand text-ink",
  failed: "border-error text-error",
  ready_for_preview: "border-ink text-ink",
  published: "border-success text-success",
  rejected: "border-error text-error",
  superseded: "border-sand text-sage-text",
};

// A no-interactivity Server Component: everything here is a direct projection of
// getPublicationOverview()'s DTO, so there is nothing for a Client Component's hooks to manage.
export function PublicationStatus({
  lifecycle,
  job,
  isActivePublication,
}: {
  lifecycle: PublicationLifecycleState;
  job: PublicationJobDTO | null;
  isActivePublication: boolean;
}) {
  return (
    <div className="space-y-4 text-sm">
      <p className="flex flex-wrap items-center gap-2" data-testid="publication-lifecycle">
        <span className="font-medium">Status:</span>{" "}
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium tracking-[0.06em] uppercase ${lifecycleTone[lifecycle]}`}
        >
          {lifecycleLabel[lifecycle]}
        </span>
        {isActivePublication ? <span className="text-sage-text"> (currently active)</span> : ""}
      </p>
      {lifecycle === "queued" ? (
        <p className="text-sage-text" role="status">
          Waiting for local processor.
        </p>
      ) : null}
      {lifecycle === "processing" ? (
        <p className="text-sage-text" role="status">
          Processing is under way.
        </p>
      ) : null}
      {job ? (
        <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2 border-t border-sand pt-4">
          <dt className="text-sage-text">Attempt</dt>
          <dd>{job.attempt}</dd>
          <dt className="text-sage-text">Correlation ID</dt>
          <dd className="font-mono text-[0.8125rem] break-all">{job.correlationId}</dd>
          {job.errorCode ? (
            <>
              <dt className="text-sage-text">Error code</dt>
              <dd className="font-mono text-[0.8125rem] text-error">{job.errorCode}</dd>
            </>
          ) : null}
          {job.errorMessage ? (
            <>
              <dt className="text-sage-text">Error</dt>
              <dd>{job.errorMessage}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
