import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import {
  activeEntitlementCount,
  bookEbookOrderAs,
  createReader,
  enableSepayPayments,
  orderState,
  paymentEventCount,
  setProviderForRegression,
  signInAs,
} from "./support/commerce";
import { sepayServerUrl, sepayValue } from "./support/server-env";

// S18 acceptance. Removing the hand-off page, the notification endpoint, its secret check, or the
// entitlement it grants must fail here.
//
// Runs in the chromium-sepay project only, against the web server started with
// PAYMENT_PROVIDER=sepay. SePay is never contacted: the browser's POST to SePay is intercepted and
// recorded, and the test then plays SePay's part by posting the notification.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SEPAY_CHECKOUT = "https://pay-sandbox.sepay.vn/v1/checkout/init";
const IPN = "/api/payments/sepay/ipn";

test.beforeAll(async () => {
  await enableSepayPayments();
});

test.beforeEach(({ baseURL }) => {
  expect(baseURL, "sepay-payment.spec.ts is only meaningful against the SePay web server").toBe(sepayServerUrl);
});

// Buy, press Pay, and capture what the hand-off page posts to SePay.
async function buyAndCaptureCheckout(page: Page, slug: string): Promise<{ orderId: string; fields: URLSearchParams }> {
  let posted: string | null = null;
  await page.route(SEPAY_CHECKOUT, async (route) => {
    posted = route.request().postData();
    await route.fulfill({ status: 200, contentType: "text/html", body: "<h1>SePay stub</h1>" });
  });

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);
  const orderId = /\/checkout\/([0-9a-f-]{36})$/.exec(page.url())![1];
  await page.getByRole("button", { name: "Pay", exact: true }).click();

  await expect(page.getByRole("heading", { name: "SePay stub" })).toBeVisible();
  expect(posted, "the hand-off page posted to SePay's sandbox checkout").not.toBeNull();
  return { orderId, fields: new URLSearchParams(posted!) };
}

function paidNotification(fields: URLSearchParams, transactionId: string) {
  return {
    timestamp: Math.floor(Date.now() / 1000),
    notification_type: "ORDER_PAID",
    order: {
      order_id: `E2E-${transactionId}`,
      order_status: "CAPTURED",
      order_currency: fields.get("currency"),
      order_amount: `${fields.get("order_amount")}.00`,
      order_invoice_number: fields.get("order_invoice_number"),
    },
    transaction: { transaction_id: transactionId, payment_method: "BANK_TRANSFER", transaction_status: "APPROVED" },
  };
}

