import { execFileSync } from "node:child_process";

import { type Page, expect, test } from "@playwright/test";

import { readLatestLink } from "./support/mailpit";
import {
  CHAPTER_ONE_MARKER,
  CHAPTER_TWO_MARKER,
  buildFixtureEpub,
} from "./support/publication";
import { createAnonClient, createServiceRoleClient } from "./support/supabase";
import { soleEditionId } from "./support/editions";

// The complete one-book golden path, end to end:
//
//   admin sign-in -> create book -> upload EPUB -> process -> preview -> publish
//   -> anonymous public visibility -> reader magic-link session -> complimentary grant
//   -> library -> reader -> navigate -> save -> reload -> same locator
//
// Ruling CI: this spec no longer guards itself with test.skip. The environment it needs is
// required once at Playwright config load (e2e/support/required-env.ts) and fails the whole run
// when absent.

// A 1x1 PNG, enough for the cover upload to satisfy the publish readiness check.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

// ================================================================================================
// Fixtures
// ================================================================================================

function unique(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Readium renders into an iframe pool, not a single frame, and keeps more than one alive at a
// time - so "the chapter is on screen" cannot be asserted against a fixed frame index without
// betting on which pooled frame happens to be the visible one. Asking every frame is resilient to
// however the pool is arranged, and to it changing.
async function chapterVisible(page: Page, candidates: string[]): Promise<boolean> {
  for (const frame of page.frames()) {
    for (const text of candidates) {
      const visible = await frame
        .getByText(text)
        .first()
        .isVisible()
        // A frame can detach mid-poll as the pool recycles; that is not a failure to report.
        .catch(() => false);
      if (visible) return true;
    }
  }
  return false;
}

// Unlike querying text through every Playwright Frame, this asks which host iframe Readium has
// actually activated. Preloaded resources remain in the DOM, and their own documents still report
// text as visible, but Readium keeps their host iframes hidden until they become the current
// reading-order item.
async function activeChapterContains(page: Page, candidate: string): Promise<boolean> {
  return page.locator("iframe.readium-navigator-iframe").evaluateAll((frames, text) =>
    frames.some((frame) => {
      if (!(frame instanceof HTMLIFrameElement)) return false;
      const style = getComputedStyle(frame);
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        style.opacity !== "0" &&
        Boolean(frame.contentDocument?.body.textContent?.includes(text))
      );
    }), candidate);
}

// The shape the anonymous visibility query below actually returns - see the overrideTypes call
// there for why the inferred one is wrong.
type AnonBookRow = {
  id: string;
  status: string;
  authors: { display_name: string; status: string } | null;
  book_localizations: { title: string }[];
};

// Does the publication's OWN stylesheet actually load and apply inside the reader frame?
//
// This exists because "the chapter is on screen" is satisfied by unstyled, image-less text, and for
// the whole of this branch's life that is exactly what the reader rendered. Readium builds each
// chapter frame as a `blob:` document and injects a `<base href>`; while that href was
// root-relative it could not be resolved against a `blob:` URL (opaque path), so `document.baseURI`
// stayed the blob URL, `../styles/style.css` never resolved, and the browser never even issued the
// request. No CSP violation fired, nothing errored, and every assertion in this spec still passed.
//
// Two independent facts are checked, because either alone is weaker than it looks: the `<link>`
// element has a live `sheet` (a blocked or unresolvable stylesheet leaves `sheet` null), AND the
// heading's computed colour is the fixture's own distinctive value. The second is what proves the
// CSS was applied rather than merely fetched.
async function publicationStylesheetApplied(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const applied = await frame
      .evaluate(() => {
        const heading = document.querySelector("h1");
        if (!heading) return false;
        const link = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find((element) =>
          (element as HTMLLinkElement).href.includes("/resources/"),
        ) as HTMLLinkElement | undefined;
        return Boolean(link && link.sheet) && getComputedStyle(heading).color === "rgb(1, 2, 3)";
      })
      // A frame can detach mid-poll as the pool recycles; that is not a failure to report.
      .catch(() => false);
    if (applied) return true;
  }
  return false;
}

