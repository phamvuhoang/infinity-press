import { expect, test } from "@playwright/test";

test("marks the default Vietnamese home page with its document language", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/vi$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByRole("link", { name: "Đăng nhập" }).first()).toBeVisible();
});

test("renders the English home page in English", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
});

test("sends an anonymous reader to localized sign-in with the original destination", async ({
  page,
}) => {
  await page.goto("/en/account");
  await expect(page).toHaveURL(/\/en\/sign-in\?next=%2Fen%2Faccount$/);
  await expect(page.getByText("Sign in with email")).toBeVisible();
  await expect(page.locator('input[name="next"]')).toHaveValue("/en/account");
});

test("sends an anonymous admin visitor to sign-in without losing the admin destination", async ({
  page,
}) => {
  await page.goto("/admin/books/new");
  await expect(page).toHaveURL(/\/vi\/sign-in\?next=%2Fadmin%2Fbooks%2Fnew$/);
  await expect(page.locator('input[name="next"]')).toHaveValue("/admin/books/new");
});