test("a reader pays through SePay and reads the book", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `sepay-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `SePay Harbour ${suffix}` } },
    priceMinor: 89000,
  });
  const reader = await createReader("sepay-buyer");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId, fields } = await buyAndCaptureCheckout(page, slug);

  expect(fields.get("merchant")).toBe(sepayValue("SEPAY_MERCHANT_ID"));
  expect(fields.get("payment_method")).toBe("BANK_TRANSFER");
  expect(fields.get("order_amount")).toBe("89000");
  expect(fields.get("currency")).toBe("VND");
  expect(fields.get("order_invoice_number")).toMatch(/^IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}-89000$/);
  expect(fields.get("success_url")).toBe(`${sepayServerUrl}/en/checkout/${orderId}/status?sepay=success`);
  expect(fields.get("signature")).toBeTruthy();
  expect([...fields.values()]).not.toContain(sepayValue("SEPAY_SECRET_KEY"));

  // Coming back does not complete anything, whatever the URL says.
  await page.goto(`/en/checkout/${orderId}/status?sepay=success`);
  await expect(page.getByRole("heading", { level: 1, name: "Processing your payment" })).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // Neither does a notification without the secret, or with the wrong one.
  const transactionId = `TXN-${suffix}`;
  const body = paidNotification(fields, transactionId);
  expect((await request.post(IPN, { data: body })).status()).toBe(401);
  expect((await request.post(IPN, { data: body, headers: { "X-Secret-Key": "wrong" } })).status()).toBe(401);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // Nor one for a different amount.
  const underpaid = paidNotification(fields, `${transactionId}-under`);
  underpaid.order.order_amount = "1000.00";
  expect(
    (await request.post(IPN, { data: underpaid, headers: { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") } })).status(),
  ).toBe(422);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  // SePay's notification does, and a second delivery changes nothing.
  for (let delivery = 0; delivery < 2; delivery += 1) {
    const response = await request.post(IPN, {
      data: body,
      headers: { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  }
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  await page.goto(`/en/checkout/${orderId}/status?sepay=success`);
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Read now" })).toBeVisible();
});

test("a reader who cancels on SePay can try again", async ({ page }) => {
  const suffix = unique();
  const slug = `sepay-cancel-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { en: { slug, title: `SePay Cancel ${suffix}` } }, priceMinor: 89000 });
  const reader = await createReader("sepay-canceller");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId, fields } = await buyAndCaptureCheckout(page, slug);

  await page.goto(new URL(fields.get("cancel_url")!).pathname + "?sepay=cancel");
  await expect(page.getByRole("heading", { level: 1, name: "Payment did not go through" })).toBeVisible();
  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}$`));
});

// Review focus 3, against the real database: the operator switches providers while a reader is on
// SePay's page, a new Buy cancels the old order as stale, and the old QR is paid afterwards. The
// money is in the bank, so the order must stay cancelled, nothing is granted, and both deliveries
// say so (422) rather than being acknowledged.
test("a payment for an order a provider switch cancelled needs manual resolution", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `sepay-switch-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `SePay Switch ${suffix}` } },
    priceMinor: 89000,
  });
  const reader = await createReader("sepay-switcher");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId: oldOrderId, fields } = await buyAndCaptureCheckout(page, slug);
  const transactionId = `TXN-late-${suffix}`;

  try {
    await setProviderForRegression("manual");
    // The real RPC behind Buy: the old SePay order is stale under the manual provider.
    const newOrderId = await bookEbookOrderAs(reader.email, bookId);
    expect(newOrderId).not.toBe(oldOrderId);
    expect(await orderState(oldOrderId)).toMatchObject({ status: "cancelled", paymentStatus: "cancelled", provider: "sepay" });
    expect(await orderState(newOrderId)).toMatchObject({ status: "pending", provider: "manual" });

    const body = paidNotification(fields, transactionId);
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await request.post(IPN, {
        data: body,
        headers: { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") },
      });
      expect(response.status()).toBe(422);
      expect(await response.json()).toMatchObject({ error: "manual_resolution_required" });
    }

    expect(await orderState(oldOrderId)).toMatchObject({ status: "cancelled" });
    expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);
    expect(await paymentEventCount(oldOrderId, transactionId)).toBe(1);
  } finally {
    await enableSepayPayments();
  }
});

// A coupon repriced the order after a first QR was shown and both QRs got paid. The second payment
// arrives for an order that is already completed, which the RPC records and otherwise ignores - so
// the handler has to tell it from a repeat of the first one, or the reader's second payment is
// acknowledged and forgotten. Real database, real payments row.
test("a second SePay order paid against a completed order needs manual resolution", async ({ page, request }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `sepay-double-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `SePay Double ${suffix}` } },
    priceMinor: 89000,
  });
  const reader = await createReader("sepay-double");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const { orderId, fields } = await buyAndCaptureCheckout(page, slug);
  const headers = { "X-Secret-Key": sepayValue("SEPAY_SECRET_KEY") };

  const first = paidNotification(fields, `TXN-first-${suffix}`);
  expect((await request.post(IPN, { data: first, headers })).status()).toBe(200);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  // The same SePay order again - a retry under a new transaction ID - is still a repeat.
  const retry = paidNotification(fields, `TXN-retry-${suffix}`);
  retry.order.order_id = first.order.order_id;
  expect((await request.post(IPN, { data: retry, headers })).status()).toBe(200);

  // A different SePay order for the same local order is a second payment.
  const second = paidNotification(fields, `TXN-second-${suffix}`);
  const response = await request.post(IPN, { data: second, headers });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ error: "manual_resolution_required" });
  expect(await paymentEventCount(orderId, `TXN-second-${suffix}`)).toBe(1);
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
  expect(await orderState(orderId)).toMatchObject({ status: "completed" });
});
