import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

// Ruling CI: this spec used to skip itself when the runner had no Supabase environment. That is
// how a bare `npm run test:e2e` ran 7 of 20 specs and still exited 0. The requirement is now
// enforced once, at Playwright config load (e2e/support/required-env.ts), and fails the whole run
// instead - so there is nothing left for a per-spec guard to do, and leaving one would only
// restore the ability to disappear quietly.

// Mirrors e2e/internal-password.spec.ts's createUser(): the admin catalog workflow lives entirely
// under /admin, so every test here needs a real admin session, minted the same way (a confirmed
// password user, then a user_roles grant once the auth trigger has created its profile row).
async function createAdminUser() {
  const email = `book-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "book-admin-password-1";
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", data.user.id)
    .single();
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

test("an admin saves every editor section, sees validation, and reloads saved values at 375px", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const service = createServiceRoleClient();
  const { data: topic, error: topicError } = await service.from("topics").insert({ canonical_slug: `editor-topic-${unique}`, name: `Editor topic ${unique}` }).select("id, name").single();
  if (topicError) throw topicError;
  const { data: series, error: seriesError } = await service.from("series").insert({ canonical_slug: `editor-series-${unique}`, display_name: `Editor series ${unique}` }).select("id").single();
  if (seriesError) throw seriesError;
  await signInAsAdmin(page, email, password);
  await page.getByLabel("Canonical key").fill(`editor-${unique}`);
  await page.getByLabel("Author name").fill(`Editor Author ${unique}`);
  await page.getByLabel("Title").fill("Editor book");
  await page.getByLabel("Slug").fill(`editor-${unique}`);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("0");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  const bookId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("link", { name: /English/ })).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  const save = async (label: string) => {
    const button = page.getByRole("button", { name: label, exact: true });
    const form = page.locator("form").filter({ has: button });
    await button.click();
    await expect(form.getByRole("status")).toHaveText("Saved.");
  };
  await page.getByLabel("Canonical key").fill(`edited-${unique}`);
  await page.getByLabel("Book language").selectOption("en");
  await save("Save details");
  const longTitle = "LongTitle".repeat(30);
  await page.getByLabel("Title (vi)", { exact: true }).fill(longTitle);
  await page.getByLabel("Description (vi)", { exact: true }).fill("Mô tả đã lưu");
  await page.getByLabel("Key ideas (vi)").fill("Quan sát | Nhìn mà không phán xét\nTự do");
  await page.getByLabel("FAQ (vi)").fill("Q: Đọc ở đâu?\nA: Trên web.");
  await save("Save vi copy");
  await page.getByLabel("Title (en)", { exact: true }).fill("Saved English title");
  await page.getByLabel("Slug (en)").fill(`english-${unique}`);
  await save("Save en copy");
  await page.getByLabel(topic.name, { exact: true }).check();
  await page.getByLabel("Series", { exact: true }).selectOption(series.id);
  await page.getByRole("button", { name: "Save relations" }).click();
  await expect(page.getByLabel("Series position")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("Series position").fill("1");
  await save("Save relations");
  await page.reload();
  await expect(page.getByLabel("Canonical key")).toHaveValue(`edited-${unique}`);
  await expect(page.getByLabel("Book language")).toHaveValue("en");
  await expect(page.getByLabel("Title (vi)", { exact: true })).toHaveValue(longTitle);
  await expect(page.getByLabel("Title (en)", { exact: true })).toHaveValue("Saved English title");
  await expect(page.getByLabel("Key ideas (vi)")).toHaveValue("Quan sát | Nhìn mà không phán xét\nTự do");
  await expect(page.getByLabel("FAQ (vi)")).toHaveValue("Q: Đọc ở đâu?\nA: Trên web.");
  await expect(page.getByLabel(topic.name, { exact: true })).toBeChecked();
  await expect(page.getByLabel("Series position")).toHaveValue("1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const button of await page.getByRole("button", { name: /^Save / }).all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // Edition details, credits and the offer live on the edition's own page.
  await page.getByRole("link", { name: /English/ }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}\/editions\/[0-9a-f-]{36}$/);
  await page.getByLabel("Edition number").fill("2");
  await page.getByLabel("Publication date").fill("2026-09-14");
  await page.getByLabel("Credits").fill("translator: E2E Translator");
  await save("Save edition");
  await page.locator("#offer-priceMinor").fill("2500");
  await page.getByLabel("Offer is active").uncheck();
  await save("Save offer");
  await page.reload();
  await expect(page.getByLabel("Edition number")).toHaveValue("2");
  await expect(page.getByLabel("Publication date")).toHaveValue("2026-09-14");
  await expect(page.getByLabel("Credits")).toHaveValue("translator: E2E Translator");
  await expect(page.locator("#offer-priceMinor")).toHaveValue("2500");
  await expect(page.getByLabel("Offer is active")).not.toBeChecked();
  await page.goto(`/admin/books/${bookId}`);
  const { data: audit, error: auditError } = await service.from("audit_logs").select("action, entity_type").eq("entity_id", bookId);
  if (auditError) throw auditError;
  expect(audit?.filter((row) => row.action === "save_book_localization")).toHaveLength(2);
  expect(audit?.some((row) => row.action === "set_book_relations")).toBe(true);
  expect(audit?.some((row) => row.action === "catalog_update" && row.entity_type === "books")).toBe(true);
  const { data: edition } = await service.from("editions").select("id").eq("book_id", bookId).single();
  const { data: editionAudit } = await service.from("audit_logs").select("id").eq("entity_id", edition!.id).eq("action", "catalog_update");
  expect(editionAudit).toHaveLength(1);
  const { data: sku } = await service.from("skus").select("id").eq("edition_id", edition!.id).single();
  const { data: offer } = await service.from("offers").select("id").eq("sku_id", sku!.id).single();
  const { data: offerAudit } = await service.from("audit_logs").select("id").eq("entity_id", offer!.id).eq("action", "catalog_update");
  expect(offerAudit).toHaveLength(1);
  const primaryAuthorId = await page.getByLabel("Primary author").inputValue();
  const { data: other, error: otherError } = await service.from("books").insert({ canonical_key: `collision-${unique}`, original_language: "vi", primary_author_id: primaryAuthorId }).select("id").single();
  if (otherError) throw otherError;
  const { error: collisionError } = await service.from("book_localizations").insert({ book_id: other.id, locale: "vi", title: "Collision", slug: `taken-${unique}` });
  if (collisionError) throw collisionError;
  await page.getByLabel("Slug (vi)").fill(`taken-${unique}`);
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.getByText("A book with this locale and slug already exists.")).toBeVisible();
  await expect(page.getByLabel("Slug (vi)")).toHaveAttribute("aria-describedby", "slug-vi-error");
});

test("an admin creates a book and lands on its detail page", async ({ page }) => {
  const { email, password } = await createAdminUser();
  // admin_create_ebook derives the author's canonical_slug from the name, so the author name
  // must be unique per test (and per run against a persistent dev DB) too, not just the
  // canonical key/slug - otherwise this collides on authors.canonical_slug against the other
  // test in this file, or an earlier run, before ever reaching the book being created here.
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await signInAsAdmin(page, email, password);

  await page.getByLabel("Canonical key").fill(`the-e2e-book-${unique}`);
  await page.getByLabel("Author name").fill(`E2E Author ${unique}`);
  await page.getByLabel("Title").fill("The E2E Book");
  await page.getByLabel("Slug").fill(`the-e2e-slug-${unique}`);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("1500");
  await page.getByRole("button", { name: "Create book" }).click();

  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "The E2E Book" })).toBeVisible();
  await expect(page.getByText(new RegExp(`^E2E Author ${unique} ·`))).toBeVisible();
  await expect(page.getByText("Draft · default · 1 offer")).toBeVisible();
});

test("an admin reuses an author and finds the second book through the books search", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const authorName = `E2E Reused Author ${unique}`;
  const first = {
    canonicalKey: `e2e-reused-first-${unique}`,
    title: `E2E Reused First ${unique}`,
    slug: `e2e-reused-first-${unique}`,
  };
  const second = {
    canonicalKey: `e2e-reused-second-${unique}`,
    title: `E2E Reused Search Result ${unique}`,
    slug: `e2e-reused-second-${unique}`,
  };

  await signInAsAdmin(page, email, password);

  for (const book of [first, second]) {
    await page.getByLabel("Canonical key").fill(book.canonicalKey);
    await page.getByLabel("Author name").fill(authorName);
    await page.getByLabel("Title").fill(book.title);
    await page.getByLabel("Slug").fill(book.slug);
    await page.getByLabel("Market").fill("VN");
    await page.getByLabel("Currency").fill("VND");
    await page.getByLabel("Price (minor units)").fill("1500");
    await page.getByRole("button", { name: "Create book" }).click();
    await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
    if (book === first) await page.goto("/admin/books/new");
  }

  const service = createServiceRoleClient();
  const { data: authors, error: authorError } = await service.from("authors").select("id").eq("display_name", authorName);
  if (authorError) throw authorError;
  expect(authors).toHaveLength(1);

  const { data: books, error: bookError } = await service
    .from("books")
    .select("primary_author_id")
    .in("canonical_key", [first.canonicalKey, second.canonicalKey]);
  if (bookError) throw bookError;
  expect(books).toHaveLength(2);
  expect(books?.every((book) => book.primary_author_id === authors?.[0]?.id)).toBe(true);

  await page.goto(`/admin/books?q=${encodeURIComponent(second.canonicalKey)}`);
  await expect(page.getByLabel("Search books")).toHaveValue(second.canonicalKey);
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: second.title, exact: true }) });
  await expect(row).toContainText(authorName);
  await expect(row).toContainText(second.canonicalKey);
  await expect(page.getByRole("link", { name: first.title, exact: true })).toHaveCount(0);
});

test("a duplicate locale and slug is rejected as a validation error, not a crash or a raw Postgres message", async ({
  page,
}) => {
  const { email, password } = await createAdminUser();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = `the-e2e-dup-slug-${unique}`;

  await signInAsAdmin(page, email, password);

  await page.getByLabel("Canonical key").fill(`the-e2e-dup-book-${unique}`);
  await page.getByLabel("Author name").fill(`E2E Author ${unique}`);
  await page.getByLabel("Title").fill("The Duplicate Book");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("1500");
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);

  // A second, different book that collides on the same locale + slug. Uses a *different* author
  // name from the first submission on purpose (mirrors pgTAP's Ruling AL fix): reusing the same
  // name would collide on authors.canonical_slug before book_localizations is ever reached,
  // rejecting the call for the wrong reason while still showing the same 23505-derived message -
  // exactly the defect Ruling AL fixed in the pgTAP test, one layer down.
  await page.goto("/admin/books/new");
  await page.getByLabel("Canonical key").fill(`the-e2e-dup-book-2-${unique}`);
  await page.getByLabel("Author name").fill(`E2E Other ${unique}`);
  await page.getByLabel("Title").fill("The Duplicate Book");
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("1500");
  await page.getByRole("button", { name: "Create book" }).click();

  // Stays on the form with a field-level error - no navigation away, no crash, and no raw
  // Postgres/Supabase error text reaching the page.
  await expect(page).toHaveURL(/\/admin\/books\/new$/);
  await expect(page.getByText("A book with this locale and slug already exists.")).toBeVisible();
  await expect(page.getByText(/duplicate key value|violates|23505|postgrest/i)).toHaveCount(0);
});
