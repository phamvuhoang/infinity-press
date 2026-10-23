import { expect, test } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { seedProcessedBook } from "./support/publication";

// S20. An admin builds a reading journey for a processed edition: picks the book and edition, adds
// three sessions from the publication's toc, writes the vi text, and publishes. The fixture EPUB is
// English, so the edition is en and publishing also needs the en title (the readiness rule).

test("an admin creates, fills, and publishes a reading journey", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const book = await seedProcessedBook({
    suffix,
    localizations: {
      en: { slug: `journey-book-${suffix}`, title: `Journey book ${suffix}` },
      vi: { slug: `hanh-trinh-${suffix}`, title: `Hành trình ${suffix}` },
    },
    shortFinalChapter: true,
  });
  const admin = await createReader("journey-admin", { admin: true });
  await signInAs(page, admin.email, "/admin/journeys/new");

  await page.getByLabel("Book").selectOption(book.bookId);
  await page.getByLabel("Edition").selectOption({ index: 1 });
  await page.getByLabel("Slug").fill(`journey-${suffix}`);
  await page.getByRole("button", { name: "Create journey" }).click();
  await expect(page).toHaveURL(/\/admin\/journeys\/[0-9a-f-]{36}$/);

  // Publishing is refused until a session and the edition-language text exist.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish journey" }).click();
  await expect(page.getByTestId("journey-publish-message")).toContainText("Add at least one session");

  for (const chapter of ["Chapter 1", "Chapter 2", "Chapter 3"]) {
    const form = page.getByRole("form", { name: "Add session" });
    await form.getByLabel("Start").selectOption({ label: chapter });
    await form.getByRole("button", { name: "Add session" }).click();
    await expect(page.getByRole("listitem", { name: `Session ${chapter.slice(-1)}` })).toBeVisible();
  }
  await expect(page.getByRole("list", { name: "Sessions" }).getByRole("listitem")).toHaveCount(3);

  const journeyVi = page.getByRole("form", { name: "Journey vi" });
  await journeyVi.getByLabel("Title (vi)").fill("Bảy ngày đọc");
  await journeyVi.getByLabel("Summary (vi)").fill("Một chương mỗi ngày.");
  await journeyVi.getByRole("button", { name: "Save vi journey text" }).click();
  await expect(journeyVi.getByRole("status")).toHaveText("Saved.");

  const sessionVi = page.getByRole("form", { name: "Session 1 vi" });
  await sessionVi.getByLabel("Title (vi)").fill("Ngày đầu tiên");
  await sessionVi.getByLabel("Guide (vi)").fill("Đọc chậm và ghi chú.");
  await sessionVi.getByLabel(/Questions \(vi\)/).fill("Điều gì làm bạn ngạc nhiên?");
  await sessionVi.getByRole("button", { name: "Save vi session text" }).click();
  await expect(sessionVi.getByRole("status")).toHaveText("Saved.");

  // vi alone is not enough for an en edition. The earlier refusal cleared once sessions were added.
  await expect(page.getByTestId("journey-publish-message")).toBeHidden();
  await page.getByRole("button", { name: "Publish journey" }).click();
  await expect(page.getByTestId("journey-publish-message")).toContainText("edition's language");

  const journeyEn = page.getByRole("form", { name: "Journey en" });
  await journeyEn.getByLabel("Title (en)").fill(`Seven days ${suffix}`);
  await journeyEn.getByRole("button", { name: "Save en journey text" }).click();
  await expect(journeyEn.getByRole("status")).toHaveText("Saved.");

  await page.getByRole("button", { name: "Publish journey" }).click();
  await expect(page.getByTestId("journey-status")).toHaveText("Published");

  await page.goto("/admin/journeys");
  await expect(page.getByRole("row", { name: new RegExp(`Seven days ${suffix}`) }).getByTestId("journey-status")).toHaveText("Published");
});
