import { expect, test } from "@playwright/test";

test("redirects the root URL to the Vietnamese home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/vi$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});
