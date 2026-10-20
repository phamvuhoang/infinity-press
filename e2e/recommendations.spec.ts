import { expect, test } from "@playwright/test";

import { seedCatalogBook, sharePrimaryAuthor } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { grantEntitlement } from "./support/publication";

// S11 acceptance. Two shelves, one fixture, no editorial pin anywhere: everything asserted here
// comes from the computed shared-author signal, so deleting the shelf from either page - or
// letting the library shelf recommend a book the reader already owns - fails this spec.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("a shared author recommends the unowned book on the library and on a topic page", async ({ page }) => {
  test.setTimeout(90_000);
  const run = unique();
  const suffixA = `rec-owned-${run}`;
  const suffixB = `rec-candidate-${run}`;
  // Deliberately not prefixes of one another: every assertion below locates a book by its title.
  const titleA = `Owned Tide Tables ${run}`;
  const titleB = `Unowned Harbour Lights ${run}`;

  const owned = await seedCatalogBook({ suffix: suffixA, localizations: { en: { slug: `owned-tide-tables-${run}`, title: titleA } } });
  const candidate = await seedCatalogBook({
    suffix: suffixB,
    localizations: { en: { slug: `unowned-harbour-lights-${run}`, title: titleB } },
  });
  // The only signal the two books share. seedCatalogBook gives each book its own topic, so the
  // candidate stays out of the owned book's topic and cannot be recommended by topic overlap.
  await sharePrimaryAuthor(owned.authorId, candidate.bookId);

  const reader = await createReader("recommendations");
  await grantEntitlement(owned.bookId, reader.email);
  await signInAs(page, reader.email, "/en/library");

  // The owned book is on this page - as the featured heading, never as a card link. That is what
  // makes the exclusion assertion below a real one rather than an assertion about a title the
  // page never renders at all.
  await expect(page.getByRole("heading", { name: titleA })).toBeVisible();
  const libraryRecommendations = page.getByRole("region", { name: "You might like", exact: true });
  await expect(libraryRecommendations.getByRole("link", { name: titleB })).toBeVisible();
  await expect(libraryRecommendations.getByRole("link", { name: titleA })).toHaveCount(0);

  await page.goto(`/en/topics/${owned.topicSlug}`);
  // Same again for the public page: the owned book IS a card link here, in the topic's own Books
  // grid, so its absence from the shelf is the seed exclusion and not a missing book.
  await expect(page.getByRole("region", { name: "Books", exact: true }).getByRole("link", { name: titleA })).toBeVisible();
  const topicRecommendations = page.getByRole("region", { name: "Related books", exact: true });
  await expect(topicRecommendations.getByRole("link", { name: titleB })).toBeVisible();
  await expect(topicRecommendations.getByRole("link", { name: titleA })).toHaveCount(0);
});
