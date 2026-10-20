import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET } from "@/lib/catalog/covers";
import type { CoverUploadInput } from "@/lib/catalog/schemas";
import { coverExtensionFor } from "@/lib/data/covers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The bundle counterpart of lib/data/covers.ts. It is a separate module rather than a second set
// of exports there because a bundle's cover has one rule a book's does not:
// admin_set_bundle_cover (20260924120000) refuses a key whose object is not already in the covers
// bucket, so the upload must land BEFORE the finalize call, never the other way round.

export class CoverBundleNotFoundError extends Error {
  constructor() {
    super("This bundle no longer exists.");
    this.name = "CoverBundleNotFoundError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The storage key is minted here, never accepted from the client, and its shape is the one
// admin_set_bundle_cover validates: bundles/{bundleId}/{uuid}.{jpg|png|webp}. Browser roles have
// no write policy on storage.objects, so the service role mints the short-lived upload
// reservation - only after the admin gate and the bundle's own visibility check have passed.
export async function createBundleCoverUpload(
  bundleId: string,
  input: CoverUploadInput,
): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();
  if (!uuidPattern.test(bundleId)) throw new CoverBundleNotFoundError();

  const supabase = await createClient();
  const { data: bundle, error } = await supabase.from("bundles").select("id").eq("id", bundleId).maybeSingle();
  if (error) throw new Error(`createBundleCoverUpload: failed to load bundle: ${error.message}`);
  if (!bundle) throw new CoverBundleNotFoundError();

  const storageKey = `bundles/${bundleId}/${crypto.randomUUID()}.${coverExtensionFor(input.mimeType)}`;
  const admin = createAdminClient();
  const { data: signed, error: signedError } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (signedError || !signed) {
    throw new Error(`createBundleCoverUpload: failed to sign upload: ${signedError?.message ?? "no data"}`);
  }

  return { storageKey, path: signed.path, token: signed.token };
}

// Call this only once the upload has landed: admin_set_bundle_cover raises P0002 when the object
// named by the key is not in the covers bucket yet.
export async function finalizeBundleCoverUpload(
  bundleId: string,
  input: { storageKey: string; altText: string; width: number | null; height: number | null },
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(bundleId)) throw new CoverBundleNotFoundError();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_bundle_cover", {
    p_bundle_id: bundleId,
    p_storage_key: input.storageKey,
    p_alt_text: input.altText,
    p_width: input.width,
    p_height: input.height,
  });
  if (!error) return;
  // P0002 covers both "the bundle is gone" and "the object never landed"; either way the operator
  // retries the upload rather than reading a database sentence.
  if (error.code === "P0002") throw new CoverBundleNotFoundError();
  throw new Error("finalizeBundleCoverUpload failed.");
}

// media_assets.storage_key is withheld from every browser role by the column grant in
// 20260913100000, so the admin editor's cover preview reads it here with the service role, after
// the admin gate - never through the session client.
export async function readBundleCover(bundleId: string): Promise<{ storageKey: string; altText: string } | null> {
  await requireAdmin();
  if (!uuidPattern.test(bundleId)) return null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("media_assets")
    .select("storage_key, alt_text")
    .eq("owner_type", "bundle")
    .eq("owner_id", bundleId)
    .eq("kind", "cover")
    .maybeSingle();

  if (error) throw new Error(`readBundleCover: failed to load cover: ${error.message}`);
  if (!data) return null;
  return { storageKey: data.storage_key, altText: data.alt_text };
}
