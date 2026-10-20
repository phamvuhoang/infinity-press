import { expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { revalidateStorefront } from "./support/revalidate";
import { createServiceRoleClient } from "./support/supabase";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

test("an admin adds a Shopee link and the book page shows it with UTM and two Offers", async ({ page, request }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const slug = `paperback-${suffix}`;
  const { bookId } = await seedCatalogBook({
    suffix,
    localizations: { vi: { slug, title: `Sách giấy ${suffix}` } },
    priceMinor: 50000,
  });
  const admin = await createReader(`paperback-admin-${suffix}`, { admin: true });
  await signInAs(page, admin.email, `/admin/books/${bookId}`);

  // The new row is prefilled with currency "VND" and no price: a link without a price is valid and
  // the server drops the orphan currency.
  await page.getByRole("button", { name: "Add retailer" }).click();
  const row = page.getByRole("listitem", { name: "Paperback retailer row 1 of 1" });
  await row.getByLabel("Retailer", { exact: true }).selectOption("shopee");
  await row.getByLabel("URL", { exact: true }).fill("https://shopee.vn/e2e-paperback");
  await page.getByRole("button", { name: "Save paperback retailers" }).click();
  await expect(page.getByTestId("form-saved")).toBeVisible();
  await revalidateStorefront(request);

  await page.goto(`/vi/books/${slug}`);
  const link = page.getByRole("link", { name: "Shopee" });
  await expect(link).toHaveAttribute(
    "href",
    "https://shopee.vn/e2e-paperback?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
  );
  await expect(link).toHaveAttribute("rel", "nofollow noopener sponsored");

  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  const [book] = JSON.parse(jsonLd ?? "[]") as [{ offers: { seller: { name: string }; itemOffered: { bookFormat: string } }[] }];
  expect(book.offers).toHaveLength(2);
  expect(book.offers[1].seller.name).toBe("Shopee");
  expect(book.offers[1].itemOffered.bookFormat).toBe("https://schema.org/Paperback");

  // The link opens a real marketplace in a new tab; the test must not depend on that site.
  await page.context().route(/^https?:\/\/([^/]+\.)?shopee\.vn\//, (route) => route.abort());
  await link.click();

  const service = createServiceRoleClient();
  await expect
    .poll(
      async () => {
        const { data, error } = await service
          .from("analytics_events")
          .select("retailer")
          .eq("event_name", "click_external_store")
          .eq("book_id", bookId);
        if (error) throw new Error(error.message);
        return data;
      },
      { message: "click_external_store row for the seeded book", timeout: 15_000 },
    )
    .toEqual([{ retailer: "shopee" }]);
});

test("/llms.txt lists a published book", async ({ request }) => {
  const suffix = unique();
  const slug = `llms-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { vi: { slug, title: `LLMS ${suffix}` } } });
  await revalidateStorefront(request);
  const response = await request.get("/llms.txt");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/plain");
  expect(await response.text()).toContain(`/vi/books/${slug}`);
});
