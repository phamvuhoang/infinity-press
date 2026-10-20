import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { activeEntitlementCount, createReader, enablePayments, signInAs } from "./support/commerce";

// S8 acceptance, the half that needs no payment provider: a 100% code takes a signed-in reader from
// the book page into the reader with no payment step, and creates exactly one entitlement.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const couponCode = () => `TESTER-${Math.random().toString(36).slice(2, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;

test.beforeAll(async () => {
  await enablePayments();
});

test("a 100% code takes a reader from the book page into the reader", async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const slug = `coupon-lantern-${suffix}`;
  const code = couponCode();
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { en: { slug, title: `Coupon Lantern ${suffix}` } },
    priceMinor: 129000,
  });

  // The operator issues the code. There is no service-role path into coupons - that is the point of
  // the table having no grants - so this is also the admin screen's acceptance test.
  const admin = await createReader("s8-admin", { admin: true });
  await signInAs(page, admin.email, "/admin/coupons");
  await page.getByRole("link", { name: "New coupon" }).click();
  await page.getByLabel("Code").fill(code);
  await page.getByLabel("Percentage off").fill("100");
  await page.getByRole("button", { name: "Create coupon" }).click();
  // Creating redirects to the coupon's own edit page, whose heading is the code (Next's own route
  // announcer briefly echoes the same text, which is why this targets the heading specifically).
  await expect(page.getByRole("heading", { name: code })).toBeVisible();

  // The reader buys, applies the code, and lands in the reader.
  const reader = await createReader("s8-reader");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(/\/en\/checkout\/[0-9a-f-]{36}$/);

  await page.getByLabel("Enter a code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Apply", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/en/read/${bookId}$`));
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
});

test("a wrong code says the same thing whatever is wrong with it", async ({ page }) => {
  const suffix = unique();
  const slug = `coupon-tide-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { en: { slug, title: `Coupon Tide ${suffix}` } }, priceMinor: 129000 });
  const reader = await createReader("s8-wrong");
  await signInAs(page, reader.email, `/en/books/${slug}`);
  await page.getByRole("button", { name: "Buy ebook" }).click();

  await page.getByLabel("Enter a code").fill("NOSUCHCODE");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  // Scoped to the coupon section: Next's own route announcer is also role="alert" on navigation,
  // and would otherwise make this locator ambiguous.
  const couponSection = page.getByRole("region", { name: "Promotion code" });
  await expect(couponSection.getByRole("alert")).toHaveText("This code cannot be used.");
  // Nothing moved: still the undiscounted price, still no discount row.
  await expect(page.getByText("Subtotal")).toHaveCount(0);
});
