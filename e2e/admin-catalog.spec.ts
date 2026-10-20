import { execFileSync } from "node:child_process";
import { type Page, expect, test } from "@playwright/test";

import { validEpub } from "../scripts/fixtures/create-test-epub";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";

// S1 acceptance: deleting a section save, bypassing readiness, chaining slug redirects, or
// removing a page gate must fail here. Only account/role setup writes fixture rows directly;
// all book content goes through the operator UI and the supported local EPUB worker.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=", "base64");
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createUser(isAdmin: boolean) {
  const service = createServiceRoleClient();
  const email = `catalog-${unique()}@example.test`;
  const password = "catalog-admin-password-1";
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  const { data: profile, error: profileError } = await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single();
  if (profileError) throw profileError;
  if (isAdmin) {
    const { error: roleError } = await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" });
    if (roleError) throw roleError;
  }
  return { email, password, profileId: profile.id };
}

async function save(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  const form = page.locator("form").filter({ has: button });
  await button.click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
}

test("an operator builds, publishes, replaces the cover, renames, and unpublishes a complete launch book", async ({ page, request }) => {
  test.setTimeout(180_000);
  const suffix = unique();
  const operator = await createUser(true);
  const service = createServiceRoleClient();
  const session = createAnonClient();
  const { error: loginError } = await session.auth.signInWithPassword(operator);
  if (loginError) throw loginError;
  await page.goto("/internal/en/sign-in?next=%2Fadmin%2Fauthors%2Fnew");
  await page.getByLabel("Email").fill(operator.email);
  await page.getByLabel("Password").fill(operator.password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(/\/admin\/authors\/new$/);

  const names = { author: `Tác giả ${suffix}`, topic: `Chủ đề ${suffix}`, series: `Bộ sách ${suffix}` };
  for (const [type, path] of [["author", "authors"], ["topic", "topics"], ["series", "series"]] as const) {
    await page.goto(`/admin/${path}/new`);
    await page.getByLabel("Canonical slug").fill(`${type}-${suffix}`);
    await page.getByLabel("Name", { exact: true }).fill(names[type]);
    await page.getByRole("button", { name: `Create ${type}` }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/${path}/[0-9a-f-]{36}$`));
    for (const locale of ["vi", "en"]) {
      await page.getByLabel(`Slug (${locale})`).fill(`${type}-${locale}-${suffix}`);
      await page.getByLabel(`Name (${locale})`).fill(names[type]);
      await page.getByLabel(`Description (${locale})`).fill(`Catalog ${locale} copy.`);
      await save(page, `Save ${locale} copy`);
    }
    await page.getByLabel("Status").selectOption("published");
    await save(page, "Save");
  }

  const oldSlug = `catalog-${suffix}`;
  const newSlug = `catalog-renamed-${suffix}`;
  await page.goto("/admin/books/new");
  for (const [label, value] of [["Canonical key", oldSlug], ["Author name", names.author], ["Title", `Launch book ${suffix}`], ["Slug", oldSlug], ["Market", "VN"], ["Currency", "VND"], ["Price (minor units)", "0"]]) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  await page.getByRole("button", { name: "Create book" }).click();
  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  const bookId = new URL(page.url()).pathname.split("/").at(-1)!;
  const { count, error: authorError } = await service.from("authors").select("id", { count: "exact", head: true }).eq("display_name", names.author);
  if (authorError) throw authorError;
  expect(count, "author reused").toBe(1);
  await expect(page.getByRole("button", { name: "Publish book" })).toBeDisabled();
  const { error: blocked } = await session.rpc("publish_book", { p_book_id: bookId });
  expect(blocked?.code).toBe("EB010");
  expect(blocked?.message).toContain("missing_cover");
  expect(blocked?.message).toContain("missing_publication");

  await page.getByLabel("Canonical key").fill(`edited-${oldSlug}`);
  await save(page, "Save details");
  for (const locale of ["vi", "en"]) {
    await page.getByLabel(`Title (${locale})`, { exact: true }).fill(`Launch ${locale} ${suffix}`);
    await page.getByLabel(`Slug (${locale})`).fill(locale === "vi" ? oldSlug : `en-${oldSlug}`);
    await page.getByLabel(`Description (${locale})`, { exact: true }).fill(`A complete ${locale} description.`);
    await page.getByLabel(`Key ideas (${locale})`).fill("Quan sát | Nhìn mà không phán xét");
    await save(page, `Save ${locale} copy`);
  }
  // Edition details and the offer live on the edition's own page.
  await page.getByRole("link", { name: /English/ }).click();
  await expect(page).toHaveURL(/\/editions\/[0-9a-f-]{36}$/);
  const editionUrl = page.url();
  await page.getByLabel("Edition number").fill("2");
  await page.getByLabel("Publication date").fill("2026-09-14");
  await save(page, "Save edition");
  await page.locator("#offer-priceMinor").fill("1500");
  await save(page, "Save offer");
  await page.goto(`/admin/books/${bookId}`);
  await page.getByLabel(names.topic, { exact: true }).check();
  await page.getByLabel("Series", { exact: true }).selectOption({ label: names.series });
  await page.getByLabel("Series position").fill("1");
  await save(page, "Save relations");

  // Both formats must decode and refresh the preview; the replacement must retain one media row.
  const webp = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 2; canvas.height = 3;
    canvas.getContext("2d")!.fillRect(0, 0, 2, 3);
    return canvas.toDataURL("image/webp").split(",")[1];
  });
  let firstCoverKey = "";
  for (const [extension, buffer] of [["png", PNG], ["webp", Buffer.from(webp, "base64")]] as const) {
    await page.getByLabel("Cover image").setInputFiles({ name: `cover.${extension}`, mimeType: `image/${extension}`, buffer });
    await page.getByLabel("Cover alt text").fill(`Launch cover ${extension}`);
    await page.getByRole("button", { name: "Upload cover" }).click();
    await expect(page.getByTestId("cover-status")).toHaveText("Cover saved.");
    const preview = page.getByRole("img", { name: `Launch cover ${extension}`, exact: true });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const { data: covers, error } = await service.from("media_assets").select("storage_key,alt_text").eq("owner_id", bookId).eq("kind", "cover");
    if (error) throw error;
    expect(covers).toHaveLength(1);
    expect(covers![0].storage_key).toMatch(new RegExp(`\\.${extension}$`));
    if (extension === "png") firstCoverKey = covers![0].storage_key;
    else expect(covers![0].storage_key).not.toBe(firstCoverKey);
    const response = await request.get(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/covers/${covers![0].storage_key}`);
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(buffer);
    await expect(page.getByRole("link", { name: "Upload a cover image." })).toHaveCount(0);
  }

  await page.goto(editionUrl);
  await page.getByLabel("EPUB file").setInputFiles({ name: "launch.epub", mimeType: "application/epub+zip", buffer: Buffer.from(validEpub()) });
  await page.getByRole("button", { name: "Upload EPUB" }).click();
  await expect(page.locator("#epub").getByRole("status")).toContainText("Queued for processing. Job");
  const { data: edition, error: editionError } = await service.from("editions").select("id,edition_number,publication_date").eq("book_id", bookId).single();
  if (editionError) throw editionError;
  expect(edition).toMatchObject({ edition_number: 2, publication_date: "2026-09-14" });
  const { data: asset, error: assetError } = await service.from("ebook_assets").select("id,source_storage_key").eq("edition_id", edition.id).single();
  if (assetError) throw assetError;
  execFileSync("npm", ["run", "ebook", "--", "process", "--asset", asset.id], { env: process.env, stdio: "pipe" });
  await page.goto(`/admin/publications/${asset.id}`);
  await expect(page.getByTestId("publication-lifecycle")).toContainText("Ready for preview");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publication-action-message")).toContainText("Published.");
  const anon = createAnonClient();
  const { data: hidden, error: hiddenError } = await anon.from("books").select("id").eq("id", bookId).maybeSingle();
  if (hiddenError) throw hiddenError;
  expect(hidden, "a published EPUB does not publish its book").toBeNull();
  const { data: buckets, error: bucketError } = await service.storage.listBuckets();
  if (bucketError) throw bucketError;
  for (const [id, isPublic] of [["covers", true], ["ebook-source", false], ["ebook-derived", false]] as const) expect(buckets.find((bucket) => bucket.id === id)?.public).toBe(isPublic);
  const { error: sourceDenied } = await anon.storage.from("ebook-source").download(asset.source_storage_key);
  expect(sourceDenied).not.toBeNull();

  await page.goto(editionUrl);
  await expect(page.locator("#offer-priceMinor")).toHaveValue("1500");
  await page.goto(`/admin/books/${bookId}`);
  await expect(page.getByLabel("Canonical key")).toHaveValue(`edited-${oldSlug}`);
  await expect(page.getByLabel(names.topic, { exact: true })).toBeChecked();
  await expect(page.getByLabel("Series position")).toHaveValue("1");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const publish = page.getByRole("button", { name: "Publish book" });
    expect((await publish.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await publish.focus();
    await expect(publish).toBeFocused();
  }
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");
  const { data: visible, error: visibleError } = await anon.from("books").select("id").eq("id", bookId).single();
  if (visibleError) throw visibleError;
  expect(visible.id).toBe(bookId);

  // S1 records redirects; public slug route consumption belongs to S2.
  // Two successive renames must flatten both old names to the final destination.
  for (const slug of [newSlug, `${newSlug}-final`]) {
    await page.reload();
    await page.getByLabel("Slug (vi)").fill(slug);
    await save(page, "Save vi copy");
  }
  const { data: redirects, error: redirectError } = await service.from("redirects").select("source_path,destination_path").in("source_path", [`/vi/books/${oldSlug}`, `/vi/books/${newSlug}`, `/vi/books/${newSlug}-final`]).order("source_path");
  if (redirectError) throw redirectError;
  expect(redirects).toHaveLength(2);
  expect(redirects).toEqual(expect.arrayContaining([oldSlug, newSlug].map((slug) => ({ source_path: `/vi/books/${slug}`, destination_path: `/vi/books/${newSlug}-final` }))));
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Unpublish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book unpublished.");
  const { data: unpublished, error: unpublishedError } = await anon.from("books").select("id").eq("id", bookId).maybeSingle();
  if (unpublishedError) throw unpublishedError;
  expect(unpublished).toBeNull();
  const { data: audits, error: auditError } = await service.from("audit_logs").select("action,actor_profile_id").eq("entity_id", bookId);
  if (auditError) throw auditError;
  for (const action of ["publish_book", "unpublish_book", "set_book_relations"]) expect(audits!.filter((row) => row.action === action)).toEqual([{ action, actor_profile_id: operator.profileId }]);
  expect(audits!.filter((row) => row.action === "save_book_localization")).toHaveLength(4);
});

test("a signed-in non-admin gets HTTP 403 on every S1 page including details", async ({ page }) => {
  const reader = await createUser(false);
  const { data, error } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email: reader.email });
  if (error) throw error;
  await page.goto(`/auth/callback?${new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next: "/en/account", locale: "en" })}`);
  await expect(page).toHaveURL(/\/en\/account$/);
  const id = "4a1b2c3d-0000-4000-8000-000000000001";
  const paths = ["/admin", ...["books", "authors", "series", "topics"].flatMap((entity) => [`/admin/${entity}`, `/admin/${entity}/new`, `/admin/${entity}/${id}`]), "/admin/users", `/admin/users/${reader.profileId}`, "/admin/merchandising", `/admin/publications/${id}`];
  for (const path of paths) {
    expect((await page.goto(path))?.status(), `${path} answers 403 before loading data`).toBe(403);
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  }
});

test("an anonymous visitor is sent to sign-in from the catalog admin", async ({ page }) => {
  await page.goto("/admin/books");
  await expect(page).toHaveURL(/sign-in\?next=%2Fadmin%2Fbooks/);
});
