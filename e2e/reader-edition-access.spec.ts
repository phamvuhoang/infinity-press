import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { soleEditionId } from "./support/editions";
import { grantEntitlement } from "./support/publication";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";

// Access is per edition: owning English never opens Japanese, by page URL or by the reader API.
// The SQL rule is pinned in supabase/tests/press_edition_access.sql; this is the browser journey.

async function addPublishedJapaneseEdition(bookId: string, suffix: string) {
  const service = createServiceRoleClient();
  const { data: edition, error } = await service
    .from("editions")
    .insert({ book_id: bookId, language_code: "ja" })
    .select("id")
    .single();
  if (error) throw error;
  const { data: asset, error: assetError } = await service
    .from("ebook_assets")
    .insert({ edition_id: edition.id, source_storage_key: `e2e/${suffix}/ja.epub`, version: 1, status: "published" })
    .select("id")
    .single();
  if (assetError) throw assetError;
  const { data: publication, error: publicationError } = await service
    .from("ebook_publications")
    .insert({ ebook_asset_id: asset.id, version: 1, manifest_key: `e2e/${suffix}/ja.json`, status: "published", epub_language: "ja" })
    .select("id")
    .single();
  if (publicationError) throw publicationError;
  const { error: pointerError } = await service
    .from("editions")
    .update({ active_publication_id: publication.id, status: "published" })
    .eq("id", edition.id);
  if (pointerError) throw pointerError;
  return { editionId: edition.id as string, publicationId: publication.id as string };
}

test("a reader who owns English cannot open Japanese by URL, and the legacy link goes to the edition they own", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug: `ea-${suffix}`, title: `Edition access ${suffix}` } } });
  const reader = await createReader("edition-access");
  await grantEntitlement(bookId, reader.email);
  const englishEditionId = await soleEditionId(bookId);
  const japanese = await addPublishedJapaneseEdition(bookId, suffix);

  await signInAs(page, reader.email, "/en/library");

  // Direct URL to the edition they do not own: indistinguishable from "no such edition".
  const denied = await page.goto(`/en/read/editions/${japanese.editionId}`);
  expect(denied?.status()).toBe(404);

  // The reader API refuses the Japanese publication to this session too.
  const response = await page.request.post("/api/reader/sessions", { data: { publicationId: japanese.publicationId } });
  expect([401, 403, 404]).toContain(response.status());

  // The old /read/{bookId} link resolves only to what they own.
  await page.goto(`/en/read/${bookId}`);
  await expect(page).toHaveURL(new RegExp(`/en/read/editions/${englishEditionId}$`));
});

test("granting Japanese too lists both, and the legacy link asks which edition rather than guessing", async ({ page }) => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug: `eb-${suffix}`, title: `Two editions ${suffix}` } } });
  const reader = await createReader("edition-two");
  const operator = await createReader("edition-op", { admin: true });
  await grantEntitlement(bookId, reader.email);
  const japanese = await addPublishedJapaneseEdition(bookId, suffix);

  const service = createServiceRoleClient();
  const session = createAnonClient();
  const { data: link, error: linkError } = await service.auth.admin.generateLink({ type: "magiclink", email: operator.email });
  if (linkError) throw linkError;
  const { error: verifyError } = await session.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: "email" });
  if (verifyError) throw verifyError;
  const { error: grantError } = await session.rpc("grant_complimentary_entitlement", {
    p_profile_id: reader.profileId,
    p_edition_id: japanese.editionId,
    p_reason: "E2E edition access",
  });
  if (grantError) throw grantError;

  await signInAs(page, reader.email, "/ja/library");
  // Both owned editions are listed, each tagged with its language, even in a Japanese interface.
  const shelf = page.locator("section[aria-labelledby=shelf-title] li").filter({ hasText: `Two editions ${suffix}` });
  await expect(shelf).toHaveCount(2);
  await expect(shelf.getByText("ja", { exact: true })).toHaveCount(1);
  await expect(shelf.getByText("en", { exact: true })).toHaveCount(1);

  await page.goto(`/en/read/${bookId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Choose an edition to read" })).toBeVisible();
  await page.getByRole("link", { name: "Japanese" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/editions/${japanese.editionId}$`));
});
