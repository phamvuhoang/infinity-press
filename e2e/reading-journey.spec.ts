import { expect, test } from "@playwright/test";

import { activeEntitlementCount, createReader, signInAs } from "./support/commerce";
import { soleEditionId } from "./support/editions";
import { seedPublishedJourney } from "./support/journeys";
import { seedProcessedBook } from "./support/publication";

// S20. A signed-in reader who does not yet hold the book follows a free three-session journey from
// its public page: the first session hands them the free edition and opens the reader at its
// passage, each later session links straight into the reader, they mark each session done, finish
// with a reflection, and see the finished journey in the library.

test("a reader completes a reading journey and the library shows it", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const book = await seedProcessedBook({
    suffix,
    localizations: {
      en: { slug: `journey-reader-${suffix}`, title: `Journey reader ${suffix}` },
      vi: { slug: `hanh-trinh-doc-${suffix}`, title: `Hành trình đọc ${suffix}` },
    },
    // Three chapters, one per session; without this the fixture spine stops at chapter 2.
    shortFinalChapter: true,
  });
  const slug = `ba-ngay-${suffix}`;
  await seedPublishedJourney({ bookId: book.bookId, editionId: await soleEditionId(book.bookId), slug });

  const reader = await createReader("journey-reader");
  expect(await activeEntitlementCount(reader.profileId, book.bookId)).toBe(0);
  await signInAs(page, reader.email, `/vi/journeys/${slug}`);

  await expect(page.getByRole("heading", { level: 1, name: "Ba ngày đọc" })).toBeVisible();
  await expect(page.getByText("Đã xong 0/3 buổi")).toBeVisible();
  await page.getByRole("link", { name: "Bắt đầu" }).click();

  // No entitlement yet: the session claims the free edition and opens the reader at its passage.
  await expect(page).toHaveURL(new RegExp(`/vi/journeys/${slug}/sessions/1$`));
  await expect(page.getByRole("link", { name: "Mở reader tại đoạn này" })).toHaveCount(0);
  await page.getByRole("button", { name: "Nhận bản miễn phí và mở reader tại đoạn này" }).click();
  await expect(page).toHaveURL(/\/vi\/read\/editions\/[0-9a-f-]{36}\?anchor=\d+$/);
  await expect(page.getByRole("button", { name: "Trang sau" })).toBeEnabled({ timeout: 60_000 });
  expect(await activeEntitlementCount(reader.profileId, book.bookId)).toBe(1);
  await page.goto(`/vi/journeys/${slug}/sessions/1`);

  for (const position of [1, 2, 3]) {
    await expect(page).toHaveURL(new RegExp(`/vi/journeys/${slug}/sessions/${position}$`));
    await expect(page.getByRole("heading", { level: 1, name: `Ngày ${position}` })).toBeVisible();
    // Every start resolves to a passage, including session 2's fragment-bearing toc href.
    await expect(page.getByRole("link", { name: "Mở reader tại đoạn này" })).toHaveAttribute("href", /\/vi\/read\/editions\/[0-9a-f-]{36}\?anchor=\d+$/);
    await page.getByRole("button", { name: "Đánh dấu đã xong" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Đã xong" })).toBeVisible();
    await expect(page.getByText(`Đã xong ${position}/3 buổi`)).toBeVisible();
    if (position < 3) await page.getByRole("link", { name: "Tiếp tục" }).click();
  }

  // Only the last session asks for a reflection.
  await page.getByLabel("Bạn mang theo điều gì sau hành trình này?").fill("Đọc chậm thì nhớ lâu.");
  await page.getByRole("button", { name: "Hoàn thành hành trình" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Đã hoàn thành hành trình" })).toBeVisible();

  await page.goto("/vi/library");
  const section = page.getByRole("region", { name: "Hành trình đọc" });
  await expect(section.getByRole("link", { name: "Ba ngày đọc" })).toHaveAttribute("href", `/vi/journeys/${slug}`);
  await expect(section.getByText("Đã xong 3/3 buổi · Đã hoàn thành hành trình")).toBeVisible();
});
