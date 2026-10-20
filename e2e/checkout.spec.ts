import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import {
  activeEntitlementCount,
  createReader,
  enablePayments,
  orderCountForBook,
  profileIdForEmail,
  signInAs,
} from "./support/commerce";
import { readLatestLink } from "./support/mailpit";

// S3 acceptance. Removing the Buy action, the signed simulator delivery, the status page, owner-only
// order reads, or order revocation must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const checkoutUrl = /\/en\/checkout\/([0-9a-f-]{36})$/;

test.beforeAll(async () => {
  await enablePayments();
});

async function buyAndPay(page: Page, outcome: "Succeed" | "Fail"): Promise<string> {
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  await page.getByRole("button", { name: outcome, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/status$`));
  return orderId;
}

test("a reader buys a paid ebook on the simulator and opens it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const title = `Paid Harbour ${suffix}`;
  const slug = `paid-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 129000 });

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("link", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/sign-in\\?next=%2Fen%2Fbooks%2F${slug}$`));

  const email = `buyer-${suffix}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();
  await page.goto(await readLatestLink(email));
  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));

  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await expect(page.getByRole("heading", { level: 1, name: "Review your order" })).toBeVisible();
  await expect(page.getByText("Ebook (EPUB, read on the web)")).toBeVisible();
  await expect(page.getByText(/129,000/)).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  // The redirect to the simulator changed nothing; only the signed event will.
  const profileId = await profileIdForEmail(email);
  expect(await activeEntitlementCount(profileId, bookId)).toBe(0);

  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/status$`));
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  await page.getByRole("link", { name: "Read now" }).click();
  await expect(page).toHaveURL(/\/en\/read\/editions\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeAttached();
  expect(await activeEntitlementCount(profileId, bookId)).toBe(1);

  // Another reader cannot see this order.
  const other = await createReader("checkout-other");
  const context = await browser.newContext();
  const otherPage = await context.newPage();
  await signInAs(otherPage, other.email, "/en/account");
  expect((await otherPage.goto(`/en/checkout/${orderId}`))?.status()).toBe(404);
  expect((await otherPage.goto(`/en/checkout/${orderId}/status`))?.status()).toBe(404);
  expect((await otherPage.goto(`/en/account/orders/${orderId}`))?.status()).toBe(404);
  await context.close();
});

test("a failed payment can be retried on the same order", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const title = `Retry Harbour ${suffix}`;
  const slug = `retry-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 90000 });
  const reader = await createReader("checkout-retry");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const orderId = await buyAndPay(page, "Fail");
  await expect(page.getByRole("heading", { level: 1, name: "Payment did not go through" })).toBeVisible();

  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}$`));
  await expect(page.getByText("Your last payment did not go through. You can try again.")).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
  expect(await orderCountForBook(reader.profileId, bookId)).toBe(1);

  await page.goto("/en/account/orders");
  const orders = page.getByRole("list", { name: "Your orders" });
  await expect(orders.getByRole("link", { name: title })).toBeVisible();
  await expect(orders.getByText("Completed")).toBeVisible();
});

test("a reader gets a free ebook and goes straight to the reader", async ({ page }) => {
  const suffix = unique();
  const title = `Free Harbour ${suffix}`;
  const slug = `free-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } } });
  const reader = await createReader("checkout-free");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  await page.getByRole("button", { name: "Get free" }).click();
  await expect(page).toHaveURL(/\/en\/read\/editions\/[0-9a-f-]{36}$/);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  await page.goto(`/en/books/${slug}`);
  await expect(page.getByRole("link", { name: "Read now" })).toBeVisible();
});

test("an admin revokes the access an order granted", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const title = `Revoked Harbour ${suffix}`;
  const slug = `revoked-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 50000 });
  const reader = await createReader("checkout-revoke");
  const admin = await createReader("checkout-admin", { admin: true });

  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  await signInAs(readerPage, reader.email, `/en/books/${slug}`);
  const orderId = await buyAndPay(readerPage, "Succeed");
  await expect(readerPage.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  await signInAs(page, admin.email, "/admin/orders");
  await page.getByLabel("Email or order ID").fill(reader.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}$`));

  await page.getByLabel("Reason").fill("Chargeback rehearsal");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByText(/Access from this order was revoked on/)).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  await readerPage.goto("/en/library");
  await expect(readerPage.getByText(title)).toHaveCount(0);
  await readerContext.close();
});
