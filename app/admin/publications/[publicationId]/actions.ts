"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { computeAlignmentsForBook } from "@/lib/data/alignments";
import { getRequestId } from "@/lib/observability/request-id";
import {
  CrossBookRollbackError,
  MissingRejectionReasonError,
  PublicationNotFoundError,
  PublicationNotReadyError,
  publishPublication,
  PublicationTransitionRejectedError,
  rejectPublication,
  rollbackPublication,
} from "@/lib/data/publications";

// Every runtime export below is an async function, on purpose - see Task 2's "use server"
// hazard: a plain-object or non-function export from a "use server" module typechecks, lints,
// and builds cleanly while crashing the client at request time. Only type exports are safe
// alongside them.

export type PublicationActionResult = { ok: true } | { ok: false; error: string };

// The four error types lib/data/publications.ts's three mutations can throw are all safe,
// specific messages an admin can act on directly - never a raw Supabase/Postgres error, which
// stays behind this generic fallback instead.
function toActionResult(error: unknown): PublicationActionResult {
  if (
    error instanceof PublicationNotFoundError ||
    error instanceof PublicationNotReadyError ||
    error instanceof PublicationTransitionRejectedError ||
    error instanceof CrossBookRollbackError ||
    error instanceof MissingRejectionReasonError
  ) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Something went wrong. Try again." };
}

// Pairs the newly live publication with the work's other editions, after the response is sent: the
// transition has committed, the admin never waits on a chunk-paging run, and a work without
// alignment simply has no compare. The request ID is read now, while the request is in scope.
async function alignBestEffort(bookId: string): Promise<void> {
  const requestId = getRequestId(await headers());
  after(async () => {
    try {
      await computeAlignmentsForBook(bookId);
    } catch (error) {
      console.error("Alignment after a publication change failed.", { bookId, requestId, error: String(error) });
    }
  });
}

// `assetId` is this page's own route param (app/admin/publications/[publicationId]/page.tsx -
// see lib/data/publications.ts's header comment on why that segment holds an ebook_asset id, not
// an ebook_publications id) - used only to redirect a lapsed session back to the right page and
// to revalidate it. The mutation itself always targets the real `publicationId`.
export async function publishPublicationAction(
  assetId: string,
  bookId: string,
  publicationId: string,
): Promise<PublicationActionResult> {
  await requireAdmin({ next: `/admin/publications/${assetId}` });

  try {
    await publishPublication(publicationId);
  } catch (error) {
    return toActionResult(error);
  }

  await alignBestEffort(bookId);

  revalidatePath(`/admin/publications/${assetId}`);
  // Fix round 1, Minor #5: `/admin/books` names no route - app/admin/ has only
  // books/[bookId]/, books/new/, and books/actions.ts. Publishing changes this book's own
  // page (its status and active version), so that is what needs to be revalidated.
  revalidatePath(`/admin/books/${bookId}`);
  revalidateStorefront();
  return { ok: true };
}

export async function rejectPublicationAction(
  assetId: string,
  publicationId: string,
  reason: string,
): Promise<PublicationActionResult> {
  await requireAdmin({ next: `/admin/publications/${assetId}` });

  try {
    await rejectPublication(publicationId, reason);
  } catch (error) {
    return toActionResult(error);
  }

  revalidatePath(`/admin/publications/${assetId}`);
  return { ok: true };
}

// `targetAssetId` is the version being rolled *back to* - a different asset from the page's own
// `assetId` whenever the admin is viewing the currently active version and choosing an older,
// superseded one to restore. Both are revalidated: the page the admin is looking at (whose
// version-history list needs to reflect the swap) and the version being restored (whose own
// lifecycle just changed from `superseded` back to `published`).
export async function rollbackPublicationAction(
  assetId: string,
  targetAssetId: string,
  bookId: string,
  publicationId: string,
): Promise<PublicationActionResult> {
  await requireAdmin({ next: `/admin/publications/${assetId}` });

  try {
    await rollbackPublication(bookId, publicationId);
  } catch (error) {
    return toActionResult(error);
  }
  await alignBestEffort(bookId);

  revalidatePath(`/admin/publications/${assetId}`);
  revalidatePath(`/admin/publications/${targetAssetId}`);
  // Fix round 1, Minor #5: see publishPublicationAction's comment above - `/admin/books` is not a
  // route.
  revalidatePath(`/admin/books/${bookId}`);
  revalidateStorefront();
  return { ok: true };
}
