"use server";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import { coverAltTextSchema, coverUploadSchema } from "@/lib/catalog/schemas";
import { CoverBookNotFoundError, createCoverUpload, finalizeCoverUpload } from "@/lib/data/covers";

export type CoverActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const generic = "Something went wrong saving the cover. Try again.";

export async function createCoverUploadAction(
  bookId: string,
  input: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<CoverActionResult<{ storageKey: string; path: string; token: string }>> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const parsed = coverUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a cover image." };

  try {
    return { ok: true, ...(await createCoverUpload(bookId, parsed.data)) };
  } catch (error) {
    return { ok: false, error: error instanceof CoverBookNotFoundError ? error.message : generic };
  }
}

export async function finalizeCoverUploadAction(
  bookId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<CoverActionResult<object>> {
  await requireAdmin({ next: `/admin/books/${bookId}` });

  const altText = coverAltTextSchema.safeParse(input.altText);
  if (!altText.success) return { ok: false, error: altText.error.issues[0]?.message ?? "Describe the cover." };

  try {
    await finalizeCoverUpload(bookId, { ...input, altText: altText.data });
  } catch (error) {
    return { ok: false, error: error instanceof CoverBookNotFoundError ? error.message : generic };
  }

  revalidateBookAdmin(bookId);
  return { ok: true };
}
