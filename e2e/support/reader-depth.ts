import { expect, type Frame, type Page } from "@playwright/test";

const ACTIVE_FRAME_SELECTOR = "iframe.readium-navigator-iframe";

export async function waitForReaderReady(page: Page, nextLabel = /Next page|Trang sau/): Promise<void> {
  await expect(page.getByRole("button", { name: nextLabel })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("region", { name: /Reader|Trình đọc/ })).toHaveAttribute("aria-busy", "false");
  await page.waitForFunction(() => document.fonts.status === "loaded");
  await expect.poll(async () => (await activeReadingFrames(page)).length, { timeout: 60_000 }).toBeGreaterThan(0);
}

export async function activeReadingFrames(page: Page): Promise<Frame[]> {
  const handles = await page.locator(ACTIVE_FRAME_SELECTOR).elementHandles();
  const frames: Frame[] = [];
  for (const handle of handles) {
    const active = await handle.evaluate((element) => {
      const style = getComputedStyle(element as HTMLElement);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    }).catch(() => false);
    const frame = active ? await handle.contentFrame() : null;
    if (frame) frames.push(frame);
  }
  return frames;
}

export async function activeReadingFrame(page: Page, containingText?: string): Promise<Frame> {
  const frames = await activeReadingFrames(page);
  if (containingText) {
    for (const frame of frames) {
      const contains = await frame.evaluate((text) => document.body?.textContent?.includes(text) ?? false, containingText).catch(() => false);
      if (contains) return frame;
    }
  }
  if (!frames[0]) throw new Error("No active Readium publication frame is available.");
  return frames[0];
}

export async function selectKnownPassage(page: Page, passage: string, occurrence = 0): Promise<void> {
  const frame = await activeReadingFrame(page, passage);
  const selected = await frame.evaluate(({ passage, occurrence }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let remaining = occurrence;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      let from = 0;
      while (from <= node.data.length) {
        const index = node.data.indexOf(passage, from);
        if (index === -1) break;
        if (remaining === 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + passage.length);
          const selection = getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          const target = node.parentElement ?? document.body;
          target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
          target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true, pointerType: "mouse" }));
          return selection?.toString() ?? "";
        }
        remaining -= 1;
        from = index + passage.length;
      }
    }
    return "";
  }, { passage, occurrence });
  expect(selected).toBe(passage);
  await expect(page.getByRole("toolbar", { name: passage })).toBeVisible();
}

export async function passageIsVisiblyIntersecting(page: Page, passage: string): Promise<boolean> {
  const frames = await activeReadingFrames(page);
  for (const frame of frames) {
    const visible = await frame.evaluate((text) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const index = node.data.indexOf(text);
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        return Array.from(range.getClientRects()).some((rect) =>
          rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < window.innerWidth && rect.top < window.innerHeight,
        );
      }
      return false;
    }, passage).catch(() => false);
    if (visible) return true;
  }
  return false;
}

export async function decorationIsVisiblyIntersecting(
  page: Page,
  annotationId: string,
  passage: string,
): Promise<boolean> {
  const frame = await activeReadingFrame(page, passage);
  return frame.evaluate(({ annotationId, passage }) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let passageVisible = false;
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const index = node.data.indexOf(passage);
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + passage.length);
      passageVisible = Array.from(range.getClientRects()).some((rect) =>
        rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight,
      );
      break;
    }
    if (!passageVisible) return false;

    const roots: Array<Document | ShadowRoot> = [document];
    for (let index = 0; index < roots.length; index += 1) {
      for (const element of roots[index].querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    const overlayVisible = roots.some((root) => Array.from(root.querySelectorAll<HTMLElement>(`[data-highlight-id="${CSS.escape(annotationId)}"] [data-readium="true"]`)).some((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight;
    }));
    if (overlayVisible) return true;

    // Chromium uses the CSS Custom Highlight API rather than overlay elements. Readium groups
    // same-colour annotations under generated highlight names, so the browser API cannot expose
    // the annotation id; correlate the id through the backing row and prove that one live custom-
    // highlight range covers this exact visible text.
    const highlights = (CSS as typeof CSS & { highlights?: Map<string, Iterable<Range>> }).highlights;
    if (!highlights) return false;
    for (const highlight of highlights.values()) {
      for (const abstractRange of highlight) {
        const range = abstractRange as Range;
        if (range.toString() !== passage) continue;
        if (Array.from(range.getClientRects()).some((rect) =>
          rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 &&
          rect.left < window.innerWidth && rect.top < window.innerHeight,
        )) return true;
      }
    }
    return false;
  }, { annotationId, passage }).catch(() => false);
}

export async function visiblePublicationGeometry(page: Page): Promise<{
  occupiedHalves: number[];
  clippedRects: number;
  visibleTextRects: number;
}> {
  const frame = await activeReadingFrame(page);
  return frame.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const occupied = new Set<number>();
    let clippedRects = 0;
    let visibleTextRects = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (!node.data.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.bottom <= 0 || rect.left >= viewport.width || rect.top >= viewport.height) continue;
        visibleTextRects += 1;
        if (rect.left < -0.5 || rect.right > viewport.width + 0.5) clippedRects += 1;
        occupied.add(rect.left + rect.width / 2 < viewport.width / 2 ? 0 : 1);
      }
    }
    return { occupiedHalves: [...occupied].sort(), clippedRects, visibleTextRects };
  });
}

export async function publicationKeyboardSelectionSurface(page: Page): Promise<{
  textInputs: number;
  editableElements: number;
  tabbableTextContainers: number;
}> {
  const frame = await activeReadingFrame(page);
  return frame.evaluate(() => ({
    textInputs: document.querySelectorAll('input:not([type]), input[type="text"], input[type="search"], textarea').length,
    editableElements: document.querySelectorAll('[contenteditable=""], [contenteditable="true"]').length,
    // This counts non-interactive text containers the application deliberately made reachable by
    // keyboard. Native browser/assistive-technology caret browsing is not represented by tabindex
    // and remains a physical-browser manual gate.
    tabbableTextContainers: Array.from(document.querySelectorAll<HTMLElement>("[tabindex]"))
      .filter((element) => element.tabIndex >= 0 && !element.matches("a, button, input, select, textarea, [contenteditable]"))
      .length,
  }));
}

export async function assertNoTransientMarker(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    expect(await frame.locator('[id^="infinity-target-"]').count().catch(() => 0)).toBe(0);
  }
}

export async function frameThemeStyles(page: Page): Promise<{ color: string; backgroundColor: string; headingColor: string }> {
  const frame = await activeReadingFrame(page);
  return frame.evaluate(() => {
    const html = getComputedStyle(document.documentElement);
    const body = getComputedStyle(document.body);
    const heading = document.querySelector("h1");
    const backgroundColor = body.backgroundColor === "rgba(0, 0, 0, 0)"
      ? html.backgroundColor
      : body.backgroundColor;
    return {
      color: body.color,
      backgroundColor,
      headingColor: heading ? getComputedStyle(heading).color : "",
    };
  });
}
