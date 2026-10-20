import { expect, test, type Page } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { READER_DEPTH_SELECTION, grantEntitlement, seedProcessedBook } from "./support/publication";
import { selectKnownPassage, waitForReaderReady } from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";

// S16 acceptance (spec 10, 11): Share mints a public card; the card renders signed out with the
// book's action and an Open Graph image; the owner removes it and the card and image 404.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Must run before signInAs: an init script only applies to navigations after it is added.
async function stubShare(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async ({ text }: { text?: string }) => { (window as typeof window & { __shared?: string }).__shared = text; },
    });
  });
}

async function shareFromReader(page: Page): Promise<string> {
  await waitForReaderReady(page);
  await selectKnownPassage(page, READER_DEPTH_SELECTION);
  // Hold the mint so the notice shown before it is observable.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/reader\/quotes\?/, async (route) => { await held; await route.continue(); });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Sharing creates a public quote page you can remove from your library." })).toBeVisible();
  release();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __shared?: string }).__shared ?? "")).toMatch(/\/en\/q\//);
  await expect(page.getByText("A public quote page was created. You can remove it from your library.")).toBeVisible();
  const shared = await page.evaluate(() => (window as typeof window & { __shared?: string }).__shared ?? "");
  const url = shared.split("\n").at(-1)!;
  expect(url).toMatch(/\/en\/q\/[A-Za-z0-9_-]{10}$/);
  return url;
}

test("a reader shares a quote, anyone opens the card, and the owner removes it", async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({ suffix, localizations: { en: { slug: `quote-${suffix}`, title: `Quote ${suffix}` } }, readerDepthFixture: true });
  const reader = await createReader("quote-owner");
  await grantEntitlement(book.bookId, reader.email);
  await stubShare(page);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  const cardUrl = await shareFromReader(page);
  const path = new URL(cardUrl).pathname;
  const code = path.split("/").at(-1)!;

  // Signed out: the quote, the book, Buy, and the sample link.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  await visitor.goto(path);
  await expect(visitor.getByText(READER_DEPTH_SELECTION.slice(0, 20), { exact: false })).toBeVisible();
  await expect(visitor.getByRole("link", { name: book.title, exact: true })).toHaveAttribute("href", `/en/books/${book.slug}`);
  // Signed out, Get free is a link to sign in; Buy is a form button.
  await expect(visitor.getByRole("main").getByRole("link", { name: /Buy ebook|Get free/ }).or(visitor.getByRole("main").getByRole("button", { name: /Buy ebook|Get free/ }))).toBeVisible();
  await expect(visitor.getByRole("link", { name: "Read a sample" })).toBeVisible();
  const robots = await visitor.locator('meta[name="robots"]').getAttribute("content");
  expect(robots).toMatch(/noindex/);
  expect(robots).toMatch(/follow/);
  expect(await visitor.locator('link[rel="canonical"]').getAttribute("href")).toContain(`/en/books/${book.slug}`);

  // Next serves the image at a hashed path, so take it from the page rather than building it.
  const ogImage = await visitor.locator('meta[property="og:image"]').getAttribute("content");
  expect(ogImage).toBeTruthy();
  const imagePath = new URL(ogImage!).pathname;
  const image = await request.get(imagePath);
  expect(image.status()).toBe(200);
  expect(image.headers()["content-type"]).toContain("image/png");

  // Review Focus 4: the card renders in its own locale under the other locale path too.
  const otherLocale = await request.get(`/vi/q/${code}`, { maxRedirects: 0 });
  expect(otherLocale.status()).toBe(200);

  // The row carries no locator and the share event carries ids only.
  const service = createServiceRoleClient();
  const rows = await service.from("shared_quotes").select("id, book_id, status").eq("code", code);
  expect(rows.data).toHaveLength(1);
  const events = await service.from("analytics_events").select("event_name").eq("shared_quote_id", rows.data![0].id);
  expect(events.data!.map((e) => e.event_name)).toContain("share_quote");

  // Owner's library lists it with the link; removing it 404s the card and the image.
  await page.goto("/en/library");
  await page.getByRole("link", { name: "Shared quotes" }).click();
  await expect(page).toHaveURL(/\/en\/library\/quotes$/);
  await expect(page.getByRole("link", { name: path })).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("You have not shared a quote yet", { exact: false })).toBeVisible();
  expect((await request.get(path)).status()).toBe(404);
  expect((await request.get(imagePath)).status()).toBe(404);
  await visitorContext.close();
});

test("an admin takes a card down", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({ suffix, localizations: { en: { slug: `quote-adm-${suffix}`, title: `Quote Adm ${suffix}` } }, readerDepthFixture: true });
  const reader = await createReader("quote-owner-2");
  await grantEntitlement(book.bookId, reader.email);
  await stubShare(page);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  const cardUrl = await shareFromReader(page);
  const code = new URL(cardUrl).pathname.split("/").at(-1)!;

  await page.context().clearCookies();
  const admin = await createReader("quote-admin", { admin: true });
  await signInAs(page, admin.email, `/admin/quotes?book=${book.bookId}`);
  const row = page.getByRole("row", { name: new RegExp(book.title) });
  await expect(row.getByRole("link", { name: code })).toBeVisible();
  await row.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  const service = createServiceRoleClient();
  const card = await service.from("shared_quotes").select("id, status").eq("code", code).single();
  expect(card.data!.status).toBe("removed");
  const audit = await service.from("audit_logs").select("action").eq("action", "shared_quote.remove").eq("entity_id", card.data!.id);
  expect(audit.data).toHaveLength(1);
});
