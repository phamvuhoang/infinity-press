import { describe, expect, it } from "vitest";

import { parseAnnotationDraft, parseAnnotationPatch } from "@/lib/reader/annotations";
import type { ReaderLocator } from "@/lib/reader/types";

const locator: ReaderLocator = {
  href: "/api/reader/publications/c0000000-0000-4000-8000-000000000001/resources/OEBPS/chapter.xhtml",
  progression: 0.25,
  totalProgression: 0.5,
  locations: { position: 4, cssSelector: "p:nth-child(2)" },
  text: { before: "before", highlight: "selected", after: "after" },
};

describe("parseAnnotationDraft", () => {
  it("rebuilds a highlight from only bounded contract fields", () => {
    expect(
      parseAnnotationDraft({
        kind: "highlight",
        locator,
        selectedText: "selected",
        color: "yellow",
        noteText: null,
      }),
    ).toEqual({ kind: "highlight", locator, selectedText: "selected", color: "yellow", noteText: null });
  });

  it("rejects a blank bookmark label", () => {
    expect(() => parseAnnotationDraft({ kind: "bookmark", locator, label: " " })).toThrow();
  });

  it("rejects a highlight selection above 1,000 code points", () => {
    expect(() =>
      parseAnnotationDraft({
        kind: "highlight",
        locator: { ...locator, text: { highlight: "x".repeat(1001) } },
        selectedText: "x".repeat(1001),
        color: "yellow",
        noteText: null,
      }),
    ).toThrow();
  });

  it("rejects a selected-text value that does not equal the locator quote", () => {
    expect(() =>
      parseAnnotationDraft({
        kind: "highlight",
        locator,
        selectedText: "different",
        color: "yellow",
        noteText: null,
      }),
    ).toThrow();
  });

  it("uses Unicode code points for text bounds", () => {
    const selectedText = "😀".repeat(1_000);
    expect(
      parseAnnotationDraft({
        kind: "highlight",
        locator: { ...locator, text: { highlight: selectedText } },
        selectedText,
        color: "rose",
        noteText: "😀".repeat(5_000),
      }).kind,
    ).toBe("highlight");
  });

  it.each([
    ["non-finite progression", { ...locator, progression: Number.NaN }],
    ["non-finite location", { ...locator, locations: { position: Number.POSITIVE_INFINITY } }],
    ["long context", { ...locator, text: { before: "x".repeat(65), highlight: "selected" } }],
  ])("rejects a locator with %s", (_name, invalidLocator) => {
    expect(() =>
      parseAnnotationDraft({
        kind: "highlight",
        locator: invalidLocator,
        selectedText: "selected",
        color: "green",
        noteText: null,
      }),
    ).toThrow();
  });

  it("rejects a locator whose serialized UTF-8 size exceeds 16 KiB", () => {
    expect(() =>
      parseAnnotationDraft({
        kind: "bookmark",
        locator: { ...locator, locations: { huge: "😀".repeat(4_100) }, text: undefined },
        label: "Bookmark",
      }),
    ).toThrow();
  });

  it("rejects unknown fields instead of silently stripping immutable fields", () => {
    expect(() =>
      parseAnnotationDraft({ kind: "bookmark", locator, label: "Bookmark", publicationId: "publication" }),
    ).toThrow();
  });
});

describe("parseAnnotationPatch", () => {
  it("accepts bounded highlight and bookmark changes", () => {
    expect(parseAnnotationPatch({ kind: "highlight", color: "green", noteText: null })).toEqual({
      kind: "highlight",
      color: "green",
      noteText: null,
    });
    expect(parseAnnotationPatch({ kind: "bookmark", label: "Chapter one" })).toEqual({
      kind: "bookmark",
      label: "Chapter one",
    });
  });

  it.each(["profileId", "publicationId", "locator", "selectedText"])(
    "rejects an attempted %s mutation",
    (field) => {
      expect(() => parseAnnotationPatch({ kind: "highlight", color: "yellow", [field]: "changed" })).toThrow();
    },
  );

  it("rejects empty highlight patches and oversized note text", () => {
    expect(() => parseAnnotationPatch({ kind: "highlight" })).toThrow();
    expect(() => parseAnnotationPatch({ kind: "highlight", noteText: "x".repeat(5_001) })).toThrow();
  });
});
