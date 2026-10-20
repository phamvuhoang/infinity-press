import "server-only";

import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import { EPUB_MIME_TYPE, MAX_EPUB_SIZE_BYTES } from "@/lib/epub/constants";
import { getRequestId } from "@/lib/observability/request-id";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export { EPUB_MIME_TYPE, MAX_EPUB_SIZE_BYTES };
export const EBOOK_SOURCE_BUCKET = "ebook-source";

export class InvalidEpubExtensionError extends Error {
  constructor() {
    super("The selected file must have a .epub extension.");
    this.name = "InvalidEpubExtensionError";
  }
}

export class InvalidEpubMimeTypeError extends Error {
  constructor() {
    super(`The selected file must be ${EPUB_MIME_TYPE}.`);
    this.name = "InvalidEpubMimeTypeError";
  }
}

export class EmptyEpubFileError extends Error {
  constructor() {
    super("The selected file is empty.");
    this.name = "EmptyEpubFileError";
  }
}

export class EpubTooLargeError extends Error {
  constructor() {
    super("The selected file exceeds the 100 MiB limit.");
    this.name = "EpubTooLargeError";
  }
}

export class EditionNotFoundError extends Error {
  constructor() {
    super("This book has no edition to attach an EPUB to yet.");
    this.name = "EditionNotFoundError";
  }
}

// admin_finalize_ebook_asset rejects a call whose asset is not currently 'uploading' - either it
// was already finalized (a stale retry after a response the client never saw) or the asset id is
// wrong. Either way this is safe to surface as a plain message: it never repeats the underlying
// Postgres text (see finalizeEpubUpload below).
export class AssetNotAwaitingUploadError extends Error {
  constructor() {
    super("This upload was already finalized or the asset id is invalid.");
    this.name = "AssetNotAwaitingUploadError";
  }
}

