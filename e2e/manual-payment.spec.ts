import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { activeEntitlementCount, createReader, enableManualPayments, signInAs } from "./support/commerce";
import { bankTransferValue, manualServerUrl } from "./support/server-env";

// S7 acceptance. Removing the transfer page, the reader's report, the admin confirmation, or the
// entitlement it grants must fail here.
//
// This file runs in the chromium-manual project only, against the second web server defined in
// playwright.config.ts - the one started with PAYMENT_PROVIDER=manual. A simulator server has no
// transfer page at all, so none of this could pass against one; the baseURL check below says so
// before the first click, so a misconfiguration names itself instead of arriving as a stray
// selector timeout.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const transferUrl = /\/en\/checkout\/([0-9a-f-]{36})\/transfer$/;
const referenceFormat = /^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/;

test.beforeAll(async () => {
  await enableManualPayments();
});

test.beforeEach(({ baseURL }) => {
  expect(baseURL, "manual-payment.spec.ts is only meaningful against the manual web server").toBe(manualServerUrl);
});

// Buy the book and land on the transfer instructions, which is where the manual provider sends a
// reader instead of to a payment page.
async function buyAndReachTransfer(page: Page, slug: string): Promise<{ orderId: string; reference: string }> {
  await page.goto(`/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();

  await expect(page).toHaveURL(transferUrl);
  const orderId = transferUrl.exec(page.url())![1];
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  expect(reference).toMatch(referenceFormat);
  return { orderId, reference };
}

// The queue lists every pending manual order, including ones other tests in this file left there,
// so reach this order through the search rather than by picking a row out of the table.
async function openInAdmin(page: Page, reference: string, orderId: string): Promise<void> {
  await page.goto("/admin/payments");
  await page.getByLabel("Reference or email").fill(reference);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: reference }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}$`));
}

