import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Locator } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import {
  READER_DEPTH_EARLY_CONTEXT,
  READER_DEPTH_IDENTICAL,
  READER_DEPTH_LATE_CONTEXT,
  READER_DEPTH_LONG_CHUNK_TERM,
  READER_DEPTH_LONG_QUOTE,
  READER_DEPTH_SELECTION,
  READER_DEPTH_VIETNAMESE,
  grantEntitlement,
  seedProcessedBook,
} from "./support/publication";
import {
  activeReadingFrame,
  assertNoTransientMarker,
  decorationIsVisiblyIntersecting,
  frameThemeStyles,
  publicationKeyboardSelectionSurface,
  passageIsVisiblyIntersecting,
  selectKnownPassage,
  waitForReaderReady,
} from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type SeededBook = Awaited<ReturnType<typeof seedProcessedBook>>;

async function openReader(page: Page, book: SeededBook, label: string, locale: "en" | "vi" = "en") {
  const reader = await createReader(label);
  await grantEntitlement(book.bookId, reader.email);
  await signInAs(page, reader.email, `/${locale}/read/${book.bookId}`);
  await waitForReaderReady(page);
  return reader;
}

async function openSavedDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Reader menu|Trình đơn đọc/ }).click();
  await page.getByRole("menuitem", { name: /Contents|Mục lục/ }).click();
  await expect(page.getByRole("dialog", { name: /Contents|Mục lục/ })).toBeVisible();
}

async function openSearch(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Reader menu|Trình đơn đọc/ }).click();
  await page.getByRole("menuitem", { name: /Search this book|Tìm trong sách/ }).click();
  await expect(page.getByRole("dialog", { name: /Search this book|Tìm trong sách/ })).toBeVisible();
}

async function hoverContrast(control: Locator): Promise<number> {
  await control.hover();
  await control.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))); });
  return control.evaluate((element) => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d")!;
    const rgb = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data); };
    let background = [255, 255, 255, 255];
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) ancestors.unshift(current);
    for (const ancestor of ancestors) {
      const color = rgb(getComputedStyle(ancestor).backgroundColor);
      const alpha = color[3] / 255;
      background = background.map((value, index) => index < 3 ? color[index] * alpha + value * (1 - alpha) : 255);
    }
    const luminance = (color: number[]) => color.slice(0, 3).map((value) => value / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(rgb(getComputedStyle(element).color));
    const behind = luminance(background);
    return (Math.max(foreground, behind) + 0.05) / (Math.min(foreground, behind) + 0.05);
  });
}

