"use server";

import { requireAdmin } from "@/lib/auth/admin";
import {
  AssetNotAwaitingUploadError,
  createEpubUpload,
  EditionNotFoundError,
  EmptyEpubFileError,
  EpubTooLargeError,
  finalizeEpubUpload,
  InvalidChecksumError,
  InvalidEpubExtensionError,
  InvalidEpubMimeTypeError,
} from "@/lib/epub/upload";

// Every runtime export below is an async function, on purpose - a plain-object or non-function
// export from a "use server" module typechecks, lints, and builds cleanly while crashing the
// client at request time (see Task 2's report). Only type exports are safe alongside them,
// because those are erased at compile time.

export type CreateEpubUploadActionResult =
  | { ok: true; assetId: string; signedUpload: { path: string; token: string; signedUrl: string } }
  | { ok: false; error: string };

// Wraps createEpubUpload() for the upload form (components/admin/epub-upload-form.tsx): a Client
// Component cannot call server-only code directly, but it can invoke an exported "use server"
// function like this one. requireAdmin() runs again here, ahead of createEpubUpload()'s own gate
// - redundant against a single call, but this is the actual network-reachable entry point a
// browser can invoke, so it gets its own authorization boundary rather than relying solely on the
// one inside the library function it happens to call today.
export async function createEpubUploadAction(
  bookId: string,
  file: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<CreateEpubUploadActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  try {
    const result = await createEpubUpload({ bookId, ...file });
    return { ok: true, ...result };
  } catch (error) {
    // Validation and "no edition yet" failures are safe, specific messages for the admin to act
    // on. Anything else (RPC rejection, storage failure, unexpected shape) stays server-side -
    // the client only ever sees a generic message, never a raw Supabase/Postgres error.
    if (
      error instanceof InvalidEpubExtensionError ||
      error instanceof InvalidEpubMimeTypeError ||
      error instanceof EmptyEpubFileError ||
      error instanceof EpubTooLargeError ||
      error instanceof EditionNotFoundError
    ) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "Something went wrong preparing the upload. Try again." };
  }
}

export type FinalizeEpubUploadActionResult = { ok: true; jobId: string } | { ok: false; error: string };

// Wraps finalizeEpubUpload() the same way, once the browser has PUT the file's bytes to the
// signed target returned by createEpubUploadAction above. Takes `bookId` (unused by
// finalizeEpubUpload itself, which only needs the asset id) so requireAdmin() can redirect a
// session that expired mid-upload back to this book's page, the same way createEpubUploadAction
// does above - without it, a lapsed session bounced the admin to the default sign-in destination
// and lost the book page.
export async function finalizeEpubUploadAction(
  bookId: string,
  assetId: string,
  checksum: string,
): Promise<FinalizeEpubUploadActionResult> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  try {
    const { jobId } = await finalizeEpubUpload(assetId, checksum);
    return { ok: true, jobId };
  } catch (error) {
    if (error instanceof AssetNotAwaitingUploadError || error instanceof InvalidChecksumError) {
      return { ok: false, error: error.message };
    }
    return { ok: false, error: "Something went wrong finalizing the upload. Try again." };
  }
}
