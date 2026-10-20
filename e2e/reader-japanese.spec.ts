import { type Page, expect, test } from "@playwright/test";

import { JAPANESE_CORPUS } from "../scripts/fixtures/create-test-epub";
import { createReader, signInAs } from "./support/commerce";
import { grantEntitlement, seedProcessedBook } from "./support/publication";
import { decorationIsVisiblyIntersecting, passageIsVisiblyIntersecting, selectKnownPassage, waitForReaderReady } from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";

// Press Task 9 (A13): a Japanese EPUB reads, searches, highlights and restores its place in the
// existing horizontal reader, inside an English interface - the language of the book is not the
// language of the chrome. The sanitizer is unchanged; this only proves what it already allows.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function rubyReadings(page: Page): Promise<string[]> {
  const readings: string[] = [];
  for (const frame of page.frames()) {
    try {
      readings.push(...(await frame.evaluate(() => [...document.querySelectorAll("ruby rt")].map((node) => node.textContent ?? ""))));
    } catch {
      // A frame that is navigating or cross-origin has nothing to read.
    }
  }
  return readings;
}

test("a Japanese book shows ruby, finds spaceless text, keeps a highlight and restores the place", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({
    suffix,
    japanese: true,
    localizations: { ja: { slug: `ja-reader-${suffix}`, title: JAPANESE_CORPUS.title } },
  });
  const reader = await createReader("ja-reader");
  await grantEntitlement(book.bookId, reader.email);

  await page.setViewportSize({ width: 1024, height: 800 });
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  await waitForReaderReady(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  // Ruby reaches the rendered frame untouched, with its reading.
  await expect.poll(() => rubyReadings(page), { timeout: 30_000 }).toContain(JAPANESE_CORPUS.rubyReading);

  // A fragment with no spaces is found, and opening the result lands on it.
  await page.getByRole("button", { name: "Reader menu" }).click();
  await page.getByRole("menuitem", { name: "Search this book" }).click();
  await page.getByRole("searchbox", { name: "Search this book" }).fill("返事のない");
  const result = page.getByRole("button", { name: /返事のない手紙/ }).first();
  await expect(result).toBeVisible({ timeout: 15_000 });
  await result.click();
  await expect.poll(() => passageIsVisiblyIntersecting(page, "返事のない手紙"), { timeout: 30_000 }).toBe(true);

  // Highlight a Japanese sentence, reload, and it is still there and still drawn.
  // A relocation that lands just after the jump clears a selection made at that instant (under a loaded
  // server it does), so the selection is retried until the toolbar stays.
  await expect(async () => selectKnownPassage(page, JAPANESE_CORPUS.quote)).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Yellow", exact: true }).click();
  const service = createServiceRoleClient();
  await expect
    .poll(async () => {
      const { data } = await service.from("reader_annotations").select("id").eq("publication_id", book.publicationId).eq("selected_text", JAPANESE_CORPUS.quote);
      return data?.length ?? 0;
    }, { timeout: 30_000 })
    .toBe(1);
  const { data: annotation } = await service.from("reader_annotations").select("id").eq("publication_id", book.publicationId).eq("selected_text", JAPANESE_CORPUS.quote).single();
  await expect.poll(() => decorationIsVisiblyIntersecting(page, annotation!.id, JAPANESE_CORPUS.quote), { timeout: 30_000 }).toBe(true);

  // Turn a few pages into the long unbroken paragraph; the saved place is restored after a reload.
  for (let turn = 0; turn < 3; turn += 1) {
    const next = page.getByRole("button", { name: "Next page" });
    if (await next.isDisabled()) break;
    await next.click();
    await page.waitForTimeout(300);
  }
  await expect
    .poll(async () => {
      const { data } = await service.from("reading_progress").select("progression, total_progression").eq("publication_id", book.publicationId).maybeSingle();
      return data?.total_progression ?? 0;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  // The save is debounced; let the last page turn land before taking the place to compare with.
  await page.waitForTimeout(3_000);
  const { data: saved } = await service.from("reading_progress").select("locator_json").eq("publication_id", book.publicationId).single();

  await page.reload();
  await waitForReaderReady(page);
  const { data: afterReload } = await service.from("reading_progress").select("locator_json").eq("publication_id", book.publicationId).single();
  expect((afterReload!.locator_json as { href: string }).href).toBe((saved!.locator_json as { href: string }).href);
  // The reader is back where it was (not on the first page, where the highlight is), and the
  // highlight is still in the saved items.
  await page.getByRole("button", { name: "Reader menu" }).click();
  await page.getByRole("menuitem", { name: "Contents" }).click();
  const drawer = page.getByRole("dialog", { name: "Contents" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("tab", { name: /Bookmarks/ }).click();
  await expect(drawer.getByRole("listitem").filter({ hasText: JAPANESE_CORPUS.quote })).toHaveCount(1);
});
