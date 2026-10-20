import { expect, test, type Page } from "@playwright/test";

import { createReader, signInAs } from "./support/commerce";
import { READER_DEPTH_SELECTION, grantEntitlement, seedProcessedBook } from "./support/publication";
import { activeReadingFrame, selectKnownPassage, visiblePublicationGeometry, waitForReaderReady } from "./support/reader-depth";
import { createServiceRoleClient } from "./support/supabase";
import { READER_VISUAL_ARCH, READER_VISUAL_CHROMIUM_VERSION, READER_VISUAL_NAVIGATOR_PLATFORM, READER_VISUAL_NODE_VERSION, READER_VISUAL_PLATFORM } from "./support/visual-contract";

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const heights: Record<number, number> = { 390: 844, 768: 900, 1440: 960 };
const themes = ["light", "sepia", "dark"] as const;

type SeededBook = Awaited<ReturnType<typeof seedProcessedBook>>;

async function openVisualReader(page: Page, book: SeededBook, email: string, width: number, theme: typeof themes[number]) {
  await page.setViewportSize({ width, height: heights[width] });
  await page.addInitScript((readerTheme) => {
    localStorage.setItem("infinity-books.reader.preferences", JSON.stringify({ fontScale: 1, fontFamily: "publisher", lineHeight: 1.5, width: "wide", theme: readerTheme }));
  }, theme);
  await signInAs(page, email, `/en/read/${book.bookId}`);
  await waitForReaderReady(page);
  await page.addStyleTag({ content: "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function expectVisibleTargetsAtLeast44(page: Page): Promise<void> {
  const tooSmall = await page.locator("a, button, [role=radio], [role=tab]").evaluateAll((targets) => targets
    .filter((target) => {
      const style = getComputedStyle(target as HTMLElement);
      return style.visibility !== "hidden" && style.display !== "none" &&
        !(target.classList.contains("sr-only") && target !== document.activeElement);
    })
    .filter((target) => {
      const rect = target.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
    })
    .map((target) => target.getAttribute("aria-label") ?? target.textContent?.trim() ?? target.tagName));
  expect(tooSmall).toEqual([]);
}

test.describe.serial("reader depth visual acceptance", () => {
  let book: SeededBook;
  let email: string;
  let profileId: string;

  test.beforeAll(async () => {
    const suffix = unique();
    book = await seedProcessedBook({
      suffix,
      readerDepthFixture: true,
      localizations: { en: { slug: `reader-depth-visual-${suffix}`, title: "Reader Depth Visual Fixture" } },
    });
    const reader = await createReader("reader-depth-visual");
    email = reader.email;
    profileId = reader.profileId;
    await grantEntitlement(book.bookId, email);
  });

  for (const width of [390, 768, 1440]) {
    for (const theme of themes) {
      test(`${width}px ${theme} shell`, async ({ page }) => {
        test.setTimeout(240_000);
        if (width === 390 && theme === "light") {
          expect(process.version).toBe(READER_VISUAL_NODE_VERSION);
          expect(process.env.E2E_VISUAL_PLATFORM).toBe(READER_VISUAL_PLATFORM);
          expect(process.env.E2E_VISUAL_ARCH).toBe(READER_VISUAL_ARCH);
          expect(page.context().browser()?.version()).toBe(READER_VISUAL_CHROMIUM_VERSION);
          expect(await page.evaluate(() => navigator.platform)).toBe(READER_VISUAL_NAVIGATOR_PLATFORM);
        }
        await openVisualReader(page, book, email, width, theme);
        const shell = page.getByTestId("reader-shell");
        const bounds = await shell.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);

        const active = await activeReadingFrame(page);
        const columns = await active.evaluate(() => {
          const html = getComputedStyle(document.documentElement);
          const body = getComputedStyle(document.body);
          return html.getPropertyValue("--USER__colCount").trim() ||
            (html.columnCount === "auto" ? body.columnCount : html.columnCount);
        });
        if (width >= 1280) {
          const sidebar = page.locator("aside").first();
          const sidebarBounds = await sidebar.boundingBox();
          expect(sidebarBounds?.width).toBeGreaterThanOrEqual(360);
          expect(sidebarBounds?.width).toBeLessThanOrEqual(420);
          expect(columns).toBe("2");
          const frameBounds = await page.locator("iframe.readium-navigator-iframe").first().boundingBox();
          const readerBounds = await page.getByRole("region", { name: "Reader" }).boundingBox();
          expect(frameBounds).not.toBeNull();
          expect(readerBounds).not.toBeNull();
          expect(frameBounds!.x).toBeGreaterThanOrEqual(readerBounds!.x);
          expect(frameBounds!.x + frameBounds!.width).toBeLessThanOrEqual(readerBounds!.x + readerBounds!.width);
          const geometry = await visiblePublicationGeometry(page);
          expect(geometry.visibleTextRects).toBeGreaterThan(0);
          expect(geometry.occupiedHalves).toEqual([0, 1]);
          expect(geometry.clippedRects).toBe(0);
          const divider = await page.getByTestId("reader-spread-divider").boundingBox();
          expect(divider).not.toBeNull();
          expect(Math.abs((divider!.x + divider!.width / 2) - (readerBounds!.x + readerBounds!.width / 2))).toBeLessThanOrEqual(1);
        } else {
          await expect(page.locator("aside")).toBeHidden();
          expect(columns).toBe("1");
          const geometry = await visiblePublicationGeometry(page);
          expect(geometry.visibleTextRects).toBeGreaterThan(0);
          expect(geometry.clippedRects).toBe(0);
        }

        await expectVisibleTargetsAtLeast44(page);
        if (width === 1440 && theme === "light") {
          await page.getByRole("button", { name: "Reading settings" }).click();
          await expectVisibleTargetsAtLeast44(page);
          await page.keyboard.press("Escape");
          await page.setViewportSize({ width: 768, height: heights[768] });
          await expect.poll(async () => (await activeReadingFrame(page).then((frame) => frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--USER__colCount").trim()))), { timeout: 30_000 }).toBe("1");
          const narrowGeometry = await visiblePublicationGeometry(page);
          expect(narrowGeometry.visibleTextRects).toBeGreaterThan(0);
          expect(narrowGeometry.clippedRects).toBe(0);
          await page.getByRole("button", { name: "Reader menu" }).click();
          await page.getByRole("menuitem", { name: "Contents" }).click();
          await expectVisibleTargetsAtLeast44(page);
          await page.keyboard.press("Escape");
          await page.setViewportSize({ width, height: heights[width] });
          await expect.poll(async () => (await activeReadingFrame(page).then((frame) => frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--USER__colCount").trim()))), { timeout: 30_000 }).toBe("2");
        }
        await expect(page).toHaveScreenshot(`reader-shell-${width}-${theme}.png`, {
          animations: "disabled",
          fullPage: true,
          maxDiffPixelRatio: 0.01,
        });
      });
    }
  }

  test("selection action geometry", async ({ page }) => {
    await openVisualReader(page, book, email, 390, "light");
    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    await expect(page).toHaveScreenshot("reader-selection-390-light.png", { animations: "disabled", fullPage: true });
  });

  test("note editor geometry and focus", async ({ page }) => {
    await openVisualReader(page, book, email, 768, "dark");
    await selectKnownPassage(page, READER_DEPTH_SELECTION);
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByRole("textbox", { name: "Note" })).toBeFocused();
    await expect(page).toHaveScreenshot("reader-note-editor-768-dark.png", { animations: "disabled", fullPage: true });
  });

  test("search result geometry", async ({ page }) => {
    await openVisualReader(page, book, email, 1440, "sepia");
    await page.getByRole("button", { name: "Search this book" }).click();
    await page.getByRole("searchbox", { name: "Search this book" }).fill("compass");
    await expect(page.getByRole("button", { name: /brass compass/ }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveScreenshot("reader-search-1440-paper.png", { animations: "disabled", fullPage: true });
  });

  test("completion geometry and links", async ({ page }) => {
    test.setTimeout(240_000);
    await openVisualReader(page, book, email, 1440, "dark");
    const next = page.getByRole("button", { name: "Next page" });
    const finished = page.getByText("You finished this book.");
    const position = page.locator('p[role="status"]').filter({ hasText: /^(Page|pages) / });
    for (let turn = 0; turn < 160 && !(await finished.isVisible()); turn += 1) {
      if (!(await next.isEnabled())) break;
      const previousPosition = await position.textContent();
      await next.click();
      // React does not await an async event handler before Playwright's click resolves. Wait for
      // the engine-derived position (or the terminal completion state) before deciding whether the
      // next control is still enabled, avoiding the isEnabled/click race at the final page.
      await expect.poll(async () =>
        await finished.isVisible() || await position.textContent() !== previousPosition,
      { timeout: 30_000 }).toBe(true);
    }
    await expect(finished).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => {
      const { data } = await createServiceRoleClient().from("reading_progress").select("total_progression").eq("profile_id", profileId).eq("publication_id", book.publicationId).single();
      return data?.total_progression ?? 0;
    }, { timeout: 30_000 }).toBeGreaterThanOrEqual(0.99);
    await expect(page.getByRole("link", { name: "Go to my library" })).toHaveAttribute("href", "/en/library");
    await expect(page.getByRole("button", { name: "Notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Highlights" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bookmarks" })).toBeVisible();
    // A full-page screenshot temporarily resizes the browser viewport to the document height.
    // Readium observes that resize and repaginates the active frame while Playwright is capturing,
    // so alternating frames can be internally stable yet differ from each other. Keep the fixed
    // 1440×960 acceptance viewport and scroll the completion state into view instead.
    await page.locator('aside[role="status"]').filter({ hasText: "You finished this book." }).scrollIntoViewIfNeeded();
    await expect(page).toHaveScreenshot("reader-completion-1440-dark.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    });
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByRole("tab", { name: /Notes \(0\)/ })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await waitForReaderReady(page);
    await expect(finished).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Highlights" }).click();
    await expect(page.getByRole("tab", { name: /Bookmarks \(0\)/ })).toHaveAttribute("aria-selected", "true");
    await page.reload();
    await waitForReaderReady(page);
    await expect(finished).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Bookmarks" }).click();
    await expect(page.getByRole("tab", { name: /Bookmarks \(0\)/ })).toHaveAttribute("aria-selected", "true");
  });
});
