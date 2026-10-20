import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { parsePublicationReadinessError, publicationIssueMessage } from "@/lib/catalog/readiness";
import { deriveLifecycleState, type PublicationLifecycleState } from "@/lib/publishing/state";
import { createClient } from "@/lib/supabase/server";

// This DAL's route param and the RPCs it calls both key off two different ids, on purpose:
//
// - The admin route (app/admin/publications/[publicationId]/page.tsx) is keyed by the ebook_asset
//   id, not an ebook_publications id. An admin needs a stable link to "this upload's status" from
//   the moment finalizeEpubUpload() queues a job (components/admin/epub-upload-form.tsx) - long
//   before any ebook_publications row exists. ebook_publications.ebook_asset_id carries a unique
//   constraint (20260911090000_mvp_catalog_publishing.sql), so once processing completes, that
//   same asset id still resolves to exactly one publication - getPublicationOverview() below
//   accepts the asset id and projects both the pre-publication (queued/processing/failed) and
//   post-publication (ready_for_preview/published/rejected/superseded) states onto one
//   PublicationLifecycleState (lib/publishing/state.ts's deriveLifecycleState()).
// - publishPublication/rejectPublication/rollbackPublication, matching the brief's own interface
//   list, take the actual ebook_publications id - the RPCs they call only ever operate on rows
//   that already exist in that table.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TocNode = { title: string; href: string; children: TocNode[] };

export type PublicationResourceDTO = {
  href: string;
  mediaType: string;
  accessClass: "paid" | "sample";
};

export type PublicationJobDTO = {
  attempt: number;
  correlationId: string;
  errorCode: string | null;
  errorMessage: string | null;
};

export type PublicationOverviewDTO = {
  assetId: string;
  bookId: string;
  bookTitle: string;
  editionId: string;
  version: number;
  lifecycle: PublicationLifecycleState;
  job: PublicationJobDTO | null;
  publicationId: string | null;
  isActivePublication: boolean;
  resources: PublicationResourceDTO[];
  // Ruling AY carried forward: an empty array here is indistinguishable from "this EPUB's nav/NCX
  // could not be parsed" (both produce toc_json: []). Callers must not render this as "this book
  // has no table of contents" - see components/admin/publication-preview.tsx.
  toc: TocNode[];
};

type EditionRow = {
  id: string;
  book_id: string;
  active_publication_id: string | null;
  books: {
    id: string;
    book_localizations: { locale: string; slug: string; title: string }[];
  } | null;
};

