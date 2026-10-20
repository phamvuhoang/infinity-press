"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { authorImageAltTextSchema, authorImageSchema } from "@/lib/catalog/schemas";
import { AuthorNotFoundError, createAuthorImageUpload, finalizeAuthorImageUpload } from "@/lib/data/author-image";

export type AuthorImageActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const generic = "Something went wrong saving the portrait. Try again.";

export async function createAuthorImageUploadAction(
  authorId: string,
  input: { mimeType: string; sizeBytes: number },
): Promise<AuthorImageActionResult<{ storageKey: string; path: string; token: string }>> {
  await requireAdmin({ next: `/admin/authors/${authorId}` });

  const parsed = authorImageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a portrait." };

  try {
    return { ok: true, ...(await createAuthorImageUpload(authorId, parsed.data)) };
  } catch (error) {
    return { ok: false, error: error instanceof AuthorNotFoundError ? error.message : generic };
  }
}

export async function finalizeAuthorImageUploadAction(
  authorId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<AuthorImageActionResult<object>> {
  await requireAdmin({ next: `/admin/authors/${authorId}` });

  const altText = authorImageAltTextSchema.safeParse(input.altText);
  if (!altText.success) return { ok: false, error: altText.error.issues[0]?.message ?? "Describe the portrait." };

  try {
    await finalizeAuthorImageUpload(authorId, { ...input, altText: altText.data });
  } catch (error) {
    return { ok: false, error: error instanceof AuthorNotFoundError ? error.message : generic };
  }

  revalidatePath("/admin/authors");
  revalidatePath(`/admin/authors/${authorId}`);
  revalidateStorefront();
  return { ok: true };
}
