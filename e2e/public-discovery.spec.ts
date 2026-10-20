import { expect, test } from "@playwright/test";

import { seedCatalogBook, setHomeFeatured } from "./support/catalog";
import { readLatestLink } from "./support/mailpit";
import { revalidateStorefront } from "./support/revalidate";

// S2 acceptance. Removing a published filter, the translation 404, the switcher alternate, the
// diacritic-insensitive search, or the sign-in return path must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("a reader goes from home to a book, signs in, and returns to the same book", async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const title = `Harbour Notes ${suffix}`;
  const slug = `harbour-notes-${suffix}`;
  const viSlug = `ghi-chep-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title }, vi: { slug: viSlug, title: `Ghi chép ${suffix}` } },
    withSample: true,
  });
  await setHomeFeatured(bookId);
  // The home page is prerendered (revalidate = 300); seedCatalogBook/setHomeFeatured write through
  // the service-role client, bypassing the admin Server Action that would normally call
  // revalidateStorefront(). Without this, the home page keeps serving whatever it had cached from
  // before this test ran, for up to five minutes - see e2e/support/revalidate.ts.
  await revalidateStorefront(request);

  await page.goto("/en");
  await page.getByRole("link", { name: title, exact: true }).first().click();

  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // The link names the edition on screen, so the sample opened is that edition's.
  await expect(page.getByRole("link", { name: "Read a sample" })).toHaveAttribute("href", new RegExp(`^/en/read-sample/${slug}\\?edition=[0-9a-f-]{36}$`));
  await expect(page.locator('a[hreflang="vi"]')).toHaveAttribute("href", `/vi/books/${viSlug}`);

  await page.getByRole("link", { name: "Get free" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/sign-in\\?next=%2Fen%2Fbooks%2F${slug}$`));

  const email = `discovery-${suffix}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();

  await page.goto(await readLatestLink(email));
  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Get free" })).toBeEnabled();
});

test("a book without a translation returns 404, and the switcher falls back to home", async ({ page }) => {
  const suffix = unique();
  const slug = `chi-tieng-viet-${suffix}`;
  const title = `Chỉ tiếng Việt ${suffix}`;
  await seedCatalogBook({ suffix, localizations: { vi: { slug, title } } });

  expect((await page.goto(`/en/books/${slug}`))?.status()).toBe(404);

  await page.goto(`/vi/books/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("href", "/en");
});

test("search and filters show only published books, with or without diacritics", async ({ page }) => {
  const suffix = unique();
  const title = `Đắc Nhân Tâm ${suffix}`;
  const draftTitle = `Đắc Nhân Tâm nháp ${suffix}`;
  const { topicSlug } = await seedCatalogBook({ suffix, localizations: { vi: { slug: `dac-nhan-tam-${suffix}`, title } } });
  await seedCatalogBook({
    suffix: `${suffix}-draft`,
    localizations: { vi: { slug: `nhap-${suffix}`, title: draftTitle } },
    status: "draft",
  });

  for (const query of [`dac nhan tam ${suffix}`, title]) {
    await page.goto(`/vi/search?${new URLSearchParams({ q: query })}`);
    await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText(draftTitle)).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    // The switcher keeps the query on the other locale's search page.
    await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("href", `/en/search?${new URLSearchParams({ q: query })}`);
  }

  expect((await page.goto(`/vi/books/nhap-${suffix}`))?.status()).toBe(404);

  await page.goto(`/vi/books?topic=${topicSlug}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  // Filter slugs are locale-specific, so the switcher drops them.
  await expect(page.locator('a[hreflang="en"]')).toHaveAttribute("href", "/en/books");

  await page.goto(`/vi/topics/${topicSlug}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`E2E Topic ${suffix}`);
  await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
});
