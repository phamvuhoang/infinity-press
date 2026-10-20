import { describe, expect, it } from "vitest";

import {
  epubWithEmptySpine,
  epubWithEntityExpansion,
  epubWithMultipleRootfiles,
  validEpub,
  validEpubWithNcx,
  validEpubWithTocFragments,
} from "@/scripts/fixtures/create-test-epub";
import { openEpubArchive } from "@/lib/epub/archive";
import { buildToc, parseEpub } from "@/lib/epub/parse";

describe("parseEpub", () => {
  it("extracts metadata, manifest, and reading order from a valid publication", () => {
    const parsed = parseEpub(openEpubArchive(validEpub()));

    expect(parsed.metadata).toEqual({
      title: "Test Publication",
      language: "en",
      identifier: "urn:uuid:12345678-1234-1234-1234-123456789012",
      authors: ["Jane Author"],
    });
    expect(parsed.readingOrder).toEqual([
      { href: "OEBPS/text/chapter1.xhtml", mediaType: "application/xhtml+xml" },
      { href: "OEBPS/text/chapter2.xhtml", mediaType: "application/xhtml+xml" },
    ]);
    expect(parsed.manifest.map((item) => item.href).sort()).toEqual([
      "OEBPS/images/cover.jpg",
      "OEBPS/nav.xhtml",
      "OEBPS/styles/style.css",
      "OEBPS/text/chapter1.xhtml",
      "OEBPS/text/chapter2.xhtml",
    ]);
    expect(parsed.navHref).toBe("OEBPS/nav.xhtml");
    expect(parsed.ncxHref).toBeUndefined();
  });

  it("rejects a container.xml that names more than one root package document", () => {
    expect(() => parseEpub(openEpubArchive(epubWithMultipleRootfiles()))).toThrow(
      expect.objectContaining({ code: "INVALID_EPUB" }),
    );
  });

  it("rejects a package document with an empty spine", () => {
    expect(() => parseEpub(openEpubArchive(epubWithEmptySpine()))).toThrow(
      expect.objectContaining({ code: "INVALID_EPUB" }),
    );
  });

  it("falls back to the NCX for table-of-contents data when there is no EPUB3 nav document", () => {
    const archive = openEpubArchive(validEpubWithNcx());
    const parsed = parseEpub(archive);

    expect(parsed.navHref).toBeUndefined();
    expect(parsed.ncxHref).toBe("OEBPS/toc.ncx");

    const toc = buildToc(archive, parsed);
    expect(toc).toEqual([
      { title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] },
      { title: "Chapter 2", href: "OEBPS/text/chapter2.xhtml", children: [] },
    ]);
  });

  it("builds a table of contents from an EPUB3 nav document", () => {
    const archive = openEpubArchive(validEpub());
    const parsed = parseEpub(archive);
    const toc = buildToc(archive, parsed);

    expect(toc).toEqual([
      { title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml", children: [] },
      { title: "Chapter 2", href: "OEBPS/text/chapter2.xhtml", children: [] },
    ]);
  });

  // Issue 4: a fragment names a location *within* a document, not a different resource -
  // the TOC's href must still resolve to a real `ProcessedResource.href` (with the
  // fragment re-attached for display), not a path that matches nothing.
  it("resolves a fragment-bearing TOC href to its target document, keeping the fragment for display", () => {
    const archive = openEpubArchive(validEpubWithTocFragments());
    const parsed = parseEpub(archive);
    const toc = buildToc(archive, parsed);

    expect(toc).toEqual([
      { title: "Chapter 1", href: "OEBPS/text/chapter1.xhtml#top", children: [] },
      { title: "Chapter 2", href: "OEBPS/text/chapter2.xhtml#sec1", children: [] },
    ]);
  });

  // Ruling AF: parsing with entities disabled is the XXE/billion-laughs defence, proved
  // here rather than only configured - a package document that defines a custom DOCTYPE
  // entity and references it from <dc:title> must come back with the literal, unexpanded
  // entity reference, never the substituted text.
  it("does not expand a DOCTYPE-defined entity referenced from package metadata", () => {
    const parsed = parseEpub(openEpubArchive(epubWithEntityExpansion()));

    expect(parsed.metadata.title).toBe("&injected;");
    expect(parsed.metadata.title).not.toContain("EXPANDED-BY-PARSER");
  });
});
