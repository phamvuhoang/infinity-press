import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

async function createUser(adminRole: boolean) {
  const admin = createServiceRoleClient();
  const email = `entity-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "entity-admin-password-1";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: profile, error: profileError } = await admin.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
  if (profileError) throw profileError;
  if (adminRole) {
    const { error: roleError } = await admin.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
    if (roleError) throw roleError;
  }
  return { email, password, profileId: profile.id };
}

async function signIn(page: Page, user: Awaited<ReturnType<typeof createUser>>, path: string) {
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent(path)}`);
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

for (const [type, path] of [["author", "authors"], ["series", "series"], ["topic", "topics"]] as const) {
  test(`an admin creates, localizes, and publishes a ${type} with audited writes`, async ({ page }) => {
    const user = await createUser(true);
    // A hyphenated slug supplies natural line breaks and misses overflow from valid single tokens.
    const slug = `${type}${Date.now()}${Math.random().toString(36).slice(2, 8)}`.padEnd(200, "a");
    const name = "W".repeat(200);
    await signIn(page, user, `/admin/${path}/new`);
    await page.getByLabel("Canonical slug", { exact: true }).fill(slug);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: `Create ${type}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/${path}/[0-9a-f-]{36}$`));
    const id = page.url().split("/").at(-1)!;

    // Publishing before copy exists must fail without a database write.
    await page.getByLabel("Status").selectOption("published");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByLabel("Status")).toHaveAccessibleDescription("Add copy in at least one language before publishing.");
    await expect(page.getByLabel("Status")).toHaveValue("published");

    await page.getByLabel("Slug (vi)", { exact: true }).fill(slug);
    await page.getByLabel("Name (vi)", { exact: true }).fill(`Bản tiếng Việt ${type}`);
    await page.getByLabel("Description (vi)").fill("Mô tả tiếng Việt.");
    await page.getByRole("button", { name: "Save vi copy" }).click();
    await expect(page.getByTestId("form-saved")).toHaveCount(1);
    await page.getByLabel("Status").selectOption("published");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("form-saved")).toHaveCount(2);

    // Narrow layouts must retain the form controls without horizontal scrolling.
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const heading = page.getByRole("heading", { level: 1, name, exact: true });
    expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const headerDetails = page.getByText(`${slug} · published`, { exact: true });
    expect(await headerDetails.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.goto(`/admin/${path}`);
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name, exact: true }) }).filter({ hasText: slug });
    await expect(row.getByRole("cell", { name: /^vi/ })).toBeVisible();
    await expect(row.getByRole("cell", { name: "published", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const { data: audits, error } = await createServiceRoleClient().from("audit_logs").select("action,actor_profile_id").eq("entity_id", id).order("created_at");
    if (error) throw error;
    expect(audits?.map((row) => row.action)).toEqual(["catalog_insert", `save_${type}_localization`, "catalog_update"]);
    expect(audits?.every((row) => row.actor_profile_id === user.profileId)).toBe(true);
  });
}

test("all entity routes deny anonymous and signed-in non-admin readers", async ({ page }) => {
  const paths = ["authors", "series", "topics"].flatMap((type) => [ `/admin/${type}`, `/admin/${type}/new`, `/admin/${type}/4a1b2c3d-0000-4000-8000-000000000001` ]);
  for (const path of paths) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
  }
  const user = await createUser(false);
  const { data, error } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email: user.email });
  if (error) throw error;
  const params = new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next: "/en/account", locale: "en" });
  await page.goto(`/auth/callback?${params}`);
  await expect(page).toHaveURL(/\/en\/account$/);
  for (const path of paths) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
});
