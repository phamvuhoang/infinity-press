import { type Page, expect, test } from "@playwright/test";

// Ruling CI: E2E_MAILPIT_URL is required at Playwright config load (e2e/support/required-env.ts)
// and fails the run when absent, so this spec no longer skips itself into invisibility.
import { readLatestLink } from "./support/mailpit";
import { createServiceRoleClient } from "./support/supabase";

// Password sign-in is an admin-only internal fallback (app/internal/[lang]/*): the signIn
// action signs a non-admin straight back out, and the update-password page answers a non-admin
// with a 403. Fixtures therefore have to say which kind of account they want - an admin for the
// working flows, a plain reader for the two deny paths at the bottom of this file.
async function createUser({ password, admin: isAdmin }: { password?: string; admin: boolean }) {
  const email = `staff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  if (!isAdmin) return email;

  // The handle_auth_user_change trigger has already created this user's profile row by the
  // time createUser() returns, so grant admin through user_roles before returning.
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", data.user.id)
    .single();
  if (profileError) throw profileError;

  const { error: roleError } = await admin.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
  if (roleError) throw roleError;

  return email;
}

function createPasswordUser(password: string, { admin = true } = {}) {
  return createUser({ password, admin });
}

// Signs a passwordless customer in without spending an auth email: the admin API mints the same
// token hash supabase/templates/magic-link.html would have mailed, and /auth/callback verifies it
// exactly as it verifies an emailed one.
async function signInWithMagicLink(page: Page, email: string) {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;

  const params = new URLSearchParams({
    token_hash: data.properties.hashed_token,
    type: "email",
    next: "/en/account",
    locale: "en",
  });
  await page.goto(`/auth/callback?${params}`);
  await expect(page).toHaveURL(/\/en\/account$/);
}

async function submitPassword(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
}

test("a wrong password stays on the internal form and the right one continues", async ({ page }) => {
  const email = await createPasswordUser("correct-horse-1");

  await page.goto("/internal/en/sign-in?next=%2Fen%2Faccount");
  await submitPassword(page, email, "wrong-password-1");

  await expect(page).toHaveURL(/\/internal\/en\/sign-in\?next=%2Fen%2Faccount&error=credentials$/);
  await expect(page.getByText("The email or password is incorrect.")).toBeVisible();

  await submitPassword(page, email, "correct-horse-1");
  await expect(page).toHaveURL(/\/en\/account$/);
  await expect(page.getByText(email)).toBeVisible();
});

test("a recovery link opened on another device sets a password that signs in", async ({
  browser,
  page,
}) => {
  const email = await createPasswordUser("original-pass-1");

  await page.goto("/internal/en/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send recovery link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();

  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await phone.goto(await readLatestLink(email));
  await expect(phone).toHaveURL(/\/internal\/en\/update-password$/);
  await phone.getByLabel("New password", { exact: true }).fill("replacement-pass-1");
  await phone.getByLabel("Confirm new password").fill("replacement-pass-1");
  await phone.getByRole("button", { name: "Update password" }).click();
  await expect(phone).toHaveURL(/\/en\/account\?message=password-updated$/);
  await expect(phone.getByText("Your password was updated.")).toBeVisible();
  await phoneContext.close();

  const laptopContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  await laptop.goto("/internal/en/sign-in");
  await submitPassword(laptop, email, "replacement-pass-1");
  await expect(laptop).toHaveURL(/\/en\/account$/);
  await laptopContext.close();
});

// The first of the two authorization deny paths. Nothing stops a passworded non-admin existing -
// auth.admin.createUser({ password }) and the Supabase dashboard both mint one - so the internal
// sign-in has to refuse them after authenticating.
test("a non-admin holding a password cannot sign in through the internal fallback", async ({
  page,
}) => {
  const email = await createPasswordUser("reader-pass-1", { admin: false });

  await page.goto("/internal/en/sign-in?next=%2Fen%2Faccount");
  await submitPassword(page, email, "reader-pass-1");

  await expect(page).toHaveURL(/\/internal\/en\/sign-in\?next=%2Fen%2Faccount&error=staff-only$/);
  await expect(page.getByText("Password sign-in is limited to staff accounts.")).toBeVisible();

  // Signed back out, not merely bounced: the session that authenticated must not survive.
  await page.goto("/en/account");
  await expect(page).toHaveURL(/\/en\/sign-in\?next=%2Fen%2Faccount$/);
});

// The second deny path, and the one Ruling T's fixture change stopped covering. Ruling G leaves
// recovery open to everyone, so a magic-link customer really can arrive here with a valid session
// and no admin role; requireAdmin() answers with app/internal/[lang]/forbidden.tsx rather than
// a redirect.
test("a non-admin magic-link user gets the 403 page at internal update-password", async ({
  page,
}) => {
  const email = await createUser({ admin: false });
  await signInWithMagicLink(page, email);

  const response = await page.goto("/internal/en/update-password");

  expect(response?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
});

// /admin has no locale segment and its pages are written in English, so the 403 that guards them
// has to be English too. It rendered Vietnamese - defaultLocale - until the Proxy started
// resolving /admin/** to `en`, which meant one route answered a denied admin in one language and
// an admitted admin in another.
test("the /admin 403 speaks the same language as the admin pages it guards", async ({ page }) => {
  const email = await createUser({ admin: false });
  await signInWithMagicLink(page, email);

  const response = await page.goto("/admin");

  expect(response?.status()).toBe(403);
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
});