// Mirrors the createAdminUser() every other admin spec defines: a confirmed password user, then a
// user_roles grant once the auth trigger has created its profile row.
async function createAdminUser() {
  const email = `gp-admin-${unique()}@example.test`;
  const password = "gp-admin-password-1";
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("auth_user_id", data.user.id)
    .single();
  if (profileError) throw profileError;

  const { error: roleError } = await admin
    .from("user_roles")
    .insert({ profile_id: profile.id, role: "admin" });
  if (roleError) throw roleError;

  return { email, password, profileId: profile.id as string };
}

async function signInAsAdmin(page: Page, email: string, password: string, next: string) {
  await page.goto(`/internal/en/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in with password" }).click();
  await expect(page).toHaveURL(new RegExp(next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
}

// A second book that is never published, so the anonymous assertions below have a negative case.
// Seeded directly: admin_create_ebook checks is_admin() through auth.uid(), which is null under
// the service role (Ruling W/AE), so it cannot be called this way - and this book only needs to
// exist, not to be creatable through the UI.
async function seedUnpublishedBook() {
  const admin = createServiceRoleClient();
  const suffix = unique();

  const { data: author, error: authorError } = await admin
    .from("authors")
    .insert({ canonical_slug: `gp-hidden-author-${suffix}`, display_name: `Hidden Author ${suffix}` })
    .select("id")
    .single();
  if (authorError) throw authorError;

  const { data: book, error: bookError } = await admin
    .from("books")
    .insert({
      canonical_key: `gp-hidden-book-${suffix}`,
      original_language: "en",
      primary_author_id: author.id,
    })
    .select("id")
    .single();
  if (bookError) throw bookError;

  const { error: localizationError } = await admin
    .from("book_localizations")
    .insert({ book_id: book.id, locale: "en", slug: `gp-hidden-slug-${suffix}`, title: "The Unpublished Book" });
  if (localizationError) throw localizationError;

  return { bookId: book.id as string, title: "The Unpublished Book" };
}

// ================================================================================================
// The golden path
// ================================================================================================

test("an admin publishes a book and a reader reads it, leaves, and returns to the same place", async ({
  page,
  browser,
  browserName,
}) => {
  test.slow();

  const service = createServiceRoleClient();
  const suffix = unique();
  const bookTitle = `The Harbour Lights ${suffix}`;
  const authorName = `Wren Ellory ${suffix}`;

  const { email: adminEmail, password: adminPassword } = await createAdminUser();
  const hidden = await seedUnpublishedBook();

  // ---- admin sign-in -> create book ------------------------------------------------------------
  await signInAsAdmin(page, adminEmail, adminPassword, "/admin/books/new");

  await page.getByLabel("Canonical key").fill(`gp-book-${suffix}`);
  await page.getByLabel("Author name").fill(authorName);
  await page.getByLabel("Title").fill(bookTitle);
  await page.getByLabel("Slug").fill(`gp-slug-${suffix}`);
  // The form defaults to the platform language (English); this flow edits the Vietnamese copy.
  await page.locator("#locale-trigger").click();
  await page.locator('[role="listbox"]').getByRole("option", { name: "Vietnamese (vi)" }).click();
  await page.getByLabel("Market").fill("VN");
  await page.getByLabel("Currency").fill("VND");
  await page.getByLabel("Price (minor units)").fill("1500");
  await page.getByRole("button", { name: "Create book" }).click();

  await expect(page).toHaveURL(/\/admin\/books\/[0-9a-f-]{36}$/);
  const bookId = page.url().split("/").pop() as string;

  // A name entered on the book form creates a draft author. Complete that author's localized
  // copy through the supported UI before publication; publish_book deliberately refuses to make
  // an author public without it.
  const { data: createdBook, error: createdBookError } = await service
    .from("books")
    .select("primary_author_id")
    .eq("id", bookId)
    .single();
  if (createdBookError) throw createdBookError;
  await page.goto(`/admin/authors/${createdBook.primary_author_id}`);
  await page.getByLabel("Slug (vi)").fill(`gp-author-${suffix}`);
  await page.getByLabel("Name (vi)").fill(authorName);
  await page.getByLabel("Description (vi)").fill("Localized author copy for the golden path.");
  await page.getByRole("button", { name: "Save vi copy", exact: true }).click();
  await expect(page.locator("form").filter({ has: page.getByRole("button", { name: "Save vi copy", exact: true }) }).getByRole("status")).toHaveText("Saved.");
  await page.goto(`/admin/books/${bookId}/editions/${await soleEditionId(bookId)}`);

  // ---- upload the EPUB -------------------------------------------------------------------------
  await page.locator("#epub-file").setInputFiles({
    name: "harbour-lights.epub",
    mimeType: "application/epub+zip",
    // Chapter 2 must also span more than one page for this restore proof: it saves the first
    // chapter-two page and then verifies that a further page remains after reload.
    buffer: buildFixtureEpub({ chapterTwoParagraphs: 48 }),
  });
  await page.getByRole("button", { name: "Upload EPUB" }).click();
  // Scoped to the EPUB section for the same reason as admin-epub-upload.spec.ts: this editor now
  // carries a second role="status" live region, in the editorial-pins picker.
  await expect(page.locator("#epub").getByRole("status")).toContainText("Queued for processing. Job", {
    timeout: 30_000,
  });

  const { data: asset, error: assetError } = await service
    .from("ebook_assets")
    .select("id, status")
    .eq("edition_id", (
      await service.from("editions").select("id").eq("book_id", bookId).single()
    ).data?.id as string)
    .single();
  if (assetError) throw assetError;
  expect(asset.status).toBe("queued");

  // ---- process it with the real CLI ------------------------------------------------------------
  // The actual command an operator runs (docs/runbooks/epub-processing.md), not an in-process
  // re-implementation of it: this is the only automated coverage that the CLI entry point itself
  // still works against a real stack and real storage.
  execFileSync("npm", ["run", "ebook", "--", "process", "--asset", asset.id], {
    encoding: "utf8",
    env: process.env,
    stdio: "pipe",
  });

  // ---- preview -> publish ----------------------------------------------------------------------
  await page.goto(`/admin/publications/${asset.id}`);
  await expect(page.getByTestId("publication-lifecycle")).toContainText("Ready for preview");

  // Select the chapter explicitly rather than relying on whichever resource the preview happens
  // to select by default. This fixture has five resources and the default is the first one, which
  // ordered by href is `OEBPS/images/cover.jpg` - an image, with no text to assert on. (The
  // existing transitions spec never hit this because it seeds a single resource.) Clicking also
  // exercises the resource switcher, which nothing else covers.
  await page.getByRole("button", { name: "OEBPS/text/chapter1.xhtml", exact: true }).click();

  // The preview streams the private derived resource through the admin-gated route, so this also
  // proves the processed bytes are real and retrievable rather than merely recorded.
  const previewFrame = page.frameLocator("iframe[title='Preview of OEBPS/text/chapter1.xhtml']");
  await expect(previewFrame.getByText(CHAPTER_ONE_MARKER)).toBeVisible({ timeout: 15_000 });

  // An edition nobody has approved cannot go live: the editor is told why.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publication-action-message")).toContainText("not been editorially approved");

  // Record the provenance and approve it, through the supported UI.
  await page.goto(`/admin/books/${bookId}/editions/${await soleEditionId(bookId)}`);
  await page.getByLabel("Source of the translation").fill("Public-domain translation, 1925 (e2e fixture)");
  await page.getByLabel("Rights note").fill("Fixture text written for the test suite.");
  await page.getByLabel("Territories").fill("Worldwide");
  await page.getByRole("button", { name: "Save provenance" }).click();
  await expect(page.getByText("Saved.").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("editorial-state")).toContainText("Approved");

  await page.goto(`/admin/publications/${asset.id}`);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByTestId("publication-action-message")).toContainText("Published.");
  await expect(page.getByTestId("publication-lifecycle")).toContainText("currently active");

  const { data: publication, error: publicationError } = await service
    .from("ebook_publications")
    .select("id")
    .eq("ebook_asset_id", asset.id)
    .single();
  if (publicationError) throw publicationError;
  const publicationId = publication.id as string;

  // ---- complete the catalog record -> publish the book -----------------------------------------
  // Since migration 20260913120000, publishing an EPUB version moves the active pointer only. The
  // book becomes public through "Publish book", which requires complete book and author copy,
  // a cover, an active offer, and the published EPUB version above.
  const anonBeforePublish = createAnonClient();
  const { data: stillHidden, error: hiddenError } = await anonBeforePublish.from("books").select("id").eq("id", bookId).maybeSingle();
  if (hiddenError) throw hiddenError;
  expect(stillHidden, "publishing a version alone does not make the book public").toBeNull();

  await page.goto(`/admin/books/${bookId}`);
  await page.getByLabel("Description (vi)", { exact: true }).fill("A lighthouse keeper's story, generated for the golden path.");
  await page.getByRole("button", { name: "Save vi copy" }).click();
  await expect(page.locator("#localizations").getByTestId("form-saved")).toBeVisible();

  // The reader route intentionally uses the current catalog locale for its presentation DTO.
  // This English reader journey therefore needs an English book card, rather than relying on the
  // library's deliberately more forgiving cross-locale display fallback.
  await page.getByLabel("Title (en)", { exact: true }).fill(bookTitle);
  await page.getByLabel("Slug (en)", { exact: true }).fill(`gp-slug-en-${suffix}`);
  await page.getByLabel("Description (en)", { exact: true }).fill("An English lighthouse keeper's story for the golden path.");
  await page.getByRole("button", { name: "Save en copy" }).click();
  await expect(page.locator("#localizations").getByTestId("form-saved")).toBeVisible();

  await page.getByLabel("Cover image").setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: ONE_PIXEL_PNG });
  await page.getByLabel("Cover alt text").fill(`Cover of ${bookTitle}`);
  await page.getByRole("button", { name: "Upload cover" }).click();
  await expect(page.getByTestId("cover-status")).toHaveText("Cover saved.");

  // Firefox can abort an explicit reload while the preceding server-action/RSC navigation is
  // still settling. Wait for that navigation to go idle so the refresh verifies persisted state
  // instead of racing the response stream it is meant to replace.
  await page.waitForLoadState("networkidle");
  await page.reload({ waitUntil: "domcontentloaded" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish book" }).click();
  await expect(page.getByTestId("book-publish-message")).toHaveText("Book published.");

  // ---- Ruling CB: anonymous public visibility --------------------------------------------------
  //
  // Adapted, because this MVP has NO public catalog page: `app/[lang]/(public)` contains only a
  // marketing landing page, there is no book listing or detail route, and no slug lookup exists in
  // lib/data. The one book-shaped file, (public)/books/[slug]/actions.ts, is an orphan whose own
  // comment says "No page consumes this action yet". So the assertion is made where the three
  // defects the ruling names actually live - the anonymous RLS boundary - rather than against a
  // page that does not exist.
  //
  // Book visibility now comes from `publish_book` (migration 20260913120000); this read proves
  // that the explicit publish made the book and its author visible to anonymous visitors.
  const anon = createAnonClient();

  const { data: publiclyVisible, error: publicError } = await anon
    .from("books")
    .select("id, status, authors ( display_name, status ), book_localizations ( title )")
    .eq("id", bookId)
    .maybeSingle()
    // Same idiom, and same reason, as lib/data/books.ts's getAdminBook: postgrest-js infers embed
    // cardinality from the generated Database type, which this untyped client does not carry, so
    // it defaults every embed to an array. books.primary_author_id -> authors.id is many-to-one
    // and PostgREST really nests it as a single object, so the inferred shape is wrong for
    // `authors` specifically. Correcting it here beats casting at each use.
    .overrideTypes<AnonBookRow, { merge: false }>();
  if (publicError) throw publicError;

  expect(publiclyVisible, "an anonymous visitor can see the published book").not.toBeNull();
  expect(publiclyVisible?.status).toBe("published");
  expect(publiclyVisible?.book_localizations[0]?.title).toBe(bookTitle);
  // The byline. A null author here is the Ruling BO defect: books.primary_author_id is set, but
  // authors.status was never flipped to 'published', so "public read published authors" hides the
  // row and the book becomes unattributable everywhere it is listed.
  const byline = publiclyVisible?.authors ?? null;
  expect(byline, "the author byline is publicly readable").not.toBeNull();
  expect(byline?.display_name).toBe(authorName);
  expect(byline?.status).toBe("published");

  // The negative case: a book that was never published stays invisible.
  const { data: hiddenRow } = await anon.from("books").select("id").eq("id", hidden.bookId).maybeSingle();
  expect(hiddenRow, "a book that was never published is invisible to the public").toBeNull();

  // ---- unauthorized resource probes ------------------------------------------------------------
  const anonymous = await browser.newContext();
  const paidResource = `/api/reader/publications/${publicationId}/resources/OEBPS/text/chapter1.xhtml`;

  // 401, decided before any lookup, so it is a statement about the caller and never about whether
  // the publication exists.
  expect((await anonymous.request.get(paidResource, { maxRedirects: 0 })).status()).toBe(401);

  // The sample routes take no user gate at all (Ruling AR), so an anonymous caller reaches the
  // allowlist check itself. Nothing was declared as a sample for this publication, so the
  // allowlist is empty and every href is refused with 404 - never 403, which would be an
  // existence oracle.
  expect(
    (await anonymous.request.get(`/api/samples/${publicationId}/manifest`, { maxRedirects: 0 })).status(),
  ).toBe(404);
  expect(
    (
      await anonymous.request.get(
        `/api/samples/${publicationId}/resources/OEBPS/text/chapter1.xhtml`,
        { maxRedirects: 0 },
      )
    ).status(),
  ).toBe(404);
  await anonymous.close();

  // ---- reader magic-link session ---------------------------------------------------------------
  const readerEmail = `gp-reader-${unique()}@example.test`;
  const readerContext = await browser.newContext();
  // Pin this stylesheet/restore proof to publisher colours and its original pagination.
  // New readers now start with the paper theme and medium line spacing.
  await readerContext.addInitScript(() => {
    if (!localStorage.getItem("infinity-books.reader.preferences")) {
      localStorage.setItem("infinity-books.reader.preferences", JSON.stringify({
        fontFamily: "publisher", fontScale: 1, lineHeight: 1.5, width: "medium", theme: "light",
      }));
    }
  });
  const reader = await readerContext.newPage();
  // This recovery proof is intentionally narrow: it derives a distinct, non-terminal saved
  // chapter after individual page turns. Desktop-spread geometry is covered by the reader-
  // completion width matrix; a wide viewport can make this short chapter terminal immediately.
  await reader.setViewportSize({ width: 390, height: 900 });

  // The reader runs in its own context, so a failure here is invisible in the default error
  // context (which captures the admin page). Collect enough to tell "the engine never mounted"
  // apart from "it mounted and rendered nothing".
  const readerConsole: string[] = [];
  const readerApi: string[] = [];
  reader.on("console", (message) => readerConsole.push(`${message.type()}: ${message.text()}`));
  reader.on("pageerror", (error) => readerConsole.push(`pageerror: ${error.message}`));
  reader.on("response", (response) => {
    if (response.url().includes("/api/")) readerApi.push(`${response.status()} ${response.url()}`);
  });

  async function dumpReaderDiagnostics(label: string) {
    const body = await reader.locator("body").innerText().catch(() => "<unavailable>");
    const frames = reader.frames().length;
    console.log(
      `\n===== ${label} =====\nframes: ${frames}\n--- visible text ---\n${body}\n` +
        `--- api ---\n${readerApi.join("\n")}\n--- console ---\n${readerConsole.join("\n")}\n=====\n`,
    );
  }

  await reader.goto("/en/sign-in");
  await reader.getByLabel("Email").fill(readerEmail);
  await reader.getByRole("button", { name: "Send secure sign-in link" }).click();
  await reader.goto(await readLatestLink(readerEmail));

  const { data: readerProfile, error: readerProfileError } = await service
    .from("profiles")
    .select("id, auth_user_id")
    .eq("auth_user_id", (
      await service.auth.admin.listUsers()
    ).data.users.find((user) => user.email === readerEmail)?.id as string)
    .single();
  if (readerProfileError) throw readerProfileError;

  // ---- complimentary grant ---------------------------------------------------------------------
  // Through the real RPC as the signed-in admin, not a hand-seeded row: grant_complimentary_
  // entitlement writes the entitlement, the library_items row the library page reads, and an
  // immutable audit row in one transaction, and its is_admin() check resolves through auth.uid()
  // - which is null under service_role - so it can only be called as an authenticated admin.
  const adminClient = createAnonClient();
  const { error: adminSignInError } = await adminClient.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (adminSignInError) throw adminSignInError;

  const { error: grantError } = await adminClient.rpc("grant_complimentary_entitlement", {
    p_profile_id: readerProfile.id,
    p_edition_id: await soleEditionId(bookId),
    p_reason: "Golden path end-to-end verification",
  });
  if (grantError) throw grantError;

  // ---- library -> reader -----------------------------------------------------------------------
  await reader.goto("/en/library");
  // Scoped to this book's own shelf entry, and matched on text rather than a heading role: shelf
  // titles are plain paragraphs, and the same title also appears in the "most recently read"
  // feature above the shelf. Scoping keeps "Continue reading" unambiguous for either reason.
  const libraryItem = reader.getByRole("listitem").filter({ hasText: bookTitle });
  await expect(libraryItem).toBeVisible();
  await libraryItem.getByRole("link", { name: "Continue reading" }).click();
  await expect(reader).toHaveURL(/\/en\/read\/editions\/[0-9a-f-]{36}$/);

  // The engine mounts only after POST /api/reader/sessions succeeds, so reaching a rendered
  // chapter proves session minting, the entitled manifest, and entitled resource delivery all
  // work together.
  try {
    await expect
      .poll(() => chapterVisible(reader, [CHAPTER_ONE_MARKER]), { timeout: 30_000 })
      .toBe(true);
  } catch (error) {
    await dumpReaderDiagnostics("reader failed to render chapter 1");
    throw error;
  }

  // Readium creates its reflowable chapter frames at runtime. The host application must size
  // those absolutely-positioned iframes; otherwise browsers use the replaced-element default of
  // 300 x 150 pixels and Readium paginates only a few lines at a time inside an otherwise empty
  // reader surface. Compare the active frame to its host rather than asserting a hard-coded
  // viewport size, so the contract remains true on every supported screen size.
  const readActiveFrameBounds = () => reader.locator("iframe.readium-navigator-iframe").evaluateAll((frames) => {
    const active = frames.find((frame) => {
      const style = getComputedStyle(frame);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    });
    if (!active?.parentElement) {
      return null;
    }

    const frame = active.getBoundingClientRect();
    const host = active.parentElement.getBoundingClientRect();
    return { frameWidth: frame.width, frameHeight: frame.height, hostWidth: host.width, hostHeight: host.height };
  });
  await expect.poll(readActiveFrameBounds, { timeout: 30_000 }).not.toBeNull();
  const activeFrameBounds = await readActiveFrameBounds();
  expect(activeFrameBounds).not.toBeNull();
  expect(activeFrameBounds?.frameWidth).toBeCloseTo(activeFrameBounds?.hostWidth ?? 0, 0);
  expect(activeFrameBounds?.frameHeight).toBeCloseTo(activeFrameBounds?.hostHeight ?? 0, 0);

  // The publication's own CSS must reach the frame and apply. See publicationStylesheetApplied:
  // this is the assertion that unstyled text used to pass.
  if (browserName !== "webkit") {
    try {
      await expect
        .poll(() => publicationStylesheetApplied(reader), { timeout: 20_000 })
        .toBe(true);
    } catch (error) {
      await dumpReaderDiagnostics("publication stylesheet did not load in the reader frame");
      throw error;
    }
  }

  // At the opening page "previous" must already be disabled - the control state ADR-005's gap (a)
  // made unrepresentable until Task 10 widened the boundary.
  await expect(reader.getByRole("button", { name: "Previous page" })).toBeDisabled();

  // ---- navigate -> save ------------------------------------------------------------------------
  //
  // Read forward until chapter 2 is on screen, rather than turning a single page. A page turn in a
  // reflowable publication moves one COLUMN, not one resource, so after one click the reader is
  // usually still inside chapter 1 - and a restore assertion whose target is "chapter 1" cannot
  // tell a restored position apart from a reader reset to the opening page. Landing in chapter 2
  // makes the two states name different resources, which is what gives the assertions below
  // something falsifiable to check.
  // Ground truth is the SAVED LOCATOR, never a rendered frame.
  //
  // Fix round 1, second finding - one my first attempt at this fix walked straight into. Readium
  // preloads the adjacent resource, so chapter 2's document reports visible text to Playwright from
  // the moment the book opens, before any page is turned. `chapterVisible(CHAPTER_TWO_MARKER)` is
  // therefore true at the opening page. `activeChapterContains` additionally checks the host
  // iframe state Readium controls and is safe as a STOP condition, while the saved locator below
  // remains the ground truth for where the engine says it is.
  async function savedHref(): Promise<string> {
    const { data } = await service
      .from("reading_progress")
      .select("locator_json")
      .eq("publication_id", publicationId)
      .maybeSingle();
    return ((data?.locator_json as { href?: string } | null)?.href ?? "") as string;
  }

  async function turnPages(times: number): Promise<void> {
    for (let turn = 0; turn < times; turn += 1) {
      const nextPage = reader.getByRole("button", { name: "Next page" });
      if (await nextPage.isDisabled()) return;
      await nextPage.click();
      // The engine refuses overlapping moves (`_isNavigating`), so a settle beat between clicks is
      // what makes each turn take effect rather than being dropped.
      await reader.waitForTimeout(150);
    }
  }

  async function savedHrefReaches(match: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await savedHref()).includes(match)) return true;
      await reader.waitForTimeout(300);
    }
    return false;
  }

  // Self-check for the precondition catch 2 depends on: chapter 1 must span more than one page in
  // the REAL viewport, so that one turn from its start does not already reach chapter 2. Asserting
  // it here, against the rendered publication, is worth more than asserting a paragraph count -
  // the count is only a proxy for how the text actually paginates at this window size.
  //
  // If someone shrinks the fixture, this fails immediately and says why, instead of leaving catch
  // 2 silently unable to distinguish a restored reader from one reset to the beginning.
  await turnPages(1);
  await expect
    .poll(savedHref, { timeout: 12_000 })
    .toContain("chapter1.xhtml");

  // Stop on the first page of chapter 2. The old ten-page batches were only safe while the broken
  // 300 x 150 iframe produced many tiny pages; at the real viewport size one batch could run all
  // the way to the end of chapter 2, making a correctly restored reader unable to go forward.
  let chapterTwoIsActive = await activeChapterContains(reader, CHAPTER_TWO_MARKER);
  for (let turn = 0; turn < 50 && !chapterTwoIsActive; turn += 1) {
    await turnPages(1);
    chapterTwoIsActive = await activeChapterContains(reader, CHAPTER_TWO_MARKER);
  }

  if (!chapterTwoIsActive || !(await savedHrefReaches("chapter2.xhtml", 12_000))) {
    await dumpReaderDiagnostics(`paging never saved a chapter 2 position (last saved: ${await savedHref()})`);
    throw new Error("Paging forward never reached chapter 2");
  }

  // The reload proof below turns one more page after restoring. Keep that assertion meaningful:
  // this saved chapter-two position must have a real forward page at the measured narrow layout.
  await expect(reader.getByRole("button", { name: "Next page" })).toBeEnabled();

  const { data: savedProgress, error: savedError } = await service
    .from("reading_progress")
    .select("locator_json, progression, device_id, client_sequence")
    .eq("publication_id", publicationId)
    .single();
  if (savedError) throw savedError;

  const savedLocator = savedProgress.locator_json as { href: string; progression: number };
  expect(savedLocator.href).toContain("chapter2.xhtml");

  // ---- reload -> restored to the saved locator -------------------------------------------------
  //
  // Fix round 1, Critical. The previous version of this section could not fail, in two independent
  // ways, and closing either alone would have left the other:
  //
  //  1. the post-reload poll accepted chapter 1 OR chapter 2 - and chapter 1 is precisely the
  //     reset-to-the-beginning failure the assertion exists to catch;
  //  2. it compared the progress row to itself. Nothing writes progress on mount (ReaderClient
  //     saves only from move()), so that row is byte-identical whatever the reader restored to.
  //
  // Verified against the reviewer's mutation M1 - reverting the reader page to
  // `initialLocator={null}`, the exact pre-Task-10 state where progress saves but never restores.
  // Both assertions below fail under it; the two they replaced both passed.
  await reader.reload();

  // Ready, not rendered. The page controls exist only in the client's "ready" phase, so this waits
  // for the engine to have mounted and reported its navigation state without asserting anything
  // about frames - which, per the note above, cannot tell us which resource is current.
  await expect(reader.getByRole("button", { name: "Next page" })).toBeEnabled({ timeout: 30_000 });

  // Catch 1 - the exact inverse of the opening-page assertion further up. A reader restored past
  // the first page can go back, so "Previous page" must now be ENABLED. It resolves through the
  // client's `navigation.canGoBackward` to Readium's own `navigator.canGoBackward`, so it reads
  // the engine's boundary state rather than anything the DOM merely looks like.
  //
  // DO NOT REMOVE THIS AS REDUNDANT. It is independently sufficient and, unlike catch 2, it does
  // not depend on the fixture at all: it asks only "did we reset to the first page", which is
  // true of a broken restore whatever size the chapters are. Catch 2 carries a fixture
  // precondition (see there). Deleting this one is what would make that precondition live.
  await expect(reader.getByRole("button", { name: "Previous page" })).toBeEnabled();

  // Opening the book must not overwrite the saved position. Read BEFORE any post-reload
  // navigation, so it is the mount that is under test. A real invariant - a mount-time save would
  // destroy a reader's place on every open - but NOT by itself evidence of restore, because
  // nothing writes progress on mount either way. That is what the next assertion is for.
  const { data: afterMount, error: afterMountError } = await service
    .from("reading_progress")
    .select("locator_json")
    .eq("publication_id", publicationId)
    .single();
  if (afterMountError) throw afterMountError;
  expect(afterMount.locator_json).toEqual(savedProgress.locator_json);

  // Catch 2 - turn a single page and ask the engine which resource it is now in. The saved
  // locator IS the engine's own currentLocator, persisted to reading_progress.locator_json, so
  // this reads the resumed position rather than inferring it from the DOM. Restored, one turn
  // from inside chapter 2 stays in chapter 2; under M1 the reader resumes at the start of
  // chapter 1 and the saved href changes to chapter 1.
  //
  // Neither catch outranks the other - they fail on different evidence, which is the point of
  // having both. What differs is their preconditions:
  //
  // THIS ONE DEPENDS ON THE FIXTURE. It is only able to tell a restored reader from a reset one
  // while chapter 1 spans MORE THAN ONE PAGE - it is 24 paragraphs (`chapter("Chapter 1", ...,
  // 24)` in buildFixtureEpub) against chapter 2's 12. Shrink chapter 1 until a single turn from its
  // start reaches chapter 2 and this assertion passes under a completely broken restore. The
  // self-check in the setup phase above enforces that precondition rather than trusting this
  // comment to be read.
  const postReloadSave = reader.waitForResponse(
    (response) => response.url().includes("/api/reader/progress") && response.request().method() === "POST",
    { timeout: 20_000 },
  );
  await reader.getByRole("button", { name: "Next page" }).click();
  expect((await postReloadSave).status()).toBe(200);

  await expect.poll(savedHref, { timeout: 10_000 }).toContain("chapter2.xhtml");

  await readerContext.close();
});
