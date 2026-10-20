import { type Page, expect, test } from "@playwright/test";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";

async function user(isAdmin = false) {
  const service = createServiceRoleClient();
  const email = `${"reader".repeat(7)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "admin-users-password-1";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: profile, error: profileError } = await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
  if (profileError) throw profileError;
  if (isAdmin) {
    const { error: roleError } = await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
    if (roleError) throw roleError;
  }
  return { email, password, profileId: profile.id as string };
}

async function login(page: Page, email: string, next: string) {
  const { data, error } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  await page.goto(`/auth/callback?${new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next, locale: "en" })}`);
  await expect(page).toHaveURL(new RegExp(`${next}$`));
}

test("an admin searches a verified reader, grants and revokes access with reasons at mobile width", async ({ page, browser }) => {
  const reader = await user();
  const operator = await user(true);
  const context = await browser.newContext();
  const readerPage = await context.newPage();
  await login(readerPage, reader.email, "/en/account");
  await context.close();
  const session = createAnonClient();
  const { error: signInError } = await session.auth.signInWithPassword({ email: operator.email, password: operator.password });
  if (signInError) throw signInError;
  const slug = `grant-${Date.now()}`;
  const title = `Quan sát ${"W".repeat(180)}`;
  const { data: bookId, error: bookError } = await session.rpc("admin_create_book", { p_canonical_key: slug, p_author_name: "Grant author", p_locale: "vi", p_language: "vi", p_title: title, p_slug: slug, p_market: "VN", p_currency: "VND", p_price_minor: 0 });
  if (bookError) throw bookError;
  await login(page, operator.email, "/admin/users");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByLabel("Email", { exact: true }).fill("ab");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(/Use at least 3 characters/)).toBeVisible();
  await page.getByLabel("Email", { exact: true }).fill(reader.email.toUpperCase());
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("link", { name: reader.email, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("link", { name: reader.email, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${reader.profileId}$`));
  await expect(page.getByText(/verified email/)).toBeVisible();
  await page.getByLabel("Book", { exact: true }).selectOption(bookId);
  const reason = "Reviewer".repeat(30);
  await page.getByLabel("Reason", { exact: true }).fill(reason);
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByTestId("entitlement-message")).toHaveText("Access granted.");
  const row = page.getByRole("row").filter({ has: page.getByRole("rowheader", { name: title, exact: true }) });
  await expect(row.getByRole("cell", { name: "admin_grant", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "active", exact: true })).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Skip to main content", exact: true });
  const hiddenSkip = await skipLink.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    padding: getComputedStyle(element).padding,
    overflow: getComputedStyle(element).overflow,
  }));
  expect(hiddenSkip).toEqual({ width: 1, padding: "0px", overflow: "hidden" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole("heading", { level: 1 }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await skipLink.focus();
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toBeInViewport();
  const focusedSkipBox = (await skipLink.boundingBox())!;
  expect(focusedSkipBox.height).toBeGreaterThanOrEqual(44);
  expect(focusedSkipBox.x).toBeGreaterThanOrEqual(0);
  expect(focusedSkipBox.x + focusedSkipBox.width).toBeLessThanOrEqual(375);
  await skipLink.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  for (const button of await page.getByRole("button", { name: /^(Grant access|Revoke)$/ }).all()) {
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  const service = createServiceRoleClient();
  const { data: library, error: libraryError } = await service.from("library_items").select("entitlement_id").eq("profile_id", reader.profileId).eq("book_id", bookId).single();
  if (libraryError) throw libraryError;
  expect(library.entitlement_id).toBeTruthy();
  page.once("dialog", (dialog) => dialog.accept(""));
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("entitlement-message")).toHaveText("A reason is required to revoke complimentary access.");
  await expect(row.getByRole("cell", { name: "active", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Review complete"));
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByTestId("entitlement-message")).toHaveText("Access revoked.");
  await expect(row.getByRole("cell", { name: "revoked", exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Revoke" })).toHaveCount(0);
  const { data: entitlement, error: entitlementError } = await service.from("entitlements").select("status,reason,revoked_at").eq("id", library.entitlement_id).single();
  if (entitlementError) throw entitlementError;
  expect(entitlement).toMatchObject({ status: "revoked", reason });
  expect(entitlement.revoked_at).toBeTruthy();
  const { data: audit, error: auditError } = await service.from("audit_logs").select("reason,actor_profile_id").eq("entity_id", library.entitlement_id).eq("action", "revoke_complimentary_entitlement").single();
  if (auditError) throw auditError;
  expect(audit).toEqual({ reason: "Review complete", actor_profile_id: operator.profileId });
});

test("user routes and identity reads deny anonymous and non-admin callers", async ({ page }) => {
  const reader = await user();
  const other = await user();
  const operator = await user(true);
  // Seed a real foreign entitlement and a verified identity: empty tables would let a missing
  // ownership policy pass the privacy assertion below without hiding anything.
  await login(page, other.email, "/en/account");
  const adminSession = createAnonClient();
  const { error: adminLoginError } = await adminSession.auth.signInWithPassword({ email: operator.email, password: operator.password });
  if (adminLoginError) throw adminLoginError;
  const slug = `private-grant-${Date.now()}`;
  const { data: bookId, error: bookError } = await adminSession.rpc("admin_create_book", { p_canonical_key: slug, p_author_name: slug, p_locale: "vi", p_language: "vi", p_title: slug, p_slug: slug, p_market: "VN", p_currency: "VND", p_price_minor: 0 });
  if (bookError) throw bookError;
  const { error: grantError } = await adminSession.rpc("grant_complimentary_entitlement", { p_profile_id: other.profileId, p_book_id: bookId, p_reason: "Foreign entitlement privacy fixture" });
  if (grantError) throw grantError;
  for (const table of ["customer_identities", "entitlements"]) {
    const { count, error } = await createServiceRoleClient().from(table).select("id", { count: "exact", head: true }).eq("profile_id", other.profileId);
    if (error) throw error;
    expect(count, `${table} has a real foreign row to protect`).toBe(1);
  }
  await page.context().clearCookies();
  const paths = ["/admin/users?q=reader", `/admin/users/${other.profileId}`];
  for (const path of paths) { await page.goto(path); await expect(page).toHaveURL(/\/sign-in\?next=/); }
  await login(page, reader.email, "/en/account");
  for (const path of paths) {
    expect((await page.goto(path))?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByText(other.email, { exact: true })).toHaveCount(0);
  }
  const session = createAnonClient();
  const { error: loginError } = await session.auth.signInWithPassword({ email: reader.email, password: reader.password });
  if (loginError) throw loginError;
  for (const table of ["customer_identities", "entitlements"]) {
    const { data, error } = await session.from(table).select("*").eq("profile_id", other.profileId);
    if (error) throw error;
    expect(data).toEqual([]);
  }
});
