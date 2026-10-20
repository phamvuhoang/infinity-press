import { expect, test } from "@playwright/test";

// Ruling CI: E2E_MAILPIT_URL is required at Playwright config load (e2e/support/required-env.ts)
// and fails the run when absent, so this spec no longer skips itself into invisibility.
import { readLatestLink } from "./support/mailpit";

test("a magic link opened on another device signs the reader in at the requested page", async ({
  browser,
  page,
}) => {
  const email = `reader-${Date.now()}@example.test`;

  await page.goto("/en/account");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();

  const otherDevice = await browser.newContext();
  const phone = await otherDevice.newPage();
  await phone.goto(await readLatestLink(email));

  await expect(phone).toHaveURL(/\/en\/account$/);
  await expect(phone.getByText(email)).toBeVisible();
  await otherDevice.close();
});
