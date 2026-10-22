import { type Page, expect, test } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { CHAPTER_TWO_HREF, seedProcessedBook } from "./support/publication";
import { createServiceRoleClient } from "./support/supabase";

// The whole-book free sample. An admin opens a free edition in full; a signed-out visitor then reads
// past the default sample into the last chapter. Closing it again puts the default boundary back.

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function readerReady(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Trang sau" })).toBeEnabled({ timeout: 60_000 });
}

async function pageToTheEnd(page: Page, maxTurns = 120): Promise<void> {
  const next = page.getByRole("button", { name: "Trang sau" });
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (await next.isDisabled()) return;
    await next.click();
    await page.waitForTimeout(150);
  }
  throw new Error(`Still not at the last page after ${maxTurns} turns`);
}

async function lastTocHref(page: Page, publicationId: string): Promise<string> {
  const manifest = await (await page.request.get(`/api/samples/${publicationId}/manifest`)).json();
  return manifest.toc.at(-1).href as string;
}

test("an admin opens a free edition in full and a signed-out visitor reads to the last chapter", async ({ browser }) => {
  test.setTimeout(300_000);
  const suffix = unique();
  const slug = `sample-full-${suffix}`;
  // The fixture EPUB is English, so the edition is English; the Vietnamese copy is what /vi shows.
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `${slug}-en`, title: `Whole ${suffix}` }, vi: { slug, title: `Đọc trọn ${suffix}` } },
  });

  // The toggle needs a free default offer; seedCatalogBook writes a 0 VND offer without naming it default.
  const service = createServiceRoleClient();
  const edition = (await service.from("editions").select("id").eq("book_id", book.bookId).single()).data!;
  const sku = (await service.from("skus").select("id, offers ( id )").eq("edition_id", edition.id).single()).data!;
  const offerId = (sku.offers as { id: string }[])[0].id;
  await service.from("edition_default_offers").upsert({ edition_id: edition.id, sku_id: sku.id, offer_id: offerId });

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  const { email } = await createReader("sample-full-admin", { admin: true });
  const editionPath = `/admin/books/${book.bookId}/editions/${edition.id}`;
  await signInAs(admin, email, editionPath);

  const toggle = admin.getByLabel("Open the whole book as a sample");
  const form = admin.locator("form").filter({ has: toggle });
  await expect(toggle).toBeEnabled();
  await toggle.check();
  await form.getByRole("button", { name: "Save sample" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");

  // Signed out: a fresh context with no cookies.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const chapterTwo = `/api/samples/${book.publicationId}/resources/${CHAPTER_TWO_HREF}`;
  const servedChapterTwo = visitor.waitForResponse((response) => response.url().endsWith(chapterTwo) && response.status() === 200, {
    timeout: 120_000,
  });

  await visitor.goto(`/vi/read-sample/${slug}`);
  await readerReady(visitor);
  await expect(visitor.getByTestId("sample-full-notice")).toHaveText("Đăng nhập để lưu tiến độ từng buổi.");
  // The last contents entry is the paid chapter, and the reader loads it.
  expect(await lastTocHref(visitor, book.publicationId)).toBe(chapterTwo);
  await pageToTheEnd(visitor);
  await servedChapterTwo;

  // Closed again: the default boundary is back, the paid chapter is refused, and the end card shows.
  await admin.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await form.getByRole("button", { name: "Save sample" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");

  const chapterTwoRequests: string[] = [];
  visitor.on("request", (request) => {
    if (request.url().endsWith(chapterTwo)) chapterTwoRequests.push(request.url());
  });
  await visitor.goto(`/vi/read-sample/${slug}`);
  await readerReady(visitor);
  await expect(visitor.getByTestId("sample-full-notice")).toHaveCount(0);
  expect(await lastTocHref(visitor, book.publicationId)).not.toBe(chapterTwo);
  await pageToTheEnd(visitor);
  await expect(visitor.getByText("Phần đọc thử đã kết thúc.")).toBeVisible({ timeout: 30_000 });
  expect(chapterTwoRequests).toEqual([]);
  expect((await visitor.request.get(chapterTwo, { maxRedirects: 0 })).status()).toBe(404);

  await adminContext.close();
  await visitorContext.close();
});
