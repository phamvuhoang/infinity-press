import { createServiceRoleClient } from "./supabase";

// Specs that build a one-language work need its single edition: grants, uploads and the reader are
// all per edition. A work with several editions must name one explicitly, so this refuses to guess.
export async function soleEditionId(bookId: string): Promise<string> {
  const { data, error } = await createServiceRoleClient().from("editions").select("id").eq("book_id", bookId);
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`expected exactly one edition for book ${bookId}, found ${data?.length ?? 0}`);
  return data[0].id;
}

// Adds a second published edition (with a live publication and its offers) to a seeded work, through
// the service role. Offers are [market, currency, priceMinor]. Local stack only.
export async function addPublishedEdition(
  bookId: string,
  language: string,
  suffix: string,
  offers: [string, string, number][],
  localizedTitle?: string,
): Promise<{ editionId: string; publicationId: string; offerIds: string[] }> {
  const service = createServiceRoleClient();
  const must = <T>(result: { data: T; error: { message: string } | null }): NonNullable<T> => {
    if (result.error || result.data === null) throw new Error(result.error?.message ?? "empty result");
    return result.data as NonNullable<T>;
  };
  if (localizedTitle) {
    must(
      await service
        .from("book_localizations")
        .upsert({ book_id: bookId, locale: language, slug: `ed-${language}-${suffix}`, title: localizedTitle }, { onConflict: "book_id,locale" })
        .select("book_id")
        .single(),
    );
  }
  const edition = must(await service.from("editions").insert({ book_id: bookId, language_code: language }).select("id").single());
  const asset = must(
    await service
      .from("ebook_assets")
      .insert({ edition_id: edition.id, source_storage_key: `e2e/${suffix}/${language}.epub`, version: 1, status: "published" })
      .select("id")
      .single(),
  );
  const publication = must(
    await service
      .from("ebook_publications")
      .insert({ ebook_asset_id: asset.id, version: 1, manifest_key: `e2e/${suffix}/${language}.json`, status: "published", epub_language: language })
      .select("id")
      .single(),
  );
  const sku = must(await service.from("skus").insert({ edition_id: edition.id, sku_code: `e2e-sku-${language}-${suffix}` }).select("id").single());
  const offerIds: string[] = [];
  for (const [market, currency, priceMinor] of offers) {
    const offer = must(
      await service.from("offers").insert({ sku_id: sku.id, market_code: market, currency, price_minor: priceMinor }).select("id").single(),
    );
    offerIds.push(offer.id);
  }
  const { error } = await service
    .from("editions")
    .update({ active_publication_id: publication.id, status: "published" })
    .eq("id", edition.id);
  if (error) throw error;
  return { editionId: edition.id, publicationId: publication.id, offerIds };
}

// Editorial approval for a fixture edition, written directly: a publication goes live only for an
// approved edition, and fixtures that are not about that workflow (the golden path is) skip the form.
// Needs a profile to record as the reviewer; the first admin, else any profile.
export async function approveEditionDirectly(editionId: string): Promise<void> {
  const service = createServiceRoleClient();
  const admins = await service.from("user_roles").select("profile_id").eq("role", "admin").limit(1);
  if (admins.error) throw admins.error;
  let reviewer = admins.data?.[0]?.profile_id;
  if (!reviewer) {
    const anyone = await service.from("profiles").select("id").limit(1).single();
    if (anyone.error) throw anyone.error;
    reviewer = anyone.data.id;
  }
  const { error } = await service
    .from("editions")
    .update({
      translation_source: "E2E fixture",
      rights_note: "E2E fixture",
      territory_note: "E2E fixture",
      editorial_state: "approved",
      reviewed_by: reviewer,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", editionId);
  if (error) throw error;
}
