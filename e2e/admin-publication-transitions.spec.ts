import { approveEditionDirectly } from "./support/editions";
import { type Page, expect, test } from "@playwright/test";

import { createServiceRoleClient } from "./support/supabase";

// Ruling CI: the environment this spec needs (a real Supabase stack, storage included) is
// required once at Playwright config load and fails the run when absent, rather than being
// skipped here. See e2e/support/required-env.ts.

// Mirrors e2e/admin-create-book.spec.ts's createAdminUser().
async function createAdminUser() {
  const email = `pub-admin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const password = "pub-admin-password-1";
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

// Seeds a book/edition and a ready_for_preview publication directly through the service-role
// client - the same escape hatch e2e/admin-epub-upload.spec.ts uses for admin_create_ebook (its
// is_admin() check can never pass under the service role, per Ruling W/AE) - rather than driving
// a real EPUB through the CLI worker just to get one ready_for_preview row. That pipeline is
// already covered end-to-end by Task 5's worker tests and e2e/admin-epub-upload.spec.ts; this
// spec is about what Task 6 adds once a publication exists.
async function seedReadyPublication() {
  const admin = createServiceRoleClient();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const { data: author, error: authorError } = await admin
    .from("authors")
    .insert({ canonical_slug: `pub-e2e-author-${unique}`, display_name: `Pub E2E Author ${unique}` })
    .select("id")
    .single();
  if (authorError) throw authorError;

  const { data: book, error: bookError } = await admin
    .from("books")
    .insert({ canonical_key: `pub-e2e-book-${unique}`, original_language: "en", primary_author_id: author.id })
    .select("id")
    .single();
  if (bookError) throw bookError;

  const { error: localizationError } = await admin
    .from("book_localizations")
    .insert({ book_id: book.id, locale: "en", slug: `pub-e2e-slug-${unique}`, title: `Pub E2E Book ${unique}` });
  if (localizationError) throw localizationError;

  const { data: edition, error: editionError } = await admin
    .from("editions")
    .insert({ book_id: book.id, language_code: "en" })
    .select("id")
    .single();
  if (editionError) throw editionError;
  await approveEditionDirectly(edition.id);

  const { data: asset, error: assetError } = await admin
    .from("ebook_assets")
    .insert({
      edition_id: edition.id,
      source_storage_key: `${edition.id}/seed-${unique}/source.epub`,
      version: 1,
      status: "ready_for_preview",
    })
    .select("id")
    .single();
  if (assetError) throw assetError;

  const { data: publication, error: publicationError } = await admin
    .from("ebook_publications")
    .insert({
      ebook_asset_id: asset.id,
      version: 1,
      manifest_key: `${asset.id}/manifest.json`,
      epub_language: "en",
      toc_json: [{ title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] }],
      status: "ready_for_preview",
    })
    .select("id")
    .single();
  if (publicationError) throw publicationError;

  const storageKey = `${publication.id}/OEBPS/text/chapter1.xhtml`;
  const resourceBytes = "<html><body><p>Chapter 1 preview content</p></body></html>";
  const { error: uploadError } = await admin.storage
    .from("ebook-derived")
    .upload(storageKey, Buffer.from(resourceBytes), { contentType: "application/xhtml+xml" });
  if (uploadError) throw uploadError;

  const { error: resourceError } = await admin.from("ebook_resources").insert({
    publication_id: publication.id,
    href: "OEBPS/text/chapter1.xhtml",
    media_type: "application/xhtml+xml",
    storage_key: storageKey,
    byte_size: resourceBytes.length,
    sha256: "0".repeat(64),
    access_class: "paid",
  });
  if (resourceError) throw resourceError;

  return { bookId: book.id as string, assetId: asset.id as string, publicationId: publication.id as string };
}

async function signInAsAdmin(page: Page, email: string, password: string, next: string) {
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
}

test("an admin previews a ready-for-preview version and publishes it", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const { bookId, assetId, publicationId } = await seedReadyPublication();

  await signInAsAdmin(page, email, password, `/admin/publications/${assetId}`);

  await expect(page.getByTestId("publication-lifecycle")).toContainText("Ready for preview");

  // The preview genuinely streams the private derived resource through the admin-gated route -
  // not a placeholder - proving the whole authorize-then-resolve-then-stream path end to end.
  const frame = page.frameLocator("iframe[title='Preview of OEBPS/text/chapter1.xhtml']");
  await expect(frame.getByText("Chapter 1 preview content")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  // Fix round 1, Minor #7: publication-status.tsx also renders role="status" for the
  // queued/processing lifecycle - scoped to the preview card's own action-result message, not the
  // bare role, so a queued fixture in some other spec can never trip Playwright strict mode here.
  await expect(page.getByTestId("publication-action-message")).toContainText("Published.");
  await expect(page.getByTestId("publication-lifecycle")).toContainText("Published");
  await expect(page.getByTestId("publication-lifecycle")).toContainText("currently active");

  const admin = createServiceRoleClient();
  const { data: bookRow, error } = await admin.from("books").select("status").eq("id", bookId).single();
  if (error) throw error;
  const { data: editionRow, error: editionError } = await admin.from("editions").select("active_publication_id").eq("book_id", bookId).single();
  if (editionError) throw editionError;
  expect(editionRow.active_publication_id).toBe(publicationId);
  // Since migration 20260913120000, publishing a version moves the active pointer only; the book
  // stays draft until an admin publishes the book itself (covered by e2e/admin-catalog.spec.ts).
  expect(bookRow.status).toBe("draft");
});

test("an admin rejects a ready-for-preview version with a reason", async ({ page }) => {
  const { email, password } = await createAdminUser();
  const { assetId, publicationId } = await seedReadyPublication();

  await signInAsAdmin(page, email, password, `/admin/publications/${assetId}`);

  await page.getByRole("button", { name: "Reject", exact: true }).click();
  // Fix round 1, Minor #11: the Textarea now has an associated <label>, so this locates it the
  // same accessible way sign-in and the book form already do, rather than by placeholder text.
  await page.getByLabel("Reason for rejecting this version").fill("Needs another editing pass.");

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Confirm rejection" }).click();

  await expect(page.getByTestId("publication-action-message")).toContainText("Rejected.");

  const admin = createServiceRoleClient();
  const { data: publicationRow, error } = await admin
    .from("ebook_publications")
    .select("status")
    .eq("id", publicationId)
    .single();
  if (error) throw error;
  expect(publicationRow.status).toBe("rejected");
});

test("the preview resource route refuses an unauthenticated request", async ({ request }) => {
  const { publicationId } = await seedReadyPublication();

  const response = await request.get(
    `/api/admin/publications/${publicationId}/resources/OEBPS/text/chapter1.xhtml`,
    { maxRedirects: 0 },
  );

  // Fix round 1, Minor #6: pin the actual redirect requireAdmin() issues, not just "not 200" -
  // that assertion would also pass on a 500, proving something broke rather than proving the gate
  // fired. redirect() from a Route Handler (not a Server Action) always uses 307
  // (node_modules/next/dist/docs/01-app/02-guides/redirecting.md), and the route calls
  // requireAdmin() with no `next`/`locale`, so buildSignInRedirect resolves to the default
  // locale's own sign-in page with no query string.
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toContain("/en/sign-in");
  const body = await response.text();
  expect(body).not.toContain("Chapter 1 preview content");
});
