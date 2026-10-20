import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

// Ruling CI: the environment this spec needs (a real Supabase stack, storage included) is
// required once at Playwright config load and fails the run when absent, rather than being
// skipped here. See e2e/support/required-env.ts.

// Mirrors e2e/admin-create-book.spec.ts's createAdminUser().
async function createAdminUser() {
  const email = `epub-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "epub-admin-password-1";
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

// Builds a book graph directly through the service-role client rather than the admin_create_ebook
// RPC: that RPC checks is_admin() via auth.uid(), which resolves to null under the service role
// (the same trap Ruling W and Ruling AE describe), so it can't be called this way. Only what this
// spec needs - an edition to upload against - is created; no SKU or offer.
async function createBookWithEdition() {
  const admin = createServiceRoleClient();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { data: author, error: authorError } = await admin
    .from("authors")
    .insert({ canonical_slug: `epub-e2e-author-${unique}`, display_name: `Epub E2E Author ${unique}` })
    .select("id")
    .single();
  if (authorError) throw authorError;

  const { data: book, error: bookError } = await admin
    .from("books")
    .insert({ canonical_key: `epub-e2e-book-${unique}`, original_language: "en", primary_author_id: author.id })
    .select("id")
    .single();
  if (bookError) throw bookError;

  const { error: localizationError } = await admin
    .from("book_localizations")
    .insert({ book_id: book.id, locale: "en", slug: `epub-e2e-slug-${unique}`, title: "The Epub E2E Book" });
  if (localizationError) throw localizationError;

  const { data: edition, error: editionError } = await admin
    .from("editions")
    .insert({ book_id: book.id, language_code: "en" })
    .select("id")
    .single();
  if (editionError) throw editionError;

  return { bookId: book.id as string, editionId: edition.id as string };
}

async function signInAsAdmin(page: Page, email: string, password: string, next: string) {
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
}

test("an admin uploads an EPUB and it is queued for processing", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const { bookId, editionId } = await createBookWithEdition();

  await signInAsAdmin(page, email, password, `/admin/books/${bookId}/editions/${editionId}`);

  await page.locator("#epub-file").setInputFiles({
    name: "e2e-book.epub",
    mimeType: "application/epub+zip",
    buffer: Buffer.from("fake epub bytes for e2e coverage, not a real archive"),
  });
  await page.getByRole("button", { name: "Upload EPUB" }).click();

  // Scoped to the EPUB section rather than the page: the edition page carries other live regions
  // (one per form), so a page-wide status locator is ambiguous.
  const status = page.locator("#epub").getByRole("status");
  await expect(status).toContainText("Queued for processing. Job", { timeout: 15_000 });

  // The database side of "queued for processing": one ebook_assets row for this edition, moved
  // to 'queued' with a checksum recorded, and exactly one queued processing_jobs row targeting it.
  const admin = createServiceRoleClient();
  const { data: asset, error: assetError } = await admin
    .from("ebook_assets")
    .select("id, status, source_checksum, source_storage_key")
    .eq("edition_id", editionId)
    .single();
  if (assetError) throw assetError;
  expect(asset.status).toBe("queued");
  expect(asset.source_checksum).toMatch(/^[0-9a-f]{64}$/);
  // Bucket-relative, not bucket-qualified: storage-js's uploadToSignedUrl/download already
  // prepend the bucket id to whatever path is stored here, so the column itself must not repeat
  // "ebook-source/" (Ruling AU).
  expect(asset.source_storage_key).toBe(`${editionId}/${asset.id}/source.epub`);

  const { data: jobs, error: jobsError } = await admin
    .from("processing_jobs")
    .select("status, correlation_id")
    .eq("target_id", asset.id);
  if (jobsError) throw jobsError;
  expect(jobs).toHaveLength(1);
  expect(jobs[0].status).toBe("queued");
  expect(jobs[0].correlation_id).toBeTruthy();
});

test("a non-EPUB file is rejected client-side, with no server round trip", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const { bookId, editionId } = await createBookWithEdition();

  await signInAsAdmin(page, email, password, `/admin/books/${bookId}/editions/${editionId}`);

  // A Server Action call is a POST to the current page URL carrying a Next-Action header - track
  // every POST from here on so the "no server round trip" half of this test's title is actually
  // proven, not just implied by the button being disabled.
  const postRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") postRequests.push(request.url());
  });

  await page.locator("#epub-file").setInputFiles({
    name: "not-a-book.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("plain text, not an epub"),
  });

  await expect(page.getByText("Choose a file with a .epub extension.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload EPUB" })).toBeDisabled();
  expect(postRequests).toEqual([]);
});