// Not an integrity gate (spec 4.3 keeps checksum verification in the processing worker, which
// reads the source object directly) - just hygiene on an otherwise-unbounded `text` parameter
// that flows straight into a database column, matching the shape a caller is always expected to
// produce (a hex-encoded SHA-256 digest, as components/admin/epub-upload-form.tsx computes).
export class InvalidChecksumError extends Error {
  constructor() {
    super("checksum must be a 64-character hex-encoded SHA-256 digest.");
    this.name = "InvalidChecksumError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256HexPattern = /^[0-9a-f]{64}$/i;

// Client-side validation (components/admin/epub-upload-form.tsx) is a convenience only - this is
// the boundary that actually rejects a bad upload. Checked after requireAdmin() but before any DB
// or storage call: a request that fails validation should never construct a client at all, but it
// also should never learn the acceptance criteria before it has proven it is an admin.
function validateEpubFile(input: { fileName: string; mimeType: string; sizeBytes: number }): void {
  if (!input.fileName.toLowerCase().endsWith(".epub")) {
    throw new InvalidEpubExtensionError();
  }
  if (input.mimeType !== EPUB_MIME_TYPE) {
    throw new InvalidEpubMimeTypeError();
  }
  if (input.sizeBytes <= 0) {
    throw new EmptyEpubFileError();
  }
  if (input.sizeBytes > MAX_EPUB_SIZE_BYTES) {
    throw new EpubTooLargeError();
  }
}

export type CreateEpubUploadInput = {
  bookId: string;
  editionId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type CreateEpubUploadResult = {
  assetId: string;
  signedUpload: { path: string; token: string; signedUrl: string };
};

// The reservation RPC's row shape, as returned by `.rpc()` for a `returns table (...)` function -
// PostgREST hands back an array of rows.
type ReserveEbookAssetRow = { asset_id: string; storage_key: string; version: number };

// Reserves a private-storage upload slot for one edition's next EPUB asset version, and returns a
// signed upload target the browser can PUT bytes to directly.
//
// Which edition: the caller names it explicitly. `bookId` is the work the admin page was opened for;
// the lookup requires the edition to belong to that work, so an edition id from another work (or a
// stale form) is refused instead of being uploaded against. Nothing here ever picks an edition for
// the caller: with several language editions per work, "the first one" would be the wrong book.
//
// Ruling AD / Ruling AE: requireAdmin() gates everything below it - it runs first, ahead of even
// the (cheap, side-effect-free) input validation, matching the brief's own step order and every
// other authorization boundary in this codebase (lib/data/books.ts, lib/data/admin.ts): the gate
// is unconditional, not "unless the input looks malformed anyway". The edition lookup and the
// admin_reserve_ebook_asset RPC both go through the authenticated session client (Ruling AE -
// the RPC checks is_admin() via auth.uid(), which is null under service-role). Only the signed
// upload token comes from the service-role client (Ruling AD - browser roles have no write access
// to the private bucket, so a policy can't express this), and that client is never constructed
// until requireAdmin() has already returned and the reservation has already succeeded.
export async function createEpubUpload(input: CreateEpubUploadInput): Promise<CreateEpubUploadResult> {
  await requireAdmin();

  validateEpubFile(input);

  const supabase = await createClient();

  const { data: edition, error: editionError } = await supabase
    .from("editions")
    .select("id")
    .eq("id", input.editionId)
    .eq("book_id", input.bookId)
    .maybeSingle();

  if (editionError) {
    throw new Error(`createEpubUpload: failed to resolve edition ${input.editionId}: ${editionError.message}`);
  }
  if (!edition || typeof edition !== "object" || !("id" in edition)) {
    throw new EditionNotFoundError();
  }
  const editionId = (edition as { id: string }).id;

  const { data: reserved, error: reserveError } = await supabase.rpc("admin_reserve_ebook_asset", {
    p_edition_id: editionId,
  });

  if (reserveError) {
    throw new Error(`createEpubUpload: admin_reserve_ebook_asset failed: ${reserveError.message}`);
  }
  const reservation = (reserved as ReserveEbookAssetRow[] | null)?.[0];
  if (!reservation) {
    throw new Error("createEpubUpload: admin_reserve_ebook_asset returned no reservation");
  }

  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage
    .from(EBOOK_SOURCE_BUCKET)
    .createSignedUploadUrl(reservation.storage_key);

  if (signedError || !signed) {
    throw new Error(
      `createEpubUpload: failed to mint a signed upload url: ${signedError?.message ?? "no data returned"}`,
    );
  }

  return {
    assetId: reservation.asset_id,
    signedUpload: { path: signed.path, token: signed.token, signedUrl: signed.signedUrl },
  };
}

function isUuid(value: string): boolean {
  return uuidPattern.test(value);
}

// Finalizes a reserved upload once the browser has PUT the bytes to its signed target: records
// the caller-reported checksum, moves the asset from 'uploading' to 'queued', and creates the one
// processing_jobs row the Task 5 CLI worker will later claim - all inside admin_finalize_ebook_
// asset's single statement, so a failure here never leaves a finalized asset with no job or a job
// with no finalized asset.
//
// This does not re-verify the uploaded bytes against `checksum` - it is provenance recorded by
// the trusted admin caller, not a verified integrity gate. The processing worker (Task 5) reads
// the source object directly and is where corrupt or tampered bytes actually get caught.
//
// Ruling AE: goes through the authenticated session client, never service-role - same reason as
// the reservation RPC above.
export async function finalizeEpubUpload(assetId: string, checksum: string): Promise<{ jobId: string }> {
  await requireAdmin();

  if (!isUuid(assetId)) {
    throw new Error("finalizeEpubUpload: assetId is not a valid identifier");
  }
  if (!sha256HexPattern.test(checksum)) {
    throw new InvalidChecksumError();
  }

  const correlationId = getRequestId(await headers());

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_finalize_ebook_asset", {
    p_asset_id: assetId,
    p_checksum: checksum,
    p_correlation_id: correlationId,
  });

  if (error) {
    // admin_finalize_ebook_asset raises P0002, specifically, when its `where status =
    // 'uploading'` guard matches no row - the asset was already finalized or the id is wrong.
    // Anything else (network failure, an unexpected shape) stays a generic error rather than
    // being guessed into a misleading "already finalized" message - the same discrimination
    // duplicateFieldErrorFor() (lib/data/books.ts) applies to admin_create_ebook's 23505s.
    if (error.code === "P0002") {
      throw new AssetNotAwaitingUploadError();
    }
    throw new Error(`finalizeEpubUpload: admin_finalize_ebook_asset failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("finalizeEpubUpload: admin_finalize_ebook_asset returned no job id");
  }

  return { jobId: data };
}
