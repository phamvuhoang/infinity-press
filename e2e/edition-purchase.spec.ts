import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import {
  activeEditionEntitlementCount,
  bookEditionOrderAs,
  createReader,
  enableManualPayments,
  signInAs,
} from "./support/commerce";
import { addPublishedEdition, soleEditionId } from "./support/editions";
import { bankTransferValue, manualServerUrl } from "./support/server-env";
import { createServiceRoleClient } from "./support/supabase";

// Press Task 6 acceptance: manual QR checkout is per edition. A reader buys English, then Japanese of
// the same work, as two orders; each is confirmed by an admin; the library lists both; the UI language
// never changes what is being bought; and nothing about SePay is reachable.
//
// Runs in the chromium-manual project only (the PAYMENT_PROVIDER=manual web server).
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const transferUrl = /\/en\/checkout\/([0-9a-f-]{36})\/transfer$/;

test.beforeAll(async () => {
  await enableManualPayments();
});

test.beforeEach(({ baseURL }) => {
  expect(baseURL, "edition-purchase.spec.ts is only meaningful against the manual web server").toBe(manualServerUrl);
});

async function offerIdOf(editionId: string, currency: string): Promise<string> {
  const { data, error } = await createServiceRoleClient()
    .from("offers")
    .select("id, skus!inner(edition_id)")
    .eq("skus.edition_id", editionId)
    .eq("currency", currency)
    .single();
  if (error) throw error;
  return data.id;
}

async function confirmInAdmin(adminPage: Page, orderId: string, reference: string, amount: string): Promise<string | null> {
  await adminPage.goto(`/admin/orders/${orderId}`);
  await adminPage.getByLabel("Amount received").fill(amount);
  await adminPage.getByLabel("Bank reference").fill(reference);
  await adminPage.getByRole("button", { name: "Confirm payment" }).click();
  // Scoped to the form: Next.js keeps its own role=alert route announcer on every page.
  const failure = adminPage.locator('form p[role="alert"]').first();
  const confirmed = adminPage.getByText(`reference ${reference}`);
  await expect(failure.or(confirmed)).toBeVisible();
  return (await confirmed.isVisible()) ? null : await failure.innerText();
}

