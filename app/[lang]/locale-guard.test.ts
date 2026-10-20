import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// app/[lang]/layout.tsx does not reject an unsupported locale any more - it resolves to
// defaultLocale and lets the page below reject it instead (Ruling F: a layout cannot see a
// notFound() thrown by its own render, so app/[lang]/not-found.tsx can only catch a throw that
// comes from a descendant). That only still 404s an unsupported locale (e.g. /fr) if EVERY
// page.tsx under app/[lang] guards its own locale, directly with isLocale()/notFound() or by
// rendering EntityPage (which does the same). A page added without either would silently render
// with a garbage `lang` instead of 404ing. This test pins that invariant.
const localeRoot = join(process.cwd(), "app", "[lang]");

function findPageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return findPageFiles(path);
    return entry === "page.tsx" ? [path] : [];
  });
}

describe("every page under app/[lang] guards its own locale", () => {
  const pageFiles = findPageFiles(localeRoot);

  it("found at least one page.tsx to check", () => {
    expect(pageFiles.length).toBeGreaterThan(0);
  });

  it.each(pageFiles)("%s calls isLocale() or renders EntityPage", (path) => {
    const source = readFileSync(path, "utf8");
    const guardsDirectly = /isLocale\(/.test(source);
    const delegatesToEntityPage = /EntityPage/.test(source);

    expect(
      guardsDirectly || delegatesToEntityPage,
      `${relative(process.cwd(), path)} must call isLocale() itself or render EntityPage, or an unsupported locale will render instead of 404ing`,
    ).toBe(true);
  });
});