test.describe.serial("reader depth acceptance", () => {
  let book: SeededBook;

  test.beforeAll(async () => {
    const suffix = unique();
    book = await seedProcessedBook({
      suffix,
      readerDepthFixture: true,
      localizations: {
        en: { slug: `reader-depth-en-${suffix}`, title: "Reader Depth Fixture" },
        vi: { slug: `reader-depth-vi-${suffix}`, title: "Bản đọc thử chiều sâu" },
      },
    });
  });

  test("keeps page controls in the viewport while a long desktop contents panel scrolls", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openReader(page, book, "reader-long-contents");

    const panel = page.getByTestId("reader-shell").locator("aside [role=tabpanel]");
    // Make the real sidebar overflow without needing a separate publication fixture.
    await panel.evaluate((element) => {
      const list = element.querySelector("ul")!;
      const entry = list.firstElementChild!;
      for (let index = 0; index < 100; index += 1) list.append(entry.cloneNode(true));
    });

    for (const name of ["Previous page", "Next page"]) {
      await expect(page.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    }
    expect(await panel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await panel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(panel.locator("li").last()).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("tab", { name: "Contents", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Next page" })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  test("keeps dark header, compact menu, search and settings readable on hover", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 960 });
    await openReader(page, book, "reader-depth-hover");
    await page.getByRole("button", { name: "Reading settings" }).click();
    await page.getByRole("radio", { name: "Dark" }).click();
    for (const control of [page.getByRole("radio", { name: "Lora", exact: true }), page.getByRole("button", { name: "Larger text" }), page.getByRole("radio", { name: "Dark", exact: true })]) {
      expect(await hoverContrast(control)).toBeGreaterThanOrEqual(4.5);
    }
    await page.keyboard.press("Escape");
    for (const name of ["Reader menu", "Search this book", "One page", "Reading settings"]) expect(await hoverContrast(page.getByRole("button", { name, exact: true }))).toBeGreaterThanOrEqual(4.5);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Reader menu" }).click();
    expect(await hoverContrast(page.getByRole("menuitem", { name: "Search this book" }))).toBeGreaterThanOrEqual(4.5);
    await page.getByRole("menuitem", { name: "Search this book" }).click();
    await page.getByRole("searchbox").fill("compass");
    const result = page.getByRole("button", { name: /brass compass/ }).first();
    await expect(result).toBeVisible();
    expect(await hoverContrast(result)).toBeGreaterThanOrEqual(4.5);
  });

  test("creates, reloads, recolors and deletes highlights and notes", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, book, "reader-depth-annotations");

    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    await page.getByRole("button", { name: "Yellow", exact: true }).click();
    const service = createServiceRoleClient();
    const highlightId = await expect.poll(async () => {
      const { data } = await service.from("reader_annotations").select("id").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.id ?? null;
    }, { timeout: 30_000 }).not.toBeNull().then(async () => {
      const { data } = await service.from("reader_annotations").select("id").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data!.id;
    });
    await expect.poll(() => decorationIsVisiblyIntersecting(page, highlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(0\)/ }).click();
    let item = page.getByRole("listitem").filter({ hasText: READER_DEPTH_SELECTION });
    await expect(item.getByRole("button", { name: READER_DEPTH_SELECTION })).toBeVisible();
    await item.getByRole("button", { name: "Green", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("color").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.color;
    }, { timeout: 30_000 }).toBe("green");

    await item.getByRole("button", { name: "Edit note" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("First private note");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("note_text").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.note_text;
    }, { timeout: 30_000 }).toBe("First private note");
    await page.getByRole("tab", { name: /Notes \(1\)/ }).click();
    item = page.getByRole("listitem").filter({ hasText: READER_DEPTH_SELECTION });
    await item.getByRole("button", { name: "Edit note" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("Edited private note");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("note_text").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.note_text;
    }, { timeout: 30_000 }).toBe("Edited private note");

    await page.reload();
    await waitForReaderReady(page);
    await expect.poll(() => decorationIsVisiblyIntersecting(page, highlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
    await page.setViewportSize({ width: 1440, height: 960 });
    await expect.poll(() => decorationIsVisiblyIntersecting(page, highlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
    await page.getByRole("button", { name: "Reading settings" }).click();
    await page.getByRole("button", { name: "Larger text" }).click();
    await page.getByRole("radio", { name: "Paper" }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => decorationIsVisiblyIntersecting(page, highlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => decorationIsVisiblyIntersecting(page, highlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Notes \(1\)/ }).click();
    item = page.getByRole("listitem").filter({ hasText: READER_DEPTH_SELECTION });
    await item.getByRole("button", { name: "Edit note" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("note_text").eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.note_text;
    }, { timeout: 30_000 }).toBeNull();
    await page.getByRole("tab", { name: /Bookmarks \(0\)/ }).click();
    item = page.getByRole("listitem").filter({ hasText: READER_DEPTH_SELECTION });
    await item.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(item).toHaveCount(0);
    await expect.poll(async () => {
      const { count } = await service.from("reader_annotations").select("id", { count: "exact", head: true }).eq("id", highlightId);
      return count;
    }, { timeout: 30_000 }).toBe(0);
  });

  test("saves a cross-paragraph selection and retains overlong selections for quote actions", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const reader = await openReader(page, book, "reader-depth-multiblock");
    const frame = await activeReadingFrame(page);
    await frame.evaluate(() => {
      const start = document.querySelector("#depth-selection")!.firstChild!;
      const end = document.querySelector("#depth-long-quote")!.firstChild!;
      const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, end.textContent!.length);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      start.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
      start.parentElement!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
    });
    await page.getByRole("toolbar").getByRole("button", { name: "Yellow", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("selected_text, locator_json").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
      return data?.selected_text;
    }).toBe(`${READER_DEPTH_SELECTION} ${READER_DEPTH_LONG_QUOTE}`);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await frame.evaluate(() => {
      const paragraph = document.querySelector("#depth-identical")!;
      const range = document.createRange(); range.selectNodeContents(paragraph);
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      paragraph.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
      paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
    });
    await page.getByRole("toolbar").getByRole("button", { name: "Yellow", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Select at most 1,000 characters" })).toBeVisible();
    await page.getByRole("toolbar").getByRole("button", { name: "Add note" }).click();
    await expect(page.getByRole("dialog", { name: "Note" })).toHaveCount(0);
    await expect(page.getByRole("toolbar").getByRole("button", { name: "Copy", exact: true })).toBeEnabled();
    await expect(page.getByRole("toolbar").getByRole("button", { name: "Share", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("follows a touch selection widened by its handles, which fires no pointer events", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const reader = await openReader(page, book, "reader-depth-handle-drag");
    const frame = await activeReadingFrame(page);
    // A long press selects one word and lifts the finger.
    await frame.evaluate(() => {
      const text = document.querySelector("#depth-selection")!.firstChild!;
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.textContent!.indexOf(" "));
      getSelection()!.removeAllRanges(); getSelection()!.addRange(range);
      text.parentElement!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType: "touch" }));
      text.parentElement!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerType: "touch" }));
    });
    await expect(page.getByRole("toolbar")).toBeVisible();
    // Dragging the native handles changes only the selection.
    await frame.evaluate(() => {
      const text = document.querySelector("#depth-selection")!.firstChild!;
      getSelection()!.getRangeAt(0).setEnd(text, text.textContent!.length);
    });
    // Tapped at once, inside the settle delay: the action must still read the widened selection.
    await page.getByRole("toolbar").getByRole("button", { name: "Yellow", exact: true }).click({ delay: 0 });
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("selected_text").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
      return data?.selected_text;
    }).toBe(READER_DEPTH_SELECTION);
  });

  test("keeps a selected paragraph selector when the visible page starts at the heading", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const reader = await openReader(page, book, "reader-depth-selector");
    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    await page.getByRole("button", { name: "Yellow", exact: true }).click();
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(0\)/ }).click();
    await page.getByRole("button", { name: READER_DEPTH_SELECTION, exact: true }).click();
    await expect.poll(() => passageIsVisiblyIntersecting(page, "Chapter 1")).toBe(true);
    const service = createServiceRoleClient();
    await expect.poll(async () => {
      const { data } = await service.from("reading_progress").select("locator_json").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
      return (data?.locator_json as { locations?: { cssSelector?: string } })?.locations?.cssSelector;
    }, { timeout: 30_000 }).toBe("#depth-selection");
    await page.reload(); await waitForReaderReady(page);
    await expect.poll(() => passageIsVisiblyIntersecting(page, READER_DEPTH_SELECTION)).toBe(true);
  });

  test("clears retained private search and annotation controls after sign-out", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, book, "reader-depth-signout");
    await openSearch(page);
    await page.getByRole("searchbox").fill("compass");
    await expect(page.getByRole("button", { name: /brass compass/ }).first()).toBeVisible();
    await page.context().clearCookies();
    await page.getByRole("searchbox").fill("lantern");
    await expect(page.getByText("You have been signed out. Sign in again to keep reading.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reader menu" })).toHaveCount(0);
    await expect(page.locator("iframe.readium-navigator-iframe")).toHaveCount(0);
  });

  test("renames a bookmark and reopens the exact later identical occurrence without leaking a marker", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const reader = await openReader(page, book, "reader-depth-anchor");

    await selectKnownPassage(page, READER_DEPTH_IDENTICAL, 1);
    await page.getByRole("button", { name: "Yellow", exact: true }).click();
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(0\)/ }).click();
    await page.getByRole("button", { name: READER_DEPTH_IDENTICAL }).click();
    await expect.poll(() => passageIsVisiblyIntersecting(page, READER_DEPTH_LATE_CONTEXT), { timeout: 30_000 }).toBe(true);

    await page.getByRole("button", { name: "Reader menu" }).click();
    await page.getByRole("menuitem", { name: "Add bookmark" }).click();
    await page.getByRole("textbox", { name: "Bookmark label" }).fill("Northern pier marker");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("label").eq("publication_id", book.publicationId).eq("kind", "bookmark").single();
      return data?.label;
    }, { timeout: 30_000 }).toBe("Northern pier marker");

    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(1\)/ }).click();
    const bookmark = page.getByRole("listitem").filter({ hasText: "Northern pier marker" });
    await bookmark.getByRole("button", { name: "Edit bookmark" }).click();
    await page.getByRole("textbox", { name: "Bookmark label" }).fill("Renamed exact marker");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reader_annotations").select("label").eq("publication_id", book.publicationId).eq("kind", "bookmark").single();
      return data?.label;
    }, { timeout: 30_000 }).toBe("Renamed exact marker");

    await page.reload();
    await waitForReaderReady(page);
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(1\)/ }).click();
    const service = createServiceRoleClient();
    const { data: beforeActivation } = await service.from("reading_progress").select("client_sequence, locator_json, updated_at").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
    const { data: savedBookmark } = await service.from("reader_annotations").select("locator_json").eq("publication_id", book.publicationId).eq("kind", "bookmark").eq("label", "Renamed exact marker").single();
    expect(beforeActivation).not.toBeNull();
    expect(savedBookmark).not.toBeNull();
    await page.getByRole("button", { name: "Renamed exact marker" }).click();
    await expect(page.getByRole("dialog", { name: "Contents" })).not.toBeVisible();

    await expect.poll(() => passageIsVisiblyIntersecting(page, READER_DEPTH_LATE_CONTEXT), { timeout: 30_000 }).toBe(true);
    expect(await passageIsVisiblyIntersecting(page, READER_DEPTH_EARLY_CONTEXT)).toBe(false);
    await assertNoTransientMarker(page);
    await expect.poll(async () => {
      const { data } = await service.from("reading_progress").select("client_sequence").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
      return data?.client_sequence ?? -1;
    }, { timeout: 30_000 }).toBeGreaterThan(beforeActivation!.client_sequence);
    const { data: progress } = await service.from("reading_progress").select("client_sequence, locator_json, updated_at").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).single();
    expect(progress!.client_sequence).toBeGreaterThan(beforeActivation!.client_sequence);
    expect(Date.parse(progress!.updated_at)).toBeGreaterThan(Date.parse(beforeActivation!.updated_at));
    const activatedLocator = progress!.locator_json as { href: string; locations: { cssSelector?: string; textOffset?: number }; text?: unknown };
    const bookmarkLocator = savedBookmark!.locator_json as { href: string; locations: { cssSelector?: string; textOffset?: number }; text?: unknown };
    expect(activatedLocator.href).toBe(bookmarkLocator.href);
    expect(activatedLocator.locations.textOffset).toBe(bookmarkLocator.locations.textOffset);
    expect(activatedLocator.locations.cssSelector).toBe(bookmarkLocator.locations.cssSelector);
    expect(activatedLocator.text).toEqual(bookmarkLocator.text);
    expect(JSON.stringify(activatedLocator)).not.toContain("infinity-target-");
  });

  test("searches Vietnamese with and without accents and bounds every returned text field", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, book, "reader-depth-search", "vi");

    for (const query of ["Hành trình", "hanh trinh"]) {
      await openSearch(page);
      await page.getByRole("searchbox", { name: "Tìm trong sách" }).fill(query);
      const result = page.getByRole("button", { name: /Hành trình qua cửa biển/ }).first();
      await expect(result).toBeVisible({ timeout: 15_000 });
      await result.click();
      await expect.poll(() => passageIsVisiblyIntersecting(page, READER_DEPTH_VIETNAMESE), { timeout: 30_000 }).toBe(true);
    }

    await openSearch(page);
    const responsePromise = page.waitForResponse((response) => response.url().includes(`/search?q=${encodeURIComponent(READER_DEPTH_LONG_CHUNK_TERM).replace(/%20/g, "+")}`) || response.url().includes(`/search?q=${encodeURIComponent(READER_DEPTH_LONG_CHUNK_TERM)}`));
    await page.getByRole("searchbox", { name: "Tìm trong sách" }).fill(READER_DEPTH_LONG_CHUNK_TERM);
    const response = await responsePromise;
    const payload = await response.json() as { results: Array<{ excerpt: string; locator: { href: string; locations: { cssSelector: string; textOffset: number }; text?: { before?: string; highlight?: string; after?: string } } }> };
    expect(payload.results.length).toBeGreaterThan(0);
    for (const result of payload.results) {
      expect(Array.from(result.excerpt).length).toBeLessThanOrEqual(240);
      expect(Array.from(result.locator.text?.highlight ?? "").length).toBeLessThanOrEqual(160);
      expect(Array.from(result.locator.text?.before ?? "").length).toBeLessThanOrEqual(64);
      expect(Array.from(result.locator.text?.after ?? "").length).toBeLessThanOrEqual(64);
    }
    const { data: chunks } = await createServiceRoleClient().from("ebook_search_chunks").select("href, plain_text, locator_json").eq("publication_id", book.publicationId).ilike("plain_text", `%${READER_DEPTH_LONG_CHUNK_TERM}%`);
    expect(chunks).toHaveLength(1);
    const backingChunk = chunks![0];
    expect(Array.from(backingChunk.plain_text).length).toBeGreaterThan(240);
    const targetResult = payload.results.find((result) => result.excerpt.includes(READER_DEPTH_LONG_CHUNK_TERM));
    expect(targetResult).toBeDefined();
    const locatorContext = `${targetResult!.locator.text?.before ?? ""}${targetResult!.locator.text?.highlight ?? ""}${targetResult!.locator.text?.after ?? ""}`;
    const storedLocator = backingChunk.locator_json as { locations: { cssSelector: string; textOffset: number } };
    expect(targetResult!.locator.href).toContain(`/resources/${backingChunk.href}`);
    expect(backingChunk.plain_text.indexOf(READER_DEPTH_LONG_CHUNK_TERM)).toBe(920);
    expect(targetResult!.locator.locations.cssSelector).toBe(storedLocator.locations.cssSelector);
    expect(targetResult!.locator.locations.textOffset).toBe(storedLocator.locations.textOffset + 920);
    expect(targetResult!.locator.text?.highlight?.startsWith(READER_DEPTH_LONG_CHUNK_TERM)).toBe(true);
    expect(targetResult!.excerpt).not.toBe(backingChunk.plain_text);
    expect(locatorContext).not.toBe(backingChunk.plain_text);
    expect(backingChunk.plain_text).toContain(targetResult!.locator.text?.highlight ?? "");
    expect(Array.from(locatorContext).length).toBeLessThan(Array.from(backingChunk.plain_text).length);
    await page.getByRole("button", { name: targetResult!.excerpt, exact: true }).click();
    await expect.poll(() => passageIsVisiblyIntersecting(page, READER_DEPTH_LONG_CHUNK_TERM), { timeout: 30_000 }).toBe(true);
  });

  test("limits attributed copy/share and keeps disabled Ask Infinity network-inert", async ({ page }) => {
    test.setTimeout(240_000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => { (window as typeof window & { __readerCopied?: string }).__readerCopied = text; } },
      });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async ({ text }: { text?: string }) => {
          (window as typeof window & { __readerShared?: string }).__readerShared = text;
        },
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await openReader(page, book, "reader-depth-quote");
    await selectKnownPassage(page, READER_DEPTH_LONG_QUOTE);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    const copied = await page.evaluate(() => (window as typeof window & { __readerCopied?: string }).__readerCopied ?? "");
    const quote = copied.match(/^“([\s\S]*)”\n-/)?.[1] ?? "";
    const graphemes = "Segmenter" in Intl
      ? [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(quote)].length
      : Array.from(quote).length;
    expect(graphemes).toBe(300);
    expect(copied).toContain("- Reader Depth Fixture, E2E Author");
    expect(copied).toContain(`/en/books/${book.slug}`);

    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __readerShared?: string }).__readerShared ?? "")).not.toBe("");
    const shared = await page.evaluate(() => (window as typeof window & { __readerShared?: string }).__readerShared ?? "");
    // S16: Share carries the public card URL; the quote and attribution lines are unchanged.
    expect(shared.split("\n").slice(0, -1)).toEqual(copied.split("\n").slice(0, -1));
    expect(shared.split("\n").at(-1)).toMatch(/\/en\/q\/[A-Za-z0-9_-]{10}$/);

    await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as typeof window & { __readerCopied?: string }).__readerCopied))
      .toMatch(/\/en\/q\/[A-Za-z0-9_-]{10}$/);

    const emitted: string[] = [];
    page.on("request", (request) => emitted.push(request.url()));
    const ask = page.getByRole("button", { name: "Ask Infinity" });
    await expect(ask).toBeDisabled();
    // A disabled button cannot take focus, so focus() leaves it on Share; since S16 Share mints a
    // card, and Enter/Space there would be counted here. Clear focus first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await ask.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(emitted).toEqual([]);

    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("blocked"); } } }));
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Could not copy quote" })).toBeVisible();
  });

  test("keeps the public sample isolated from private depth endpoints", async ({ page }) => {
    test.setTimeout(240_000);
    const forbiddenCalls: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (/^\/api\/reader\/(?:annotations(?:\/|$)|publications\/[^/]+\/(?:annotations|search)(?:\/|$))/.test(pathname)) forbiddenCalls.push(pathname);
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/en/read-sample/${book.slug}`);
    await waitForReaderReady(page);
    await page.getByRole("button", { name: "Reading settings" }).click();
    await page.getByRole("radio", { name: "Paper" }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForTimeout(300);
    expect(forbiddenCalls).toEqual([]);
  });

  test("denies missing sessions and foreign annotation IDs with private responses", async ({ page, request }) => {
    test.setTimeout(240_000);
    const anonymous = await request.get(`/api/reader/publications/${book.publicationId}/annotations`);
    expect(anonymous.status()).toBe(401);
    expect(anonymous.headers()["cache-control"]).toBe("private, no-store");

    const owner = await openReader(page, book, "reader-depth-owner");
    await page.context().clearCookies({ name: `reader-session-${book.publicationId}` });
    const missingCookie = await page.evaluate(async (publicationId) => {
      const response = await fetch(`/api/reader/publications/${publicationId}/annotations`);
      return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
    }, book.publicationId);
    expect(missingCookie).toEqual({ status: 404, cache: "private, no-store", body: { error: "Not found." } });
    await page.context().addCookies([{ name: `reader-session-${book.publicationId}`, value: crypto.randomUUID(), domain: "127.0.0.1", path: "/api", httpOnly: true, sameSite: "Lax" }]);
    const invalidCookie = await page.evaluate(async (publicationId) => {
      const response = await fetch(`/api/reader/publications/${publicationId}/annotations`);
      return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
    }, book.publicationId);
    expect(invalidCookie).toEqual({ status: 404, cache: "private, no-store", body: { error: "Not found." } });
    await page.reload();
    await waitForReaderReady(page);
    const service = createServiceRoleClient();
    const { data: positions } = await service.from("ebook_publications").select("positions_json").eq("id", book.publicationId).single();
    const original = (positions?.positions_json as Array<{ href: string; progression: number; totalProgression: number | null; locations: Record<string, string | number>; text?: unknown }>)[0];
    const locator = { ...original, href: `/api/reader/publications/${book.publicationId}/resources/${original.href}` };
    const annotationId = crypto.randomUUID();
    const { error } = await service.from("reader_annotations").insert({
      id: annotationId,
      profile_id: owner.profileId,
      publication_id: book.publicationId,
      kind: "bookmark",
      locator_json: locator,
      label: "Owner only",
    });
    if (error) throw error;

    const foreignContext = await page.context().browser()!.newContext();
    const foreignPage = await foreignContext.newPage();
    const foreign = await createReader("reader-depth-foreign");
    await grantEntitlement(book.bookId, foreign.email);
    await signInAs(foreignPage, foreign.email, `/en/read/${book.bookId}`);
    await waitForReaderReady(foreignPage);
    const denial = await foreignPage.evaluate(async ({ annotationId, publicationId }) => {
      const response = await fetch(`/api/reader/annotations/${annotationId}?publicationId=${publicationId}`, { method: "DELETE" });
      return { status: response.status, cache: response.headers.get("Cache-Control"), body: await response.json() };
    }, { annotationId, publicationId: book.publicationId });
    expect(denial).toEqual({ status: 404, cache: "private, no-store", body: { error: "Not found." } });
    await foreignContext.close();
  });

  test("recovers one expired session, then tears down on revocation and reads again after restoration", async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 768, height: 900 });
    const reader = await openReader(page, book, "reader-depth-recovery");
    const service = createServiceRoleClient();
    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    await page.getByRole("button", { name: "Yellow", exact: true }).click();
    const restoredHighlightId = await expect.poll(async () => {
      const { data } = await service.from("reader_annotations").select("id").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data?.id ?? null;
    }, { timeout: 30_000 }).not.toBeNull().then(async () => {
      const { data } = await service.from("reader_annotations").select("id").eq("profile_id", reader.profileId).eq("publication_id", book.publicationId).eq("selected_text", READER_DEPTH_SELECTION).single();
      return data!.id;
    });
    await service.from("reader_sessions").update({ expires_at: new Date(0).toISOString() }).eq("profile_id", reader.profileId).eq("publication_id", book.publicationId);
    let mintCount = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/reader/sessions" && request.method() === "POST") mintCount += 1; });
    await openSearch(page);
    await page.getByRole("searchbox", { name: "Search this book" }).fill("compass");
    await expect(page.getByRole("button", { name: /brass compass/ }).first()).toBeVisible({ timeout: 30_000 });
    expect(mintCount).toBe(1);

    await service.from("entitlements").update({ status: "revoked", revoked_at: new Date().toISOString() }).eq("profile_id", reader.profileId).eq("book_id", book.bookId);
    const revoked = await page.evaluate(async (publicationId) => Promise.all([
      `/api/reader/publications/${publicationId}/manifest`,
      `/api/reader/publications/${publicationId}/annotations`,
      `/api/reader/publications/${publicationId}/search?q=lantern`,
    ].map(async (path) => {
      const response = await fetch(path);
      return { path, status: response.status, cache: response.headers.get("Cache-Control") };
    })), book.publicationId);
    expect(revoked).toEqual([
      { path: `/api/reader/publications/${book.publicationId}/manifest`, status: 404, cache: "private, no-store" },
      { path: `/api/reader/publications/${book.publicationId}/annotations`, status: 404, cache: "private, no-store" },
      { path: `/api/reader/publications/${book.publicationId}/search?q=lantern`, status: 404, cache: "private, no-store" },
    ]);
    await page.getByRole("searchbox", { name: "Search this book" }).fill("lantern");
    await expect(page.getByText("You no longer have access to this book.")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("toolbar")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reader menu" })).toHaveCount(0);
    await expect(page.locator("iframe.readium-navigator-iframe")).toHaveCount(0);
    await service.from("entitlements").update({ status: "active", revoked_at: null }).eq("profile_id", reader.profileId).eq("book_id", book.bookId);
    await page.reload();
    await waitForReaderReady(page);
    await openSavedDrawer(page);
    await page.getByRole("tab", { name: /Bookmarks \(0\)/ }).click();
    await expect(page.getByRole("button", { name: READER_DEPTH_SELECTION })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.poll(() => decorationIsVisiblyIntersecting(page, restoredHighlightId, READER_DEPTH_SELECTION), { timeout: 30_000 }).toBe(true);
  });

  test("denies a superseded publication and keeps an old null-position publication readable", async ({ page }) => {
    test.setTimeout(240_000);
    await openReader(page, book, "reader-depth-rollout");
    const service = createServiceRoleClient();
    const { data: edition } = await service.from("editions").select("id").eq("book_id", book.bookId).single();
    const { data: assets } = await service.from("ebook_assets").select("id").eq("edition_id", edition!.id);
    const { data: previous } = await service.from("ebook_publications").select("id").in("ebook_asset_id", (assets ?? []).map((asset) => asset.id)).neq("id", book.publicationId).limit(1).maybeSingle();
    if (!previous) throw new Error("The fixture placeholder publication is missing.");
    // A rollback to the older version: it becomes the published, pointed-at one and this one is
    // superseded. (Pointing at a non-published row alone would leave this publication readable,
    // because the owner's readable publication then falls back to the latest published one.)
    await service.from("ebook_publications").update({ status: "superseded" }).eq("id", book.publicationId);
    await service.from("ebook_publications").update({ status: "published" }).eq("id", previous.id);
    await service.from("editions").update({ active_publication_id: previous.id }).eq("id", edition!.id);
    const denied = await page.evaluate(async (publicationId) => Promise.all([
      `/api/reader/publications/${publicationId}/manifest`,
      `/api/reader/publications/${publicationId}/annotations`,
      `/api/reader/publications/${publicationId}/search?q=compass`,
    ].map(async (path) => {
      const response = await fetch(path);
      return { path, status: response.status, cache: response.headers.get("Cache-Control") };
    })), book.publicationId);
    expect(denied).toEqual([
      { path: `/api/reader/publications/${book.publicationId}/manifest`, status: 404, cache: "private, no-store" },
      { path: `/api/reader/publications/${book.publicationId}/annotations`, status: 404, cache: "private, no-store" },
      { path: `/api/reader/publications/${book.publicationId}/search?q=compass`, status: 404, cache: "private, no-store" },
    ]);
    await service.from("ebook_publications").update({ status: "superseded" }).eq("id", previous.id);
    await service.from("ebook_publications").update({ status: "published" }).eq("id", book.publicationId);
    await service.from("editions").update({ active_publication_id: book.publicationId }).eq("id", edition!.id);
    await service.from("ebook_publications").update({ positions_json: null }).eq("id", book.publicationId);
    await page.reload();
    await waitForReaderReady(page);
    await expect(page.getByText(/^(Page|pages) /)).toHaveCount(0);
  });

  test("passes axe, keyboard focus, locale, reduced-motion and active-frame theme checks", async ({ page, browserName }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await openReader(page, book, "reader-depth-accessibility");
    const shellResults = await new AxeBuilder({ page }).include('[data-testid="reader-shell"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(shellResults.violations).toEqual([]);

    const settings = page.getByRole("button", { name: "Reading settings" });
    await page.getByRole("link", { name: "Back to library" }).focus();
    for (let index = 0; index < 12 && !(await settings.evaluate((element) => element === document.activeElement)); index += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(settings).toBeFocused();
    const outline = await settings.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).not.toBe("0px");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Reading settings" })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Paper" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Normal" })).toBeChecked();
    // Publisher-colour assertions below exercise the explicit light theme.
    await page.getByRole("radio", { name: "Light" }).click();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();

    const frame = await activeReadingFrame(page);
    const frameA11y = await frame.locator("body").ariaSnapshot();
    expect(frameA11y).toContain("Chapter 1");
    // Readium's CSP upgrades linked assets on loopback HTTP, while WebKit omits cookies from the
    // resulting blob-frame request. Chromium/Firefox retain the publisher-CSS assertion; WebKit
    // remains in the functional matrix for theme/layout/accessibility and is an explicit corpus
    // gap until a credential-safe linked-resource delivery mechanism is implemented.
    if (browserName !== "webkit") {
      expect(await frameThemeStyles(page)).toMatchObject({ headingColor: "rgb(1, 2, 3)" });
    }

    await settings.click();
    await page.getByRole("radio", { name: "Paper" }).click();
    await page.keyboard.press("Escape");
    const paper = await frameThemeStyles(page);
    expect(paper.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    await settings.click();
    await page.getByRole("radio", { name: "Dark" }).click();
    await page.keyboard.press("Escape");
    const dark = await frameThemeStyles(page);
    expect(dark.backgroundColor).not.toBe(paper.backgroundColor);
    const transition = await page.locator('[data-testid="reader-shell"]').evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(transition === "0s" || transition === "").toBe(true);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.getByRole("button", { name: "Reader menu" }).click();
    await page.getByRole("menuitem", { name: "Contents" }).click();
    const drawer = page.getByRole("dialog", { name: "Contents" });
    await expect(drawer).toBeVisible();
    const drawerResults = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(drawerResults.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Reader menu" })).toBeFocused();

    expect(await publicationKeyboardSelectionSurface(page)).toEqual({
      textInputs: 0,
      editableElements: 0,
      tabbableTextContainers: 0,
    });

    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    const yellow = page.getByRole("button", { name: "Yellow", exact: true });
    await yellow.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("button", { name: "Green", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("toolbar", { name: READER_DEPTH_SELECTION })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Reader" })).toBeFocused();

    await page.getByRole("button", { name: "Reader menu" }).click();
    await page.getByRole("menuitem", { name: "Add bookmark" }).click();
    const editor = page.getByRole("dialog", { name: "Add bookmark" });
    await expect(editor).toBeVisible();
    const editorResults = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(editorResults.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Reader menu" })).toBeFocused();

    for (const theme of ["Light", "Paper", "Dark"]) {
      await page.getByRole("button", { name: "Reader menu" }).click();
      await page.getByRole("menuitem", { name: "Reading settings" }).click();
      const themeGroup = page.getByRole("radiogroup", { name: "Theme" });
      for (let stop = 0; stop < 12 && !(await themeGroup.evaluate((group) => group.contains(document.activeElement))); stop += 1) {
        await page.keyboard.press("Tab");
      }
      await expect(themeGroup.locator(":focus")).toHaveCount(1);
      for (let move = 0; move < 3 && !(await page.getByRole("radio", { name: theme }).getAttribute("aria-checked").then((value) => value === "true")); move += 1) {
        await page.keyboard.press("ArrowRight");
      }
      const focused = page.getByRole("radio", { name: theme });
      await expect(focused).toBeFocused();
      const focusStyle = await focused.evaluate((element) => ({ width: getComputedStyle(element).outlineWidth, style: getComputedStyle(element).outlineStyle }));
      expect(focusStyle.style).not.toBe("none");
      expect(focusStyle.width).not.toBe("0px");
      await page.keyboard.press("Escape");
    }
  });
});
