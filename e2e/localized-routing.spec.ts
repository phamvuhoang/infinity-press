import { expect, test } from "@playwright/test";

test("marks the default English home page with its document language", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
});

test("renders the Vietnamese home page in Vietnamese", async ({ page }) => {
  await page.goto("/vi");
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByRole("link", { name: "Đăng nhập" }).first()).toBeVisible();
});

test("renders the Japanese home page in Japanese", async ({ page }) => {
  await page.goto("/ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("link", { name: "ログイン" }).first()).toBeVisible();
});

test("offers every locale in the language selector, and choosing one switches the page locale", async ({ page }) => {
  await page.goto("/en");
  const selector = page.getByRole("navigation", { name: "Choose language" });
  await expect(selector.getByRole("link", { name: "Tiếng Việt" })).toHaveAttribute("href", "/vi");
  await selector.getByRole("link", { name: "日本語" }).click();
  await expect(page).toHaveURL(/\/ja$/);
});

test("sends an anonymous reader to localized sign-in with the original destination", async ({
  page,
}) => {
  await page.goto("/ja/account");
  await expect(page).toHaveURL(/\/ja\/sign-in\?next=%2Fja%2Faccount$/);
  await expect(page.locator('input[name="next"]')).toHaveValue("/ja/account");
});

test("sends an anonymous admin visitor to sign-in without losing the admin destination", async ({
  page,
}) => {
  await page.goto("/admin/books/new");
  await expect(page).toHaveURL(/\/en\/sign-in\?next=%2Fadmin%2Fbooks%2Fnew$/);
  await expect(page.locator('input[name="next"]')).toHaveValue("/admin/books/new");
});
