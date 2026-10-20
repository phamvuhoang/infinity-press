"use server";

import { requireAdmin } from "@/lib/auth/admin";
import { revalidateBundleAdmin } from "@/lib/catalog/revalidate";
import { bundleCoverAltTextSchema, coverUploadSchema } from "@/lib/catalog/schemas";
import { CoverBundleNotFoundError, createBundleCoverUpload, finalizeBundleCoverUpload } from "@/lib/data/bundle-covers";

// Two steps, and the order between them is load-bearing: admin_set_bundle_cover refuses a key
// whose object is not in the covers bucket yet, so the browser uploads to the signed URL returned
// by the first action and only then calls the second.

export type BundleCoverActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const generic = "Something went wrong saving the cover. Try again.";

export async function createBundleCoverUploadAction(
  bundleId: string,
  input: { fileName: string; mimeType: string; sizeBytes: number },
): Promise<BundleCoverActionResult<{ storageKey: string; path: string; token: string }>> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });

  const parsed = coverUploadSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Choose a cover image." };

  try {
    return { ok: true, ...(await createBundleCoverUpload(bundleId, parsed.data)) };
  } catch (error) {
    return { ok: false, error: error instanceof CoverBundleNotFoundError ? error.message : generic };
  }
}

export async function finalizeBundleCoverUploadAction(
  bundleId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<BundleCoverActionResult<object>> {
  await requireAdmin({ next: `/admin/bundles/${bundleId}` });

  const altText = bundleCoverAltTextSchema.safeParse(input.altText);
  if (!altText.success) return { ok: false, error: altText.error.issues[0]?.message ?? "Describe the cover." };

  try {
    await finalizeBundleCoverUpload(bundleId, { ...input, altText: altText.data });
  } catch (error) {
    return { ok: false, error: error instanceof CoverBundleNotFoundError ? error.message : generic };
  }

  revalidateBundleAdmin(bundleId);
  return { ok: true };
}
