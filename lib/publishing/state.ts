// Pure publication lifecycle decisions, independent of any database round trip - the same spirit
// as lib/auth/session.ts's decideAccess(). `publish_publication`, `reject_publication`, and
// `rollback_publication` (20260911180000_publication_transition_rpcs.sql) each re-derive the same
// decision inside their own SQL (they cannot call back into TypeScript), so this module is the
// provable, unit-tested specification those RPCs are written to match - not code they execute.
//
// `PublicationLifecycleState` unions two different enums by design: an ebook_asset only reaches
// 'ready_for_preview' (and, from there, 'published' or 'superseded') once a processing job has
// completed for it - `queued`, `processing`, and `failed` describe the asset before any
// ebook_publications row exists at all (public.ebook_asset_status). Once a publication exists,
// its own public.publication_status ('ready_for_preview' | 'published' | 'rejected' |
// 'superseded') is authoritative. An admin looking at one book's publishing history sees this as
// one continuous lifecycle, not two - lib/data/publications.ts's getPublicationOverview() is what
// projects the two real enums into this single admin-facing view.
export type PublicationLifecycleState =
  | "queued"
  | "processing"
  | "failed"
  | "ready_for_preview"
  | "published"
  | "rejected"
  | "superseded";

// The four transitions the admin surface can request or imply:
// - "publish": an admin approves a `ready_for_preview` candidate.
// - "reject": an admin declines a `ready_for_preview` candidate instead.
// - "supersede": applied by publish_publication/rollback_publication to whichever publication was
//   *previously* active for the book, never requested directly by an admin.
// - "reactivate": applied by rollback_publication to the target `superseded` publication being
//   restored - deliberately not just "publish" again, since a superseded publication was already
//   published once and reactivating it should never be confused with approving a fresh candidate
//   (decidePublish below rejects a `superseded` current state outright, pointing callers here).
export type PublicationTransitionCommand = "publish" | "reject" | "supersede" | "reactivate";

export type PublicationTransitionDecision =
  | { allowed: true; next: PublicationLifecycleState }
  | { allowed: false; reason: string };

function allow(next: PublicationLifecycleState): PublicationTransitionDecision {
  return { allowed: true, next };
}

function deny(reason: string): PublicationTransitionDecision {
  return { allowed: false, reason };
}

// Exhaustiveness guard: TypeScript rejects any call site that reaches this with a value the
// `PublicationLifecycleState` (or command) union doesn't cover, so extending either union without
// updating every switch below is a compile error, not a silent fall-through.
function assertNeverState(value: never): never {
  throw new Error(`decidePublicationTransition: unhandled lifecycle state ${JSON.stringify(value)}`);
}

function decidePublish(current: PublicationLifecycleState): PublicationTransitionDecision {
  switch (current) {
    case "ready_for_preview":
      return allow("published");
    case "queued":
    case "processing":
      return deny("Processing has not finished yet; wait for it to reach ready-for-preview.");
    case "failed":
      return deny("This version failed processing and cannot be published.");
    case "published":
      return deny("This version is already published.");
    case "rejected":
      return deny("A rejected version cannot be published.");
    case "superseded":
      return deny("A superseded version cannot be published directly; use rollback instead.");
    default:
      return assertNeverState(current);
  }
}

function decideReject(current: PublicationLifecycleState): PublicationTransitionDecision {
  switch (current) {
    case "ready_for_preview":
      return allow("rejected");
    case "queued":
    case "processing":
      return deny("Processing has not finished yet; wait for it to reach ready-for-preview.");
    case "failed":
      return deny("This version already failed processing.");
    case "published":
      return deny("A published version cannot be rejected; roll back instead if it needs to be replaced.");
    case "rejected":
      return deny("This version is already rejected.");
    case "superseded":
      return deny("A superseded version cannot be rejected.");
    default:
      return assertNeverState(current);
  }
}

function decideSupersede(current: PublicationLifecycleState): PublicationTransitionDecision {
  switch (current) {
    case "published":
      return allow("superseded");
    case "queued":
    case "processing":
    case "failed":
    case "ready_for_preview":
    case "rejected":
      return deny("Only a published version can be superseded.");
    case "superseded":
      return deny("This version is already superseded.");
    default:
      return assertNeverState(current);
  }
}

function decideReactivate(current: PublicationLifecycleState): PublicationTransitionDecision {
  switch (current) {
    case "superseded":
      return allow("published");
    case "queued":
    case "processing":
    case "failed":
      return deny("This version was never published, so there is nothing to roll back to.");
    case "ready_for_preview":
      return deny("This version has never been published; use publish instead of rollback.");
    case "published":
      return deny("This version is already published.");
    case "rejected":
      return deny("A rejected version cannot be reactivated.");
    default:
      return assertNeverState(current);
  }
}

// The one exhaustive switch every caller (RPCs' own SQL and the admin UI's button state) is
// written to match. Never takes a database row - only the two values a decision can possibly
// depend on.
export function decidePublicationTransition(
  current: PublicationLifecycleState,
  command: PublicationTransitionCommand,
): PublicationTransitionDecision {
  switch (command) {
    case "publish":
      return decidePublish(current);
    case "reject":
      return decideReject(current);
    case "supersede":
      return decideSupersede(current);
    case "reactivate":
      return decideReactivate(current);
    default:
      return assertNeverState(command);
  }
}

// Projects the two real, independent enums (public.ebook_asset_status pre-publication,
// public.publication_status once a publication row exists) into the one lifecycle an admin reads
// as a single continuous history. `publicationStatus` is authoritative whenever a publication
// exists - it is possible for `assetStatus` to still read 'ready_for_preview' while the
// publication itself has already moved on to 'published', 'rejected', or (later) 'superseded',
// since public.ebook_asset_status has no 'rejected' value to mirror that specific transition onto.
export function deriveLifecycleState(
  assetStatus: "uploading" | "queued" | "processing" | "ready_for_preview" | "failed" | "published" | "superseded",
  publicationStatus: PublicationLifecycleState | null,
): PublicationLifecycleState {
  if (publicationStatus) return publicationStatus;

  switch (assetStatus) {
    case "queued":
      return "queued";
    case "processing":
      return "processing";
    case "failed":
      return "failed";
    // 'uploading' cannot reach this page (Task 3's upload flow only links here once finalize has
    // queued a job); 'ready_for_preview', 'published', and 'superseded' with no publication row
    // is a data inconsistency complete_processing_job's own transaction never produces - both
    // fall back to 'processing' rather than asserting a specific, possibly wrong, lifecycle.
    case "uploading":
    case "ready_for_preview":
    case "published":
    case "superseded":
      return "processing";
    default:
      return assertNeverState(assetStatus);
  }
}