// The admin's full-lifecycle view of one upload: pre-publication job status (queued/processing/
// failed), and - once processing has completed - the resulting publication's own status, its
// listed resources (hrefs and media types only; never a storage_key - see
// resolvePreviewResourceStorageKey below for the one place those are read), and its table of
// contents. Reads through the authenticated session client, never the service-role client: this
// task's migration adds is_admin()-gated admin-read policies to every publishing table this
// touches (ebook_assets, processing_jobs, ebook_publications, ebook_resources), the same "is this
// expressible as a policy" call Ruling AP made for the catalog tables - a table read is not one of
// the genuinely inexpressible cases service-role exists for.
export async function getPublicationOverview(assetId: string): Promise<PublicationOverviewDTO> {
  await requireAdmin();

  if (!uuidPattern.test(assetId)) {
    notFound();
  }

  const supabase = await createClient();

  const { data: asset, error: assetError } = await supabase
    .from("ebook_assets")
    .select("id, edition_id, version, status")
    .eq("id", assetId)
    .maybeSingle();

  if (assetError) {
    throw new Error(`getPublicationOverview: failed to load asset ${assetId}: ${assetError.message}`);
  }
  if (!asset) {
    notFound();
  }

  const { data: edition, error: editionError } = await supabase
    .from("editions")
    .select("id, book_id, active_publication_id, books ( id, book_localizations ( locale, slug, title ) )")
    .eq("id", asset.edition_id)
    .maybeSingle()
    .overrideTypes<EditionRow, { merge: false }>();

  if (editionError) {
    throw new Error(`getPublicationOverview: failed to load edition ${asset.edition_id}: ${editionError.message}`);
  }
  if (!edition || !edition.books) {
    throw new Error(`getPublicationOverview: asset ${assetId} has no resolvable book`);
  }

  const { data: jobRow, error: jobError } = await supabase
    .from("processing_jobs")
    .select("attempt, correlation_id, error_code, error_message")
    .eq("target_id", assetId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (jobError) {
    throw new Error(`getPublicationOverview: failed to load processing job for ${assetId}: ${jobError.message}`);
  }

  const { data: publication, error: publicationError } = await supabase
    .from("ebook_publications")
    .select("id, status, toc_json")
    .eq("ebook_asset_id", assetId)
    .maybeSingle();

  if (publicationError) {
    throw new Error(`getPublicationOverview: failed to load publication for ${assetId}: ${publicationError.message}`);
  }

  let resources: PublicationResourceDTO[] = [];
  if (publication) {
    const { data: resourceRows, error: resourcesError } = await supabase
      .from("ebook_resources")
      .select("href, media_type, access_class")
      .eq("publication_id", publication.id)
      .order("href", { ascending: true });

    if (resourcesError) {
      throw new Error(
        `getPublicationOverview: failed to load resources for publication ${publication.id}: ${resourcesError.message}`,
      );
    }
    resources = (resourceRows ?? []).map((row) => ({
      href: row.href,
      mediaType: row.media_type,
      accessClass: row.access_class as "paid" | "sample",
    }));
  }

  const localization = edition.books.book_localizations[0] ?? null;

  return {
    assetId: asset.id,
    bookId: edition.book_id,
    bookTitle: localization?.title ?? edition.book_id,
    editionId: edition.id,
    version: asset.version,
    lifecycle: deriveLifecycleState(asset.status, (publication?.status as PublicationLifecycleState) ?? null),
    job: jobRow
      ? {
          attempt: jobRow.attempt,
          correlationId: jobRow.correlation_id,
          errorCode: jobRow.error_code,
          errorMessage: jobRow.error_message,
        }
      : null,
    publicationId: publication?.id ?? null,
    // The edition's own pointer: another language's live publication never makes this one active.
    isActivePublication: Boolean(publication && edition.active_publication_id === publication.id),
    resources,
    toc: (publication?.toc_json as TocNode[] | null) ?? [],
  };
}

export type PublicationVersionSummaryDTO = {
  assetId: string;
  version: number;
  publicationId: string | null;
  lifecycle: PublicationLifecycleState;
};

// The book's full version history for one edition (MVP ships exactly one edition per book), so
// the admin UI can offer "roll back to this version" for any version whose lifecycle is
// `superseded` - rollback_publication accepts only that status
// (20260911180000_publication_transition_rpcs.sql), so this is what the button-enablement
// mirrors, not a separate rule. Kept apart from getPublicationOverview() above (which returns
// exactly one version's detail) rather than folding history into every overview call - a page
// that only needs the current version's status never pays for the extra queries.
export async function getPublicationVersionHistory(editionId: string): Promise<PublicationVersionSummaryDTO[]> {
  await requireAdmin();

  // Fix round 1, Minor #12: matches getPublicationOverview's guard above. Safe today only because
  // the value comes from that DTO's own editionId field, never directly from a route param - this
  // is a library boundary with its own contract, not code that trusts its one current caller.
  if (!uuidPattern.test(editionId)) {
    notFound();
  }

  const supabase = await createClient();

  const { data: assetRows, error: assetsError } = await supabase
    .from("ebook_assets")
    .select("id, version, status")
    .eq("edition_id", editionId)
    .order("version", { ascending: false });

  if (assetsError) {
    throw new Error(`getPublicationVersionHistory: failed to load assets for ${editionId}: ${assetsError.message}`);
  }

  const assetIds = (assetRows ?? []).map((row) => row.id);
  // `.in()` with an empty array is rejected by PostgREST as malformed, not "no rows" - guard with
  // a sentinel that can never match a real id rather than skip-and-branch around it.
  const { data: publicationRows, error: publicationsError } = await supabase
    .from("ebook_publications")
    .select("id, status, ebook_asset_id")
    .in("ebook_asset_id", assetIds.length > 0 ? assetIds : ["00000000-0000-0000-0000-000000000000"]);

  if (publicationsError) {
    throw new Error(
      `getPublicationVersionHistory: failed to load publications for edition ${editionId}: ${publicationsError.message}`,
    );
  }

  const publicationByAssetId = new Map(
    (publicationRows ?? []).map((row) => [row.ebook_asset_id as string, row]),
  );

  return (assetRows ?? []).map((asset) => {
    const publication = publicationByAssetId.get(asset.id);
    return {
      assetId: asset.id,
      version: asset.version,
      publicationId: publication?.id ?? null,
      lifecycle: deriveLifecycleState(asset.status, (publication?.status as PublicationLifecycleState) ?? null),
    };
  });
}

// publish_publication/reject_publication/rollback_publication raise these custom SQLSTATEs
// (EB002/EB003/EB004; 20260911180000_publication_transition_rpcs.sql) for exactly the cases
// below; every other Postgres error stays a generic, non-specific Error rather than being
// guessed into one of these.
export class PublicationNotFoundError extends Error {
  constructor() {
    super("This publication no longer exists.");
    this.name = "PublicationNotFoundError";
  }
}

// publish_publication refused (EB012): the publication is not ready, with the codes that say why.
export class PublicationNotReadyError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.map((issue) => publicationIssueMessage[issue]).join(" ") || "This version is not ready to publish.");
    this.name = "PublicationNotReadyError";
    this.issues = issues;
  }
}

