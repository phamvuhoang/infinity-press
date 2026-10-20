import { describe, expect, it } from "vitest";

import { chapterTitleFor, flattenToc } from "@/lib/reader/toc";
import type { ReaderTocEntry } from "@/lib/reader/types";

// Hrefs as the manifest actually carries them: already rewritten to Route Handler URLs, and often
// carrying a fragment that points within a document rather than at a different one.
const toc: ReaderTocEntry[] = [
  { title: "Cover", href: "/api/reader/publications/p1/resources/cover.xhtml", children: [] },
  {
    title: "Part One",
    href: "/api/reader/publications/p1/resources/c1.xhtml",
    children: [
      { title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#start", children: [] },
      { title: "An Ending", href: "/api/reader/publications/p1/resources/c2.xhtml", children: [] },
    ],
  },
];

describe("flattenToc", () => {
  it("lists every entry in reading order with its depth", () => {
    expect(flattenToc(toc)).toEqual([
      { title: "Cover", href: "/api/reader/publications/p1/resources/cover.xhtml", depth: 0 },
      { title: "Part One", href: "/api/reader/publications/p1/resources/c1.xhtml", depth: 0 },
      { title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#start", depth: 1 },
      { title: "An Ending", href: "/api/reader/publications/p1/resources/c2.xhtml", depth: 1 },
    ]);
  });

  it("returns nothing for an empty table of contents", () => {
    expect(flattenToc([])).toEqual([]);
  });
});

describe("chapterTitleFor", () => {
  it("names the entry whose document the reader is in", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c2.xhtml")).toBe("An Ending");
  });

  // The deepest match wins. Both "Part One" and "A Beginning" point at c1.xhtml, and the nested
  // entry is the more precise answer to "where am I".
  it("prefers a nested entry over its ancestor", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c1.xhtml")).toBe("A Beginning");
  });

  // A locator carries its own fragment, and TOC hrefs routinely carry one too. Comparing whole
  // strings would match almost nothing in a real publication's nav.
  it("ignores fragments on both sides", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/c2.xhtml#para-4")).toBe("An Ending");
  });

  // Front matter absent from the nav is common. No title is better than a wrong one.
  it("returns null when the reader is in a document the nav does not name", () => {
    expect(chapterTitleFor(toc, "/api/reader/publications/p1/resources/colophon.xhtml")).toBeNull();
  });

  it("returns null without a locator", () => {
    expect(chapterTitleFor(toc, null)).toBeNull();
    expect(chapterTitleFor([], "/api/reader/publications/p1/resources/c1.xhtml")).toBeNull();
  });
});
