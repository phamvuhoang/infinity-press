export const COVERS_BUCKET = "covers";

// Covers live in the only public bucket (20260913100000), so their URL is a stable, unsigned
// object URL. EPUB buckets stay private and never go through this helper.
export function coverPublicUrl(storageKey: string, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  return `${base}/storage/v1/object/public/${COVERS_BUCKET}/${storageKey}`;
}