test("a reader transfers, reports it, and an admin confirms", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `manual-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Manual Harbour ${suffix}` } },
    priceMinor: 129000,
  });

  const reader = await createReader("manual-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  const { orderId, reference } = await buyAndReachTransfer(page, slug);

  // The payee details come from this server's own BANK_TRANSFER_* variables. A reader who cannot
  // read them off the page cannot make the transfer at all, so they are part of the journey.
  await expect(page.getByText(bankTransferValue("BANK_TRANSFER_BANK_NAME"))).toBeVisible();
  await expect(page.getByText(bankTransferValue("BANK_TRANSFER_ACCOUNT_NUMBER"))).toBeVisible();
  await expect(page.getByText(bankTransferValue("BANK_TRANSFER_ACCOUNT_HOLDER"))).toBeVisible();
  await expect(page.getByText(/129,000/)).toBeVisible();

  // The two intermediate reader states, asserted on /status where they are actually rendered.
  //
  // This is the assertion the suite was missing. /status branches on the order's provider, and
  // that provider used to be read from a `payments` embed no reader may select - so this page
  // silently fell back to the S3 "Processing your payment" view with its auto-refresh, for every
  // manual order, in production. Visiting /status only after confirmation hid it completely:
  // there both branches answer "success".
  await page.goto(`/en/checkout/${orderId}/status`);
  await expect(page.getByRole("heading", { level: 1, name: "Waiting for your transfer" })).toBeVisible();
  await page.getByRole("link", { name: "View transfer instructions" }).click();
  await expect(page).toHaveURL(transferUrl);

  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();

  await page.goto(`/en/checkout/${orderId}/status`);
  await expect(page.getByRole("heading", { level: 1, name: "Awaiting confirmation" })).toBeVisible();
  // Reporting a transfer is a claim, not a payment: nothing is granted until an admin says so.
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  const admin = await createReader("manual-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/payments");
  await openInAdmin(adminPage, reference, orderId);

  await adminPage.getByLabel("Amount received").fill("129000");
  await adminPage.getByLabel("Bank reference").fill(`VCB-E2E-${suffix}`);
  await adminPage.getByRole("button", { name: "Confirm payment" }).click();
  // Not the form's own "Payment confirmed." message: a successful confirmation completes the order,
  // and the decision forms render only while it is pending, so the message unmounts with them. What
  // the admin is actually left looking at is the confirmation record and the new order state, which
  // is the stronger thing to assert anyway - it comes from the database, not from form state.
  await expect(adminPage.getByText(`reference VCB-E2E-${suffix}`)).toBeVisible();
  await expect(adminPage.getByText("completed · payment succeeded")).toBeVisible();
  await adminContext.close();

  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
  await page.goto(`/en/checkout/${orderId}/status`);
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();
  await page.getByRole("link", { name: "Read now" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/${bookId}$`));
});

test("a declined transfer returns the reader to the instructions", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `manual-declined-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Manual Declined ${suffix}` } },
    priceMinor: 129000,
  });

  const reader = await createReader("manual-declined");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  const { orderId, reference } = await buyAndReachTransfer(page, slug);

  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();

  const admin = await createReader("manual-decline-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/payments");
  await openInAdmin(adminPage, reference, orderId);

  await adminPage.getByLabel("Reason").fill("No transfer found on the statement");
  await adminPage.getByLabel("Mark as not received").check();
  await adminPage.getByRole("button", { name: "Decline payment" }).click();
  await expect(adminPage.getByText("Payment declined.")).toBeVisible();
  await adminContext.close();

  // "Not received" leaves the order payable: the reason is shown and the reader can report again.
  await page.reload();
  await expect(page.getByText("Reason: No transfer found on the statement.")).toBeVisible();
  await expect(page.getByRole("button", { name: "I have transferred" })).toBeEnabled();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // Spec 6.2 asks for the admin's reason on the status page and in order history, not only on the
  // transfer page. Both used to show generic copy - "The payment was not completed. You can try
  // again." and a "Payment failed" label - which tells a reader who did transfer nothing about why
  // we could not find it, or what to do next.
  await page.goto(`/en/checkout/${orderId}/status`);
  await expect(page.getByRole("heading", { level: 1, name: "Transfer not received yet" })).toBeVisible();
  await expect(page.getByText("Reason: No transfer found on the statement.")).toBeVisible();
  await page.getByRole("link", { name: "View transfer instructions" }).click();
  await expect(page).toHaveURL(transferUrl);

  await page.goto(`/en/account/orders/${orderId}`);
  await expect(page.getByText("Reason: No transfer found on the statement.")).toBeVisible();
  await page.getByRole("link", { name: "View transfer instructions" }).click();
  await expect(page).toHaveURL(transferUrl);

  // And reporting the new transfer takes them off the decline. payment_status is still 'failed'
  // and always will be, so this passes only because a report made after the decline outranks it -
  // otherwise the reader keeps reading "Transfer not received yet" on the very screen the runbook
  // tells them to use again.
  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();
  await expect(page.getByText("Reason: No transfer found on the statement.")).toBeHidden();

  await page.goto(`/en/checkout/${orderId}/status`);
  await expect(page.getByRole("heading", { level: 1, name: "Awaiting confirmation" })).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);
});

// S8 acceptance, the half that needs the manual provider: a partial code reduces the amount the
// transfer page shows and the amount an admin confirms. Issuing the code goes through the admin
// screen, exactly as e2e/coupons.spec.ts does, because coupons has no service-role grant.
test("a 20% code discounts the transfer amount an admin confirms", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `manual-coupon-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Manual Coupon ${suffix}` } },
    priceMinor: 129000,
  });
  const code = `TESTER-${suffix.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toUpperCase()}`;

  const admin = await createReader("manual-coupon-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/coupons");
  await adminPage.getByRole("link", { name: "New coupon" }).click();
  await adminPage.getByLabel("Code").fill(code);
  await adminPage.getByLabel("Percentage off").fill("20");
  await adminPage.getByRole("button", { name: "Create coupon" }).click();
  await expect(adminPage.getByRole("heading", { name: code })).toBeVisible();

  const reader = await createReader("manual-coupon-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);

  await page.getByLabel("Enter a code").fill(code);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByText("Discount")).toBeVisible();

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(transferUrl);
  const orderId = transferUrl.exec(page.url())![1];
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  expect(reference).toMatch(referenceFormat);
  // The amount printed here is the discounted total (129,000 less 20% = 103,200), never the
  // book's undiscounted price.
  await expect(page.getByText(/103,200/)).toBeVisible();
  await expect(page.getByText(/129,000/)).toHaveCount(0);

  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();

  await openInAdmin(adminPage, reference, orderId);
  await adminPage.getByLabel("Amount received").fill("103200");
  await adminPage.getByLabel("Bank reference").fill(`VCB-E2E-${suffix}`);
  await adminPage.getByRole("button", { name: "Confirm payment" }).click();
  await expect(adminPage.getByText(`reference VCB-E2E-${suffix}`)).toBeVisible();
  await expect(adminPage.getByText("completed · payment succeeded")).toBeVisible();
  await adminContext.close();

  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
});
