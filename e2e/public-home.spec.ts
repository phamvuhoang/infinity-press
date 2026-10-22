import { expect, test } from "@playwright/test";

test("redirects the root URL to the English home page", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("home presents the Press platform without the previous brand or an author band", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByRole("link", { name: "Infinity Books Press" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "One work, many editions." })).toBeVisible();
  await expect(page.locator('img[src*="infinity-logo"]')).toHaveCount(0);
  await expect(page.locator("#home-author-title")).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toMatch(/Phuong Bui|Phương Bùi|infinitybooks\.vn/i);
});

for (const [locale, title] of [
  ["vi", "Một tác phẩm. Nhiều ngôn ngữ. Cùng thảo luận."],
  ["en", "One classic. Many languages. A shared conversation."],
  ["ja", "一つの古典。多くの言語。ひとつの対話。"],
] as const) {
  test(`home leads with the positioning title in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  });
}
