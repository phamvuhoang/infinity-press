import { expect, test } from "@playwright/test";

import { seedBundle, seedCatalogBook } from "./support/catalog";
import {
  activeEntitlementBookIds,
  createReader,
  enableManualPayments,
  signInAs,
} from "./support/commerce";
import { manualServerUrl } from "./support/server-env";

// S9 acceptance, the bundle half of the two golden paths (spec 9-10): a reader buys a bundle,
// transfers, an admin confirms, and every member book is in the reader's library and opens.
//
// This file lives in the chromium-manual project, alongside e2e/manual-payment.spec.ts and for the
// same reason: the journey the exit criteria name ends at an admin CONFIRMING a bank transfer, and
// a payment provider is a property of the running server rather than of a test. The simulator
// server has no transfer page at all, so none of this could pass against one. playwright.config.ts
// admits exactly these two files to that project and excludes them from every other.
//
// The gift half of S9 runs on the simulator and lives in e2e/bundles-and-gifts.spec.ts.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const transferUrl = /\/en\/checkout\/([0-9a-f-]{36})\/transfer$/;

test.beforeAll(async () => {
  await enableManualPayments();
});

test.beforeEach(({ baseURL }) => {
  expect(baseURL, "bundle-purchase.spec.ts is only meaningful against the manual web server").toBe(manualServerUrl);
});

test("a reader buys a two-book bundle, transfers, and an admin confirms", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const first = { slug: `bundle-harbour-a-${suffix}`, title: `Bundle Harbour A ${suffix}` };
  const second = { slug: `bundle-harbour-b-${suffix}`, title: `Bundle Harbour B ${suffix}` };
  const bundleSlug = `harbour-set-${suffix}`;
  const bundleTitle = `Harbour Set ${suffix}`;

  const bookA = await seedCatalogBook({ suffix: `${suffix}-a`, localizations: { en: first }, priceMinor: 129000 });
  const bookB = await seedCatalogBook({ suffix: `${suffix}-b`, localizations: { en: second }, priceMinor: 99000 });
  const { bundleId } = await seedBundle({
    suffix,
    bookIds: [bookA.bookId, bookB.bookId],
    localizations: { en: { slug: bundleSlug, title: bundleTitle } },
    priceMinor: 189000,
  });

  const reader = await createReader("bundle-buyer");
  await signInAs(page, reader.email, `/en/bundles/${bundleSlug}`);

  // The public bundle page: one price for the whole bundle, and both member books listed under it.
  await expect(page.getByRole("heading", { level: 1, name: bundleTitle })).toBeVisible();
  await expect(page.getByText(/189,000/)).toBeVisible();
  const members = page.getByRole("region", { name: "In this bundle" });
  await expect(members.getByText(first.title)).toBeVisible();
  await expect(members.getByText(second.title)).toBeVisible();

  await page.getByRole("button", { name: "Buy bundle" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);

  // Checkout names the bundle, not one of its books, and lists what the bundle covers.
  await expect(page.getByRole("heading", { level: 1, name: "Review your order" })).toBeVisible();
  await expect(page.getByText(bundleTitle)).toBeVisible();
  await expect(page.getByText("2 editions")).toBeVisible();
  const included = page.getByRole("list", { name: "In this bundle" });
  await expect(included.getByText(first.title)).toBeVisible();
  await expect(included.getByText(second.title)).toBeVisible();

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(transferUrl);
  const orderId = transferUrl.exec(page.url())![1];
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  // One bundle price, never the sum of the member prices and never one member's price.
  await expect(page.getByText(/189,000/)).toBeVisible();
  await expect(page.getByText(/129,000/)).toHaveCount(0);

  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();
  // A report is a claim, not a payment: nothing is granted for either book until an admin says so.
  expect(await activeEntitlementBookIds(reader.profileId)).toEqual([]);

  const admin = await createReader("bundle-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/payments");
  await adminPage.getByLabel("Reference or email").fill(reference);
  await adminPage.getByRole("button", { name: "Search", exact: true }).click();
  await adminPage.getByRole("link", { name: reference }).click();
  await expect(adminPage).toHaveURL(new RegExp(`/admin/orders/${orderId}$`));

  await adminPage.getByLabel("Amount received").fill("189000");
  await adminPage.getByLabel("Bank reference").fill(`VCB-E2E-${suffix}`);
  await adminPage.getByRole("button", { name: "Confirm payment" }).click();
  await expect(adminPage.getByText(`reference VCB-E2E-${suffix}`)).toBeVisible();
  await expect(adminPage.getByText("completed · payment succeeded")).toBeVisible();
  await adminContext.close();

  // One confirmation, one entitlement per member book, and nothing else.
  expect([...(await activeEntitlementBookIds(reader.profileId))].sort()).toEqual([bookA.bookId, bookB.bookId].sort());

  // The library holds the BOOKS. A bundle is a way to sell books, never a thing that can be read,
  // so it must never appear as a library item - there is no reader route it could open.
  await page.goto("/en/library");
  // The shelf list, not a bare text match: the library renders the most recently read book TWICE -
  // once as the featured heading and again as a shelf entry - so `getByText(title)` is ambiguous
  // for whichever book happens to be featured. The shelf <ul> holds every item exactly once, which
  // makes it both unambiguous and the stronger assertion: one entry per book proves the bundle did
  // not also add a duplicate.
  const shelf = page.locator("section[aria-labelledby='shelf-title'] ul");
  await expect(shelf.getByRole("listitem")).toHaveCount(2);
  await expect(shelf.getByRole("listitem").filter({ hasText: first.title })).toHaveCount(1);
  await expect(shelf.getByRole("listitem").filter({ hasText: second.title })).toHaveCount(1);
  await expect(page.getByText(bundleTitle)).toHaveCount(0);
  expect((await page.goto(`/en/read/${bundleId}`))?.status()).toBe(404);

  // And each book's reader route opens for this reader.
  for (const book of [
    { id: bookA.bookId, title: first.title },
    { id: bookB.bookId, title: second.title },
  ]) {
    await page.goto(`/en/read/${book.id}`);
    await expect(page).toHaveURL(/\/en\/read\/editions\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: book.title })).toBeAttached();
  }
});
