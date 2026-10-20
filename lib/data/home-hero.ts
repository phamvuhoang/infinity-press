import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { COVERS_BUCKET, coverPublicUrl } from "@/lib/catalog/covers";
import type { HeroUploadInput } from "@/lib/catalog/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type HomeHeroDTO = { desktopUrl: string; mobileUrl: string; altText: string };

const extensions = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

// The key is minted here, never accepted from the client, and always lands under home/hero/ so
// admin_set_home_hero can prove it belongs to this slot.
export async function createHeroUpload(input: HeroUploadInput): Promise<{ storageKey: string; path: string; token: string }> {
  await requireAdmin();

  const storageKey = `home/hero/${crypto.randomUUID()}.${extensions[input.mimeType]}`;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(COVERS_BUCKET).createSignedUploadUrl(storageKey);
  if (error || !data) throw new Error(`createHeroUpload: failed to sign upload: ${error?.message ?? "no data"}`);

  return { storageKey, path: data.path, token: data.token };
}

export async function setHomeHero(input: { desktopKey: string; mobileKey: string; altText: string }): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_home_hero", {
    p_desktop_key: input.desktopKey,
    p_mobile_key: input.mobileKey,
    p_alt_text: input.altText,
  });
  if (error) throw new Error(`setHomeHero failed: ${error.message}`);
}

export async function clearHomeHero(): Promise<void> {
  await requireAdmin();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_clear_home_hero");
  if (error) throw new Error(`clearHomeHero failed: ${error.message}`);
}

// The admin page reads the row under RLS, not through the public function, so it keeps showing the
// current image even while the storefront cache is stale.
export async function getHomeHeroForAdmin(): Promise<HomeHeroDTO | null> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("home_hero")
    .select("desktop_storage_key, mobile_storage_key, alt_text")
    .maybeSingle();
  if (error) throw new Error("getHomeHeroForAdmin failed.");
  if (!data) return null;

  const row = data as { desktop_storage_key: string; mobile_storage_key: string; alt_text: string };
  return {
    desktopUrl: coverPublicUrl(row.desktop_storage_key),
    mobileUrl: coverPublicUrl(row.mobile_storage_key),
    altText: row.alt_text,
  };
}
