import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

// One work, several language editions, each managed on its own page. The independence of
// publishing (publishing or rolling back Japanese never moves English) is pinned in SQL by
// supabase/tests/press_edition_publishing.sql; this spec covers the admin journey around it.

async function createAdminUser() {
  const email = `edition-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "edition-admin-password-1";
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: profile, error: profileError } = await admin.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
  if (profileError) throw profileError;
  const { error: roleError } = await admin.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
  if (roleError) throw roleError;
  return { email, password };
}

async function signInAsAdmin(page: Page, email: string, password: string) {
  await page.goto("/internal/en/sign-in?next=%2Fadmin%2Fbooks%2Fnew");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/new$/);
}

test("an admin adds a Japanese edition to a work and prices it in yen without touching the English one", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const service = createServiceRoleClient();

  await signInAsAdmin(page, email, password);
  await page.getByLabel("Canonical key").fill(`editions-${unique}`);
  await page.getByLabel("Author name").fill(`Editions Author ${unique}`);
  await page.getByLabel("Title").fill("Editions book");
  await page.getByLabel("Slug").fill(`editions-${unique}`);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("50000");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  const bookId = new URL(page.url()).pathname.split("/").at(-1)!;

  // Add the Japanese edition: the work page lists both, each with its own page.
  await page.getByLabel("Language", { exact: true }).selectOption("ja");
  await page.getByRole("button", { name: "Add edition" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/books/${bookId}/editions/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Japanese edition" })).toBeVisible();

  // Credits and an explicit JPY offer, entered in minor units: 500 JPY is 500.
  await page.getByLabel("Credits").fill("translator: Hanako Yamada");
  await page.getByRole("button", { name: "Save edition", exact: true }).click();
  await expect(page.locator("form").filter({ has: page.getByRole("button", { name: "Save edition", exact: true }) }).getByRole("status")).toHaveText("Saved.");
  await page.locator("#new-offer-marketCode").fill("JP");
  await page.locator("#new-offer-currency").fill("JPY");
  await page.locator("#new-offer-priceMinor").fill("500");
  await page.getByRole("button", { name: "Add offer" }).click();
  await expect(page.getByRole("heading", { name: /JPY · JP · default/ })).toBeVisible();

  const { data: editions, error } = await service.from("editions").select("id, language_code, contributors").eq("book_id", bookId).order("language_code");
  if (error) throw error;
  expect(editions?.map((edition) => edition.language_code)).toEqual(["en", "ja"]);
  const japanese = editions!.find((edition) => edition.language_code === "ja")!;
  expect(japanese.contributors).toEqual([{ role: "translator", name: "Hanako Yamada" }]);

  const { data: offers } = await service.from("offers").select("currency, price_minor, skus!inner(edition_id)").eq("skus.edition_id", japanese.id);
  expect(offers).toHaveLength(1);
  expect(offers![0]).toMatchObject({ currency: "JPY", price_minor: 500 });
  // The English edition kept its own VND offer and its default flag.
  const english = editions!.find((edition) => edition.language_code === "en")!;
  const { data: englishOffers } = await service.from("offers").select("currency, price_minor, skus!inner(edition_id)").eq("skus.edition_id", english.id);
  expect(englishOffers).toEqual([expect.objectContaining({ currency: "VND", price_minor: 50000 })]);

  // An unset price is never a free offer.
  await page.locator("#new-offer-marketCode").fill("US");
  await page.locator("#new-offer-currency").fill("USD");
  await page.locator("#new-offer-priceMinor").fill("");
  await page.getByRole("button", { name: "Add offer" }).click();
  await expect(page.locator("#new-offer-priceMinor")).toHaveAttribute("aria-invalid", "true");
});
