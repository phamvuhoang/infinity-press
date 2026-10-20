import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { activeEntitlementCount, createReader, enablePayments, signInAs } from "./support/commerce";
import { revalidateStorefront } from "./support/revalidate";

// S19 acceptance. The sale an admin sets in the book editor must reach the raw book page (both
// prices and the JSON-LD a crawler reads), llms.txt, and the amount checkout and the simulator
// charge. Removing any of those links must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const checkoutUrl = /\/en\/checkout\/([0-9a-f-]{36})$/;

test.beforeAll(async () => {
  await enablePayments();
});

test("an admin's 30% sale is what the storefront shows, crawlers read, and checkout charges", async ({ page, browser, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `sale-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title: `Sale Harbour ${suffix}` } }, priceMinor: 129000 });

  const admin = await createReader("sale-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, `/admin/books/${bookId}`);
  await adminPage.getByLabel("Discount").selectOption("percent");
  await adminPage.getByLabel("Percentage off").fill("30");
  await adminPage.getByRole("button", { name: "Save offer" }).click();
  await expect(adminPage.getByText(/Sale running: buyers pay ₫90,300/)).toBeVisible();

  await revalidateStorefront(request);
  const html = await (await request.get(`/en/books/${slug}`)).text();
  expect(html).toMatch(/90,300/);
  expect(html).toMatch(/<del[^>]*>[\s\S]*?129,000[\s\S]*?<\/del>/);
  expect(html).toContain('"price":90300');
  expect(html).toContain('"priceType":"https://schema.org/StrikethroughPrice"');
  expect(await (await request.get("/llms.txt")).text()).toMatch(new RegExp(`/en/books/${slug}\\) \\(₫90,300, list price ₫129,000\\)`));

  const reader = await createReader("sale-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await expect(page.getByText(/90,300/).first()).toBeVisible();
  await expect(page.getByText(/129,000/)).toHaveCount(0);
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  await expect(page.getByText(/90,300/)).toBeVisible();
  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  // Clearing the sale puts the list price back, with nothing struck through.
  await adminPage.getByLabel("Discount").selectOption("none");
  await adminPage.getByRole("button", { name: "Save offer" }).click();
  await expect(adminPage.getByText("No sale.", { exact: false })).toBeVisible();
  await adminContext.close();
  await revalidateStorefront(request);
  const after = await (await request.get(`/en/books/${slug}`)).text();
  expect(after).not.toMatch(/<del/);
  expect(after).toContain('"price":129000');
});
