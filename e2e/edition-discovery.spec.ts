import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, enablePayments, signInAs } from "./support/commerce";
import { addPublishedEdition, soleEditionId } from "./support/editions";
import { revalidateStorefront } from "./support/revalidate";
import { createServiceRoleClient } from "./support/supabase";

// Press Task 8 acceptance (A03-A05): one card per work, the edition and its price chosen by one
// rule, a selector that never changes the interface language, and an explicit edition that cannot
// fall through into buying another one.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test.beforeAll(async () => {
  await enablePayments();
});

test("a work with English, Vietnamese and an unpriced Japanese edition is chosen by language, never by price", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `ed-disc-${suffix}`;
  const title = `Discovery Work ${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title } },
    priceMinor: 100000,
  });
  const english = await soleEditionId(bookId);
  const vietnamese = await addPublishedEdition(bookId, "vi", suffix, [["VN", "VND", 90000]]);
  const japanese = await addPublishedEdition(bookId, "ja", suffix, []);
  await revalidateStorefront(request);

  // ---- A JA reader: the JA edition exists but has no price. It is shown as JA, not swapped for EN.
  await page.goto(`/ja/books/${slug}`);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  // The copy is English (no JA copy exists) and says so; the EPUB is Japanese and says so.
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("タイトルと説明はEnglishで表示しています。")).toBeVisible();
  await expect(page.getByText("電子書籍・日本語")).toBeVisible();
  await expect(page.getByText("販売準備中").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Buy|購入|Mua/ })).toHaveCount(0);

  // ---- The selector changes the edition, never the interface language.
  await page.getByRole("navigation", { name: "言語別の版" }).getByRole("link", { name: /English/ }).click();
  await expect(page).toHaveURL(new RegExp(`/ja/books/${slug}\\?edition=${english}$`));
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByText("電子書籍・English")).toBeVisible();
  await expect(page.getByText(/100,000/).first()).toBeVisible();

  // ---- A forged or stale edition has no Buy button at all, and does not become the default.
  await page.goto(`/en/books/${slug}?edition=00000000-0000-4000-8000-0000000000ff`);
  await expect(page.getByText("That edition is not available.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Buy ebook" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Get free" })).toHaveCount(0);

  // ---- An EN reader: EN is the default, VI is one click away, and the order names the edition on screen.
  await page.goto(`/en/books/${slug}`);
  await expect(page.getByText("Ebook · English")).toBeVisible();
  await page.getByRole("navigation", { name: "Language editions" }).getByRole("link", { name: /Tiếng Việt/ }).click();
  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}\\?edition=${vietnamese.editionId}$`));
  await expect(page.getByText("Ebook · Tiếng Việt")).toBeVisible();
  await expect(page.getByText(/90,000/).first()).toBeVisible();

  const reader = await createReader("edition-disc-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}?edition=${vietnamese.editionId}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);
  const orderId = /checkout\/([0-9a-f-]{36})/.exec(page.url())![1];
  const { data: line, error } = await createServiceRoleClient()
    .from("order_items")
    .select("edition_id, language_code, unit_price_minor")
    .eq("order_id", orderId)
    .single();
  if (error) throw error;
  expect(line).toMatchObject({ edition_id: vietnamese.editionId, language_code: "vi", unit_price_minor: 90000 });
  expect(line.edition_id).not.toBe(japanese.editionId);

  // The checkout page names the language that was bought.
  await expect(page.getByText("Tiếng Việt").first()).toBeVisible();
});

test("lists one card per work in the language that was resolved, and finds Japanese without spaces", async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const enSlug = `ed-card-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug: enSlug, title: `Card Work ${suffix}` } },
    priceMinor: 0,
  });
  const jaTitle = `こころのほしぞら${suffix.replace(/[^0-9]/g, "")}`;
  await addPublishedEdition(bookId, "ja", suffix, [["JP", "JPY", 0]], jaTitle);
  await revalidateStorefront(request);

  // JA UI: the Japanese edition under its own copy, once.
  await page.goto("/ja/books");
  const jaCards = page.locator("li").filter({ has: page.getByRole("link", { name: jaTitle }) });
  await expect(jaCards).toHaveCount(1);
  await expect(jaCards.getByText("日本語")).toBeVisible();

  // EN UI: the English edition under the English copy, once.
  await page.goto("/en/books");
  const enCards = page.locator("li").filter({ has: page.getByRole("link", { name: `Card Work ${suffix}` }) });
  await expect(enCards).toHaveCount(1);
  await expect(enCards.getByText("English")).toBeVisible();

  // Japanese is found by a fragment, with no word breaks.
  await page.goto(`/ja/search?q=${encodeURIComponent("ほしぞ")}`);
  await expect(page.getByRole("link", { name: jaTitle })).toBeVisible();
});