test("a reader buys English then Japanese as two orders and ends with two library entries", async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const slug = `ep-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Edition Purchase ${suffix}` } },
    priceMinor: 129000,
  });
  const englishId = await soleEditionId(bookId);

  const reader = await createReader("edition-buyer");
  const admin = await createReader("edition-admin", { admin: true });
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await signInAs(adminPage, admin.email, "/admin/payments");

  // ---- English, through the book page ---------------------------------------------------------
  await signInAs(page, reader.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(transferUrl);
  const englishOrder = transferUrl.exec(page.url())![1];
  await expect(page.getByText(bankTransferValue("BANK_TRANSFER_ACCOUNT_NUMBER"))).toBeVisible();
  await expect(page.getByText(/129,000/)).toBeVisible();
  const englishLine = await createServiceRoleClient()
    .from("order_items")
    .select("edition_id, language_code, offer_id, unit_price_minor")
    .eq("order_id", englishOrder)
    .single();
  expect(englishLine.data).toMatchObject({ edition_id: englishId, language_code: "en", unit_price_minor: 129000 });
  await page.getByRole("button", { name: "I have transferred" }).click();
  await expect(page.getByText("Transfer report received")).toBeVisible();
  expect(await confirmInAdmin(adminPage, englishOrder, `EP-EN-${suffix}`, "129000")).toBeNull();
  expect(await activeEditionEntitlementCount(reader.profileId, englishId)).toBe(1);

  // ---- Japanese: a second edition of the same work goes on sale ---------------------------------
  const japanese = await addPublishedEdition(
    bookId,
    "ja",
    suffix,
    [
      ["VN", "VND", 150000],
      ["JP", "JPY", 500],
    ],
    `版の購入 ${suffix}`,
  );
  const japaneseVnd = japanese.offerIds[0];
  const japaneseJpy = japanese.offerIds[1];

  // Money that is not dong is refused by the database, not merely hidden: no order, no bank details.
  expect(await bookEditionOrderAs(reader.email, japanese.editionId, japaneseJpy)).toEqual({ code: "EB041" });
  // A price the reader did not see is refused rather than charged.
  expect(await bookEditionOrderAs(reader.email, japanese.editionId, japaneseVnd, 149999)).toEqual({ code: "EB040" });
  // The offer of one edition never buys another.
  expect(await bookEditionOrderAs(reader.email, japanese.editionId, await offerIdOf(englishId, "VND"))).toEqual({ code: "EB012" });
  // The same offer, named correctly, makes the order.
  const created = await bookEditionOrderAs(reader.email, japanese.editionId, japaneseVnd, 150000);
  expect(created).toHaveProperty("orderId");
  const japaneseOrder = (created as { orderId: string }).orderId;
  expect(japaneseOrder).not.toBe(englishOrder);

  // ---- the Japanese order, with the interface switched mid-flight ------------------------------
  await page.goto(`/en/checkout/${japaneseOrder}`);
  await expect(page.getByText(`版の購入 ${suffix}`).first()).toBeVisible();
  await expect(page.getByText("日本語").first()).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(transferUrl);
  const reference = (await page.getByTestId("order-reference").textContent())!.trim();
  await expect(page.getByText(/150,000/)).toBeVisible();
  // Switching the interface language changes the words, never the product, price or reference.
  await page.goto(`/ja/checkout/${japaneseOrder}/transfer`);
  expect((await page.getByTestId("order-reference").textContent())!.trim()).toBe(reference);
  await expect(page.getByText(/150,000/)).toBeVisible();
  const afterSwitch = await createServiceRoleClient()
    .from("order_items")
    .select("edition_id, language_code, unit_price_minor")
    .eq("order_id", japaneseOrder)
    .single();
  expect(afterSwitch.data).toMatchObject({ edition_id: japanese.editionId, language_code: "ja", unit_price_minor: 150000 });

  await page.getByRole("button").filter({ hasText: /transferred|振込/ }).first().click();

  // One bank statement line cannot settle two orders.
  const duplicate = await confirmInAdmin(adminPage, japaneseOrder, `EP-EN-${suffix}`, "150000");
  expect(duplicate).toContain("already recorded on another order");
  expect(await activeEditionEntitlementCount(reader.profileId, japanese.editionId)).toBe(0);
  expect(await confirmInAdmin(adminPage, japaneseOrder, `EP-JA-${suffix}`, "150000")).toBeNull();
  await adminContext.close();

  // ---- two editions, two entitlements, two library entries --------------------------------------
  expect(await activeEditionEntitlementCount(reader.profileId, englishId)).toBe(1);
  expect(await activeEditionEntitlementCount(reader.profileId, japanese.editionId)).toBe(1);
  await page.goto("/en/library");
  const shelf = page.locator("section[aria-labelledby=shelf-title] li").filter({ hasText: suffix });
  await expect(shelf).toHaveCount(2);
  await page.goto(`/en/checkout/${japaneseOrder}/status`);
  await page.getByRole("link", { name: "Read now" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/editions/${japanese.editionId}$`));

  // ---- SePay is not a thing here: its old callback grants nothing and answers 404 ----------------
  const before = await activeEditionEntitlementCount(reader.profileId, japanese.editionId);
  const callback = await request.post("/api/payments/sepay/ipn", {
    data: { notification_type: "ORDER_PAID", order: { order_invoice_number: reference, order_status: "CAPTURED" } },
  });
  expect(callback.status()).toBe(404);
  expect(await activeEditionEntitlementCount(reader.profileId, japanese.editionId)).toBe(before);
});
