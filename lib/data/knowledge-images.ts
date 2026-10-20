import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import type { KnowledgeImageUploadInput } from "@/lib/catalog/schemas";
import { coverExtensionFor } from "@/lib/data/covers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Knowledge images live in the public covers bucket under
// knowledge/{ideas|articles}/{entityId}/{uuid}.{jpg|png|webp} - the one shape the image block
// schema accepts. No database row records them: the typed image block stores the key, alt text,
// width, and height, and that block is saved with the rest of the localization.

export class KnowledgeImageTargetNotFoundError extends Error {
  constructor() {
    super("This entry no longer exists.");
    this.name = "KnowledgeImageTargetNotFoundError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tables = { idea: "ideas", article: "articles" } as const;

// The key is minted here, never accepted from the client. Browser roles have no write policy on
// storage.objects, so the service role signs the short-lived upload - and only after the admin gate
// and the entry's own visibility check through the session client have both passed.
export async function createKnowledgeImageUpload(
  kind: "idea" | "article",
  entityId: string,
  input: KnowledgeImageUploadInput,
): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();
  if (!Object.hasOwn(tables, kind) || !uuidPattern.test(entityId)) throw new KnowledgeImageTargetNotFoundError();
  const table = tables[kind];

  const supabase = await createClient();
  const { data: entity, error } = await supabase.from(table).select("id").eq("id", entityId).maybeSingle();
  if (error) throw new Error("createKnowledgeImageUpload failed.");
  if (!entity) throw new KnowledgeImageTargetNotFoundError();

  const storageKey = `knowledge/${table}/${entityId}/${crypto.randomUUID()}.${coverExtensionFor(input.mimeType)}`;
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (signedError || !signed) throw new Error("createKnowledgeImageUpload failed.");

  return { storageKey, path: signed.path, token: signed.token };
}
