import { expect, test } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { soleEditionId } from "./support/editions";
import { seedPublishedJourney } from "./support/journeys";
import { seedProcessedBook } from "./support/publication";

// S20. A signed-in reader follows a free three-session journey from its public page, marks each
// session done, finishes with a reflection, and sees the finished journey in the library.

test("a reader completes a reading journey and the library shows it", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const book = await seedProcessedBook({
    suffix,
    localizations: {
      en: { slug: `journey-reader-${suffix}`, title: `Journey reader ${suffix}` },
      vi: { slug: `hanh-trinh-doc-${suffix}`, title: `Hành trình đọc ${suffix}` },
    },
  });
  const slug = `ba-ngay-${suffix}`;
  await seedPublishedJourney({ bookId: book.bookId, editionId: await soleEditionId(book.bookId), slug });

  const reader = await createReader("journey-reader");
  await signInAs(page, reader.email, `/vi/journeys/${slug}`);

  await expect(page.getByRole("heading", { level: 1, name: "Ba ngày đọc" })).toBeVisible();
  await expect(page.getByText("Đã xong 0/3 buổi")).toBeVisible();
  await page.getByRole("link", { name: "Bắt đầu" }).click();

  for (const position of [1, 2, 3]) {
    await expect(page).toHaveURL(new RegExp(`/vi/journeys/${slug}/sessions/${position}$`));
    await expect(page.getByRole("heading", { level: 1, name: `Ngày ${position}` })).toBeVisible();
    await expect(page.getByRole("link", { name: "Mở reader tại đoạn này" })).toHaveAttribute("href", /\/vi\/read\/editions\/[0-9a-f-]{36}$/);
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
