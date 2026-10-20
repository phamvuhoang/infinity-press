"use server";

import { requireAdmin } from "@/lib/auth/admin";
import { knowledgeImageUploadSchema } from "@/lib/catalog/schemas";
import { createKnowledgeImageUpload, KnowledgeImageTargetNotFoundError } from "@/lib/data/knowledge-images";

// Reserves a signed upload for one knowledge image. There is no finalize step: the browser uploads
// to the signed URL, measures the image, and inserts a typed image block holding the returned key,
// which is saved - and validated again - with the rest of the localization.

export type KnowledgeImageUploadResult = { ok: true; storageKey: string; path: string; token: string } | { ok: false; error: string };

const generic = "Something went wrong preparing the upload. Try again.";

export async function createKnowledgeImageUploadAction(
  kind: "idea" | "article",
  entityId: string,
  input: { fileName?: string; mimeType: string; sizeBytes: number },
): Promise<KnowledgeImageUploadResult> {
  await requireAdmin({ next: `/admin/${kind === "article" ? "articles" : "ideas"}/${entityId}` });

  const parsed = knowledgeImageUploadSchema.safeParse({ mimeType: input?.mimeType, sizeBytes: input?.sizeBytes });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose an image." };

  try {
    const { storageKey, path, token } = await createKnowledgeImageUpload(kind, entityId, parsed.data);
    return { ok: true, storageKey, path, token };
  } catch (error) {
    return { ok: false, error: error instanceof KnowledgeImageTargetNotFoundError ? error.message : generic };
  }
}
