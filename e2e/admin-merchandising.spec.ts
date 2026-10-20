import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

async function createAdminUser() {
  const service = createServiceRoleClient();
  const email = `merchandising-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "merchandising-admin-password-1";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: profile, error: profileError } = await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
  if (profileError) throw profileError;
  const { error: roleError } = await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
  if (roleError) throw roleError;
  return { email, password };
}

async function createBook(title: string, suffix: string) {
  const service = createServiceRoleClient();
  const { data: author, error: authorError } = await service
    .from("authors")
    .insert({ canonical_slug: `merchandising-author-${suffix}`, display_name: `Merchandising author ${suffix}` })
    .select("id")
    .single();
  if (authorError) throw authorError;
  const { data: book, error: bookError } = await service
    .from("books")
    .insert({ canonical_key: `merchandising-book-${suffix}`, original_language: "vi", primary_author_id: author.id })
    .select("id")
    .single();
  if (bookError) throw bookError;
  const { error: localizationError } = await service
    .from("book_localizations")
    .insert({ book_id: book.id, locale: "vi", slug: `merchandising-book-${suffix}`, title });
  if (localizationError) throw localizationError;
  return book.id;
}

async function clearMerchandisingSlots() {
  const { error } = await createServiceRoleClient()
    .from("merchandising_slots")
    .delete()
    .in("slot_key", ["home_featured", "home_shelf"]);
  if (error) throw error;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/internal/en/sign-in?next=%2Fadmin%2Fmerchandising");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/admin\/merchandising$/);
}

test("an anonymous visitor is denied and an admin persists the featured book and shelf order", async ({ page }) => {
  await page.goto("/admin/merchandising");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fadmin%2Fmerchandising$/);

  await clearMerchandisingSlots();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const firstTitle = "The first merchandising book";
  const secondTitle = "The second merchandising book";
  const firstBookId = await createBook(firstTitle, `${unique}-one`);
  const secondBookId = await createBook(secondTitle, `${unique}-two`);
  const admin = await createAdminUser();
  await signIn(page, admin.email, admin.password);

  await page.getByLabel("Featured book").selectOption(firstBookId);
  const featuredForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save featured book" }) });
  await page.getByRole("button", { name: "Save featured book" }).click();
  await expect(featuredForm.getByRole("status")).toHaveText("Saved.");

  await page.getByLabel("Add a book to the shelf").selectOption(firstBookId);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Add a book to the shelf").selectOption(secondBookId);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: "Move up" }).nth(1).click();
  const shelfForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save shelf" }) });
  await page.getByRole("button", { name: "Save shelf" }).click();
  await expect(shelfForm.getByRole("status")).toHaveText("Saved.");

  await page.setViewportSize({ width: 375, height: 812 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Featured book")).toHaveValue(firstBookId);
  const reloadedShelfForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save shelf" }) });
  const reloadedShelfItems = reloadedShelfForm.locator("ol > li");
  await expect(reloadedShelfItems).toHaveCount(2);
  await expect(reloadedShelfItems.nth(0)).toContainText(secondTitle);
  await expect(reloadedShelfItems.nth(1)).toContainText(firstTitle);

  const { data: slots, error } = await createServiceRoleClient()
    .from("merchandising_slots")
    .select("slot_key, book_id, position")
    .in("book_id", [firstBookId, secondBookId])
    .order("slot_key")
    .order("position");
  if (error) throw error;
  expect(slots).toEqual([
    { slot_key: "home_featured", book_id: firstBookId, position: 1 },
    { slot_key: "home_shelf", book_id: secondBookId, position: 1 },
    { slot_key: "home_shelf", book_id: firstBookId, position: 2 },
  ]);
});
