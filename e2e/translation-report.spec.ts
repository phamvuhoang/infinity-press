import { expect, test } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { grantEntitlement, seedProcessedBook } from "./support/publication";
import { waitForReaderReady } from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";

// Press Task 9: a reader reports a translation error from inside the reader, with the place they were
// reading; the editors triage it; nothing goes to the original author.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("a reader reports an error from the reader menu and an admin resolves it", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `report-${suffix}`, title: `Report Book ${suffix}` } },
  });
  const reader = await createReader("report-reader");
  await grantEntitlement(book.bookId, reader.email);

  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  await waitForReaderReady(page);
  await page.getByRole("button", { name: "Next page" }).click();

  await page.getByRole("button", { name: "Reader menu" }).click();
  await page.getByRole("menuitem", { name: "Report a translation error" }).click();
  await expect(page).toHaveURL(/\/en\/library\/report\/[0-9a-f-]{36}\?href=/);
  await expect(page.getByText(/not sent to the author/)).toBeVisible();
  await expect(page.getByText(/Where you were reading/)).toBeVisible();

  await page.getByLabel("What is wrong?").fill("The second sentence of this page drops a clause.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Thank you. The editors will look at it.")).toBeVisible();

  const { data: rows, error } = await createServiceRoleClient()
    .from("edition_feedback")
    .select("message, publication_id, locator")
    .eq("publication_id", book.publicationId);
  if (error) throw error;
  expect(rows).toHaveLength(1);
  expect(rows![0].locator).toMatchObject({ href: expect.stringContaining("chapter") });

  // The editors triage it.
  const admin = await createReader("report-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/feedback");
  const row = adminPage.getByRole("row").filter({ hasText: "drops a clause" });
  await expect(row).toBeVisible();
  await row.getByLabel("Note").fill("Fixed in the next version.");
  await row.getByRole("button", { name: "Resolve" }).click();
  await expect(adminPage.getByRole("row").filter({ hasText: "drops a clause" })).toHaveCount(0);
  await adminPage.goto("/admin/feedback?status=resolved");
  await expect(adminPage.getByRole("row").filter({ hasText: "drops a clause" })).toBeVisible();
  await adminContext.close();

  // A reader who does not hold the edition cannot reach the form.
  const stranger = await createReader("report-stranger");
  const strangerContext = await browser.newContext();
  const strangerPage = await strangerContext.newPage();
  await signInAs(strangerPage, stranger.email, "/en/library");
  const editionId = /report\/([0-9a-f-]{36})/.exec(page.url())![1];
  const response = await strangerPage.goto(`/en/library/report/${editionId}`);
  expect(response?.status()).toBe(404);
  await strangerContext.close();
});

test("a report sent without a place in the book is still saved", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `report-noloc-${suffix}`, title: `Report No Place ${suffix}` } },
  });
  const reader = await createReader("report-noloc-reader");
  await grantEntitlement(book.bookId, reader.email);
  const service = createServiceRoleClient();
  const { data: edition, error: editionError } = await service.from("editions").select("id").eq("book_id", book.bookId).single();
  if (editionError) throw editionError;

  await signInAs(page, reader.email, `/en/library/report/${edition.id}`);
  await page.getByLabel("What is wrong?").fill("The title page has a typo in the translator's name.");
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Thank you. The editors will look at it.")).toBeVisible();

  const { data: rows, error } = await service.from("edition_feedback").select("message").eq("publication_id", book.publicationId);
  if (error) throw error;
  expect(rows).toHaveLength(1);
});
