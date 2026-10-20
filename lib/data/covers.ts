import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import type { CoverUploadInput } from "@/lib/catalog/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export class CoverBookNotFoundError extends Error {
  constructor() {
    super("This book no longer exists.");
    this.name = "CoverBookNotFoundError";
  }
}

const extensions: Record<CoverUploadInput["mimeType"], "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function coverExtensionFor(mimeType: CoverUploadInput["mimeType"]) {
  return extensions[mimeType];
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The storage key is minted here, never accepted from the client. Browser roles have no write
// policy on storage.objects, so the service role is used only after the admin and visibility gates
// to mint its short-lived upload reservation.
export async function createCoverUpload(
  bookId: string,
  input: CoverUploadInput,
): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) throw new CoverBookNotFoundError();

  const supabase = await createClient();
  const { data: book, error } = await supabase.from("books").select("id").eq("id", bookId).maybeSingle();
  if (error) throw new Error(`createCoverUpload: failed to load book: ${error.message}`);
  if (!book) throw new CoverBookNotFoundError();

  const storageKey = `books/${bookId}/${crypto.randomUUID()}.${coverExtensionFor(input.mimeType)}`;
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (signedError || !signed) {
    throw new Error(`createCoverUpload: failed to sign upload: ${signedError?.message ?? "no data"}`);
  }

  return { storageKey, path: signed.path, token: signed.token };
}

// admin_set_book_cover constrains the supplied key to this book and atomically replaces its cover.
export async function finalizeCoverUpload(
  bookId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) throw new CoverBookNotFoundError();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_cover", {
    p_book_id: bookId,
    p_storage_key: input.storageKey,
    p_alt_text: input.altText,
    p_width: input.width,
    p_height: input.height,
  });
  if (error) throw new Error(`finalizeCoverUpload failed: ${error.message}`);
}
