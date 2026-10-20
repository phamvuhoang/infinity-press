import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import { createReader, signInAs } from "./support/commerce";
import { CHAPTER_TWO_HREF, grantEntitlement, seedProcessedBook } from "./support/publication";
import { createServiceRoleClient } from "./support/supabase";

// S4 acceptance. The reader's settings panel, contents drawer, whole-book progression, completion
// card, lost-access states, and the public sample reader, against a real processed publication and
// a real database.
//
// Ground truth for where a reader IS is always the saved locator in `reading_progress`, never
// rendered text: Readium preloads the adjacent resource, so chapter 2's document reports visible
// text to Playwright from the moment the book opens. Where a DOM check is needed,
// activeChapterVisible() below asks which host iframe Readium has actually activated, which is the
// same technique e2e/ebook-golden-path.spec.ts uses and for the same reason.

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Anonymous samples have no saved-progress acknowledgment.
const TURN_SETTLE_MS = 150;

async function savedProgress(publicationId: string): Promise<{
  href: string;
  totalProgression: number | null;
  clientSequence: number;
} | null> {
  const { data } = await createServiceRoleClient()
    .from("reading_progress")
    .select("locator_json, total_progression, client_sequence")
    .eq("publication_id", publicationId)
    .maybeSingle();
  if (!data) return null;
  return {
    href: ((data.locator_json as { href?: string } | null)?.href ?? "") as string,
    totalProgression: data.total_progression as number | null,
    clientSequence: data.client_sequence,
  };
}

async function libraryState(profileId: string, bookId: string): Promise<string | null> {
  const { data } = await createServiceRoleClient()
    .from("library_items")
    .select("state")
    .eq("profile_id", profileId)
    .eq("book_id", bookId)
    .maybeSingle();
  return (data?.state as string | null) ?? null;
}

// Waits for the engine to have mounted and reported its navigation state. The page controls exist
// only in the client's "ready" phase, so this is the honest "the reader is open" signal - and,
// unlike a frame text query, it says nothing about which resource happens to be preloaded.
async function readerReady(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Next page" })).toBeEnabled({ timeout: 60_000 });
}

async function turnPage(page: Page, publicationId?: string): Promise<boolean> {
  const next = page.getByRole("button", { name: "Next page" });
  if (await next.isDisabled()) return false;
  const previousSequence = publicationId ? (await savedProgress(publicationId))?.clientSequence ?? 0 : 0;
  await next.click();
  if (publicationId) {
    // A resource transition can outlast a fixed settle beat. Wait for this turn's
    // persisted acknowledgment before deciding whether another click is allowed;
    // otherwise the completion card can disable Next while that click is landing.
    await expect.poll(async () => (await savedProgress(publicationId))?.clientSequence ?? 0)
      .toBeGreaterThan(previousSequence);
  } else {
    await page.waitForTimeout(TURN_SETTLE_MS);
  }
  return true;
}

async function pageToTheEnd(page: Page, publicationId?: string, maxTurns = 120): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (!(await turnPage(page, publicationId))) return;
  }
  throw new Error(`Still not at the last page after ${maxTurns} turns`);
}

