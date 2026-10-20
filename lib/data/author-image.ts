import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET, coverPublicUrl } from "@/lib/catalog/covers";
import type { AuthorImageInput } from "@/lib/catalog/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export class AuthorNotFoundError extends Error {
  constructor() {
    super("This author no longer exists.");
    this.name = "AuthorNotFoundError";
  }
}

const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mirrors createCoverUpload: the key is minted here, scoped to this author, and the service role is
// only reached after the admin gate.
export async function createAuthorImageUpload(
  authorId: string,
  input: AuthorImageInput,
): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();
  if (!uuidPattern.test(authorId)) throw new AuthorNotFoundError();

  const supabase = await createClient();
  const { data: author, error } = await supabase.from("authors").select("id").eq("id", authorId).maybeSingle();
  if (error) throw new Error(`createAuthorImageUpload: failed to load author: ${error.message}`);
  if (!author) throw new AuthorNotFoundError();

  const storageKey = `authors/${authorId}/${crypto.randomUUID()}.${extensions[input.mimeType]}`;
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (signedError || !signed) {
    throw new Error(`createAuthorImageUpload: failed to sign upload: ${signedError?.message ?? "no data"}`);
  }

  return { storageKey, path: signed.path, token: signed.token };
}

export async function finalizeAuthorImageUpload(
  authorId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(authorId)) throw new AuthorNotFoundError();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_author_image", {
    p_author_id: authorId,
    p_storage_key: input.storageKey,
    p_alt_text: input.altText,
    p_width: input.width,
    p_height: input.height,
  });
  if (error) throw new Error(`finalizeAuthorImageUpload failed: ${error.message}`);
}

// media_assets.storage_key is not readable through the table, so the editor reads its current
// portrait through the narrow admin function.
export async function getAuthorImage(authorId: string): Promise<{ publicUrl: string; altText: string } | null> {
  await requireAdmin();
  if (!uuidPattern.test(authorId)) return null;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_get_author_image", { p_author_id: authorId });
  if (error) throw new Error("getAuthorImage failed.");

  const row = ((data ?? []) as { storage_key: string; alt_text: string }[])[0];
  return row ? { publicUrl: coverPublicUrl(row.storage_key), altText: row.alt_text } : null;
}