export class PublicationTransitionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationTransitionRejectedError";
  }
}

export class CrossBookRollbackError extends Error {
  constructor() {
    super("That version does not belong to this book.");
    this.name = "CrossBookRollbackError";
  }
}

export class MissingRejectionReasonError extends Error {
  constructor() {
    super("A reason is required to reject this version.");
    this.name = "MissingRejectionReasonError";
  }
}

// Ruling R: goes through the authenticated session client - publish_publication's own is_admin()
// check resolves through auth.uid(), null under service_role.
export async function publishPublication(publicationId: string): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_publication", { p_publication_id: publicationId });

  if (error) {
    if (error.code === "P0002") throw new PublicationNotFoundError();
    if (error.code === "EB002") {
      throw new PublicationTransitionRejectedError("This version cannot be published in its current state.");
    }
    if (error.code === "EB012") throw new PublicationNotReadyError(parsePublicationReadinessError(error.message) ?? []);
    throw new Error(`publishPublication: publish_publication failed: ${error.message}`);
  }
}

export async function rejectPublication(publicationId: string, reason: string): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_publication", {
    p_publication_id: publicationId,
    p_reason: reason,
  });

  if (error) {
    if (error.code === "P0002") throw new PublicationNotFoundError();
    if (error.code === "EB004") throw new MissingRejectionReasonError();
    if (error.code === "EB002") {
      throw new PublicationTransitionRejectedError("This version cannot be rejected in its current state.");
    }
    throw new Error(`rejectPublication: reject_publication failed: ${error.message}`);
  }
}

export async function rollbackPublication(bookId: string, publicationId: string): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("rollback_publication", {
    p_book_id: bookId,
    p_publication_id: publicationId,
  });

  if (error) {
    if (error.code === "P0002") throw new PublicationNotFoundError();
    if (error.code === "EB003") throw new CrossBookRollbackError();
    if (error.code === "EB002") {
      throw new PublicationTransitionRejectedError("This version is not eligible for rollback.");
    }
    throw new Error(`rollbackPublication: rollback_publication failed: ${error.message}`);
  }
}

export class PreviewResourceNotFoundError extends Error {
  constructor() {
    super("This resource was not found for the requested publication.");
    this.name = "PreviewResourceNotFoundError";
  }
}

// The only place a preview storage key is ever resolved. Ruling AM: the caller (app/api/admin/
// publications/[publicationId]/resources/[...href]/route.ts) never supplies a storage key
// itself - only a publicationId and an href, both scoped into this one query's WHERE clause, so a
// resource row can only ever be returned if it genuinely belongs to the named publication.
// Requesting a real href against the wrong publicationId (or a href that doesn't exist at all)
// resolves no row, rejected the same way as a href that was never a real resource - there is no
// path from an arbitrary request to an arbitrary object in the ebook-derived bucket.
//
// requireAdmin() gates this too, ahead of even the read through the session client - redundant
// against a caller that already gated at the route handler, but this is a library function with
// its own contract, not code that trusts its one current caller to always gate first.
export async function resolvePreviewResourceStorageKey(
  publicationId: string,
  href: string,
): Promise<{ storageKey: string; mediaType: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("ebook_resources")
    .select("storage_key, media_type")
    .eq("publication_id", publicationId)
    .eq("href", href)
    .maybeSingle();

  if (error) {
    throw new Error(`resolvePreviewResourceStorageKey: failed to resolve ${href} for ${publicationId}: ${error.message}`);
  }
  if (!data) {
    throw new PreviewResourceNotFoundError();
  }

  return { storageKey: data.storage_key, mediaType: data.media_type };
}