test("a reader sets typography, navigates by contents, and finishes the book", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const title = `Finish Harbour ${suffix}`;
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `finish-harbour-${suffix}`, title } },
  });

  const reader = await createReader("reader-finish");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  await readerReady(page);

  // A saved position to compare against. Nothing writes progress on mount (ReaderClient saves only
  // from move()), so without a turn first there is no row and step 3 below would be comparing
  // nothing to nothing.
  await turnPage(page, book.publicationId);
  await expect.poll(() => savedProgress(book.publicationId), { timeout: 15_000 }).not.toBeNull();
  const beforeSettings = await savedProgress(book.publicationId);
  expect(beforeSettings?.href).toContain("chapter1.xhtml");

  // ---- typography ------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Reading settings" }).click();
  const settings = page.getByRole("dialog");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Larger text" }).click();
  await settings.getByRole("button", { name: "Larger text" }).click();
  // The width change is the interesting half: it re-lays out the columns, which is exactly the
  // change most likely to lose a reflowable position.
  await settings.getByRole("radiogroup", { name: "Text width" }).getByRole("radio", { name: "Wide" }).click();
  await expect(
    settings.getByRole("radiogroup", { name: "Text width" }).getByRole("radio", { name: "Wide" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  // ---- the exit criterion: typography and width do not lose the reader's place -----------------
  await page.reload();
  await readerReady(page);
  const afterReload = await savedProgress(book.publicationId);
  expect(afterReload?.href).toBe(beforeSettings?.href);
  // The preferences survived the reload too - they are the reader's, not the page's.
  await page.getByRole("button", { name: "Reading settings" }).click();
  await expect(
    page.getByRole("dialog").getByRole("radiogroup", { name: "Text width" }).getByRole("radio", { name: "Wide" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // ---- contents --------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Contents" }).click();
  const contents = page.getByRole("dialog");
  await expect(contents).toBeVisible();
  await contents.getByRole("button", { name: "Chapter 2" }).click();
  await expect(contents).toBeHidden();

  // The top bar names the chapter the engine actually landed in, and the saved locator agrees.
  await expect(page.locator("header").getByText("Chapter 2", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await savedProgress(book.publicationId))?.href, { timeout: 15_000 })
    .toContain("chapter2.xhtml");

  // ---- to the end, and finished ----------------------------------------------------------------
  await pageToTheEnd(page, book.publicationId);

  await expect
    .poll(async () => (await savedProgress(book.publicationId))?.totalProgression ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(0.99);
  await expect
    .poll(() => libraryState(reader.profileId, book.bookId), { timeout: 30_000 })
    .toBe("completed");

  await expect(page.getByText("You finished this book.")).toBeVisible();

  await page.goto("/en/library");
  const shelfItem = page.getByRole("listitem").filter({ hasText: title });
  await expect(shelfItem.first()).toBeVisible();
  await expect(shelfItem.filter({ hasText: "Finished" }).first()).toBeVisible();
});

// The case that would have shipped broken, and which the two-chapter fixture cannot see.
//
// Measured in Chrome: a resource that fits in a SINGLE column has `scrollWidth === clientWidth`, so
// Readium's column normalization has no range and reports `progression: 0` on the only page it has.
// A book whose final reading-order item is short - a colophon, a dedication, a one-page "The End",
// which is the ordinary shape of a real EPUB - therefore derived (N - 1) / N at its true last page
// under a purely fractional whole-book progression, and could never be marked finished. The fix
// takes the end of the book from the navigator's own boundary instead; this is what pins it.
test("a book whose last chapter fits on one page still finishes", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const title = `Colophon Harbour ${suffix}`;
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `colophon-harbour-${suffix}`, title } },
    shortFinalChapter: true,
  });

  const reader = await createReader("reader-colophon");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/en/read/${book.bookId}`);
  await readerReady(page);

  await pageToTheEnd(page, book.publicationId);

  await expect
    .poll(async () => (await savedProgress(book.publicationId))?.totalProgression ?? 0, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(0.99);
  await expect
    .poll(() => libraryState(reader.profileId, book.bookId), { timeout: 30_000 })
    .toBe("completed");
  await expect(page.getByText("You finished this book.")).toBeVisible();

  // And the reader really did end up in the short final chapter, so this is the end of the BOOK
  // rather than a boundary reported somewhere earlier.
  expect((await savedProgress(book.publicationId))?.href).toContain("chapter3.xhtml");
});

test("settings and contents are usable at 390, 768 and 1440", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `responsive-harbour-${suffix}`, title: `Responsive Harbour ${suffix}` } },
  });

  const reader = await createReader("reader-responsive");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/en/library`);

  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/en/read/${book.bookId}`);
    await readerReady(page);

    // The contents drawer: open, operate one control (the entry for the chapter already open, so
    // this exercises the control without moving the reader between viewports), and close.
    await page.getByRole("button", { name: "Contents" }).click();
    const contents = page.getByRole("dialog");
    await expect(contents, `contents at ${width}px`).toBeVisible();
    await expect(contents.getByRole("button", { name: "Chapter 1" })).toBeVisible();
    await contents.getByRole("button", { name: "Chapter 1" }).click();
    await expect(contents).toBeHidden();

    await page.getByRole("button", { name: "Reading settings" }).click();
    const settings = page.getByRole("dialog");
    await expect(settings, `settings at ${width}px`).toBeVisible();
    await settings.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Paper" }).click();
    await expect(
      settings.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Paper" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(settings, `settings closes with Escape at ${width}px`).toBeHidden();
  }
});

test("a revoked entitlement shows the lost-access state", async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const book = await seedProcessedBook({
    suffix,
    localizations: { en: { slug: `revoked-harbour-${suffix}`, title: `Revoked Harbour ${suffix}` } },
  });

  const reader = await createReader("reader-revoked");
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, "/en/library");

  // Revoked WHILE the reader is opening the book, which is the situation the lost-access states
  // exist for. The route handler controls only the timing - the request is continued untouched and
  // the 404 it gets back is the real server's answer. It has to be interleaved this way: the page
  // itself is server-gated, so revoking first and then navigating produces a 404 page rather than
  // the reader, and revoking after mount changes nothing until the next protected request.
  let revokedOnce = false;
  await page.route("**/api/reader/sessions", async (route) => {
    if (!revokedOnce) {
      revokedOnce = true;
      const { error } = await createServiceRoleClient()
        .from("entitlements")
        .update({ status: "revoked", revoked_at: new Date().toISOString() })
        .eq("profile_id", reader.profileId)
        .eq("book_id", book.bookId);
      if (error) throw new Error(error.message);
    }
    await route.continue();
  });

  await page.goto(`/en/read/${book.bookId}`);

  // 404 means revoked, superseded, or never existed - all deliberately indistinguishable - and the
  // reader is told the one thing that is actionable. One silent re-mint happens first; the second
  // refusal is what lands here.
  await expect(page.getByText("You no longer have access to this book.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Go to my library" })).toBeVisible();

  // NOT the retryable outage message. Offering "Try again" for an entitlement that is gone is the
  // regression this distinguishes: 401 and 404 are refusals, everything else is an outage.
  await expect(page.getByText("This book could not be opened.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("the sample reader serves an anonymous visitor and nothing beyond the allowlist", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const suffix = unique();
  const title = `Sample Harbour ${suffix}`;
  const slug = `sample-harbour-${suffix}`;
  const book = await seedProcessedBook({ suffix, localizations: { en: { slug, title } } });

  // No sign-in of any kind. Ruling AR: the sample path takes no user gate, and an anonymous
  // visitor is the caller it exists for.
  const entitledRequests: string[] = [];
  page.on("request", (pageRequest) => {
    if (pageRequest.url().includes("/api/reader/")) entitledRequests.push(pageRequest.url());
  });

  await page.goto(`/en/read-sample/${slug}`);
  await expect(page.getByRole("region", { name: "Reader" })).toBeVisible({ timeout: 60_000 });
  await readerReady(page);

  // The end-of-sample card is gated on the engine reporting that it cannot go forward, so it
  // appears at the end of the sample rather than on opening it - which is also what proves the
  // sample really is bounded by the allowlist: one chapter, then no further.
  await pageToTheEnd(page);
  await expect(page.getByText("That is the end of the sample.")).toBeVisible({ timeout: 30_000 });

  // A sample must never mint a reader session or touch an entitled route; those answer an
  // anonymous caller with 401, so a single request here would mean the sample is broken for
  // exactly the visitor it is for.
  expect(entitledRequests, "the sample reader issues no /api/reader/* request").toEqual([]);

  // What the allowlist actually is, and a resource that is deliberately outside it.
  const service = createServiceRoleClient();
  const { data: sample } = await service
    .from("book_samples")
    .select("allowed_hrefs")
    .eq("publication_id", book.publicationId)
    .single();
  const allowed = (sample?.allowed_hrefs ?? []) as string[];
  expect(allowed.length).toBeGreaterThan(0);

  const { data: resources } = await service
    .from("ebook_resources")
    .select("href, access_class")
    .eq("publication_id", book.publicationId);
  const paid = (resources ?? []).filter(
    (row: { href: string; access_class: string }) => row.access_class !== "sample" && !allowed.includes(row.href),
  );
  // Chapter 2 specifically, because a paid CHAPTER is the thing a sample must not hand over; the
  // rest of the paid set is probed too, so this cannot pass by testing only the cover image.
  expect(
    paid.map((row: { href: string }) => row.href),
    "the fixture has a paid chapter to probe with",
  ).toContain(CHAPTER_TWO_HREF);

  // 404, not 401 and certainly not 200. A 403 or a 401 here would be an existence oracle; a 200
  // would be the leak the allowlist exists to prevent.
  for (const row of paid as { href: string }[]) {
    const refused = await request.get(`/api/samples/${book.publicationId}/resources/${row.href}`, {
      maxRedirects: 0,
    });
    expect(refused.status(), `GET the paid resource ${row.href} through the sample route`).toBe(404);
  }

  // And the sample's own chapter really is served, so the 404 above is about the allowlist rather
  // than about the route being broken for everyone.
  const served = await request.get(`/api/samples/${book.publicationId}/resources/${allowed[0]}`, {
    maxRedirects: 0,
  });
  expect(served.status()).toBe(200);

  // The end-of-sample card carries the book's own action. Anonymous and free, so it is the
  // sign-in-first "Get free" control from the book page.
  const endCard = page.getByRole("status").filter({ hasText: "That is the end of the sample." });
  await expect(endCard.getByRole("link", { name: "Get free" })).toBeVisible();
});

test("a book with no sample has no sample page", async ({ page }) => {
  const suffix = unique();
  const slug = `no-sample-harbour-${suffix}`;
  await seedCatalogBook({ suffix, localizations: { en: { slug, title: `No Sample Harbour ${suffix}` } } });

  expect((await page.goto(`/en/read-sample/${slug}`))?.status()).toBe(404);
});
