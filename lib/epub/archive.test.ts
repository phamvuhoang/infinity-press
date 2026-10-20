import { describe, expect, it } from "vitest";

import {
  epubMissingContainer,
  epubWithAbsolutePath,
  epubWithDuplicateNormalizedPath,
  epubWithExtremeCompressionRatio,
  epubWithOversizedTotal,
  epubWithPathTraversal,
  epubWithTooManyEntries,
  validEpub,
  validEpubEntries,
  assembleEpub,
} from "@/scripts/fixtures/create-test-epub";
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  dirnameOf,
  externalUrlScheme,
  hasUnsafeReferenceCharacters,
  normalizeArchiveEntryPath,
  openEpubArchive,
  resolveInPublicationReference,
  splitFragment,
} from "@/lib/epub/archive";
import { EPUB_MIME_TYPE } from "@/lib/epub/constants";

describe("openEpubArchive", () => {
  it("opens a valid archive and exposes its entries by normalized path", () => {
    const archive = openEpubArchive(validEpub());

    expect(archive.entries.get("mimetype")).toBeDefined();
    expect(archive.entries.get("META-INF/container.xml")).toBeDefined();
    expect(archive.entries.get("OEBPS/content.opf")).toBeDefined();
  });

  it("rejects an archive missing the mimetype entry", () => {
    const bytes = assembleEpub(validEpubEntries().filter((entry) => entry.path !== "mimetype"));
    expect(() => openEpubArchive(bytes)).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects an archive whose mimetype entry is compressed", () => {
    const entries = validEpubEntries().map((entry) => (entry.path === "mimetype" ? { ...entry, store: false } : entry));
    expect(() => openEpubArchive(assembleEpub(entries))).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects an archive whose mimetype entry is not first", () => {
    const entries = validEpubEntries();
    const [mimetype, ...rest] = entries;
    const reordered = [rest[0], mimetype, ...rest.slice(1)];
    expect(() => openEpubArchive(assembleEpub(reordered))).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects an archive whose mimetype content is wrong", () => {
    const entries = validEpubEntries().map((entry) => (entry.path === "mimetype" ? { ...entry, content: "text/plain" } : entry));
    expect(() => openEpubArchive(assembleEpub(entries))).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects a path-traversal entry (INVALID_EPUB)", () => {
    expect(() => openEpubArchive(epubWithPathTraversal())).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects an absolute-path entry", () => {
    expect(() => openEpubArchive(epubWithAbsolutePath())).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects two entries that decode to the same normalized path", () => {
    expect(() => openEpubArchive(epubWithDuplicateNormalizedPath())).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects an archive with more than the maximum number of entries (ASSET_TOO_LARGE)", () => {
    expect(() => openEpubArchive(epubWithTooManyEntries(MAX_ARCHIVE_ENTRIES))).toThrow(
      expect.objectContaining({ code: "ASSET_TOO_LARGE" }),
    );
  });

  // Ruling AF: this must reject using the zip central directory's *declared* sizes,
  // before any full decompression happens - proven here by using a size well beyond what
  // this test process could plausibly hold if it were actually inflated (fflate would
  // have to materialize a >100 MiB buffer for this one entry alone to violate the limit
  // "after the fact"; the assertion completing quickly is itself evidence that never
  // happened).
  //
  // The fixture itself is genuinely CPU-bound, not flaky: building it deflates a ~100 MiB
  // buffer synchronously (fast on an idle machine, ~1.3s), and that is real work, not a
  // race - so under CPU contention it scales with load rather than settling on its own.
  // Confirmed by direct reproduction: 4 copies run concurrently under load average ~27-60
  // all hit vitest's default 5000ms test timeout. The explicit timeout below gives this one
  // test the room that work needs without masking an actual bug (the assertion above still
  // fails immediately if the code stops rejecting the oversized total).
  it(
    "rejects an archive whose declared uncompressed total exceeds the budget (ASSET_TOO_LARGE)",
    () => {
      expect(() => openEpubArchive(epubWithOversizedTotal(MAX_TOTAL_UNCOMPRESSED_BYTES))).toThrow(
        expect.objectContaining({ code: "ASSET_TOO_LARGE" }),
      );
    },
    20_000,
  );

  it("rejects an archive entry whose compression ratio exceeds the maximum, while staying within the total size budget", () => {
    // 8 MiB of zero bytes compresses to a few KB - comfortably past the 100:1 ratio limit
    // while the archive's total declared size stays far under the 100 MiB total budget,
    // isolating the ratio check from the total-size check above.
    expect(() => openEpubArchive(epubWithExtremeCompressionRatio(8 * 1024 * 1024))).toThrow(
      expect.objectContaining({ code: "ASSET_TOO_LARGE" }),
    );
  });

  // Step 5 requires container XML - this guard (archive.ts's final check before
  // returning) had no test at all until now.
  it("rejects an archive missing META-INF/container.xml", () => {
    expect(() => openEpubArchive(epubMissingContainer())).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects a completely empty archive", () => {
    expect(() => openEpubArchive(assembleEpub([]))).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });
});

describe("normalizeArchiveEntryPath", () => {
  it("passes through an ordinary relative path unchanged", () => {
    expect(normalizeArchiveEntryPath("OEBPS/text/chapter1.xhtml")).toBe("OEBPS/text/chapter1.xhtml");
  });

  it("collapses '.' segments and duplicate slashes", () => {
    expect(normalizeArchiveEntryPath("OEBPS/./text//chapter1.xhtml")).toBe("OEBPS/text/chapter1.xhtml");
  });

  it("rejects an absolute path", () => {
    expect(() => normalizeArchiveEntryPath("/etc/passwd")).toThrow(expect.objectContaining({ code: "INVALID_EPUB" }));
  });

  it("rejects a raw '..' segment", () => {
    expect(() => normalizeArchiveEntryPath("OEBPS/../../etc/passwd")).toThrow(
      expect.objectContaining({ code: "INVALID_EPUB" }),
    );
  });

  it("rejects a percent-encoded '..' segment identically to a raw one", () => {
    expect(() => normalizeArchiveEntryPath("OEBPS/%2e%2e/evil.txt")).toThrow(
      expect.objectContaining({ code: "INVALID_EPUB" }),
    );
  });
});

describe("resolveInPublicationReference", () => {
  it("resolves a sibling-directory reference relative to the base directory", () => {
    expect(resolveInPublicationReference("OEBPS/text", "../images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
  });

  it("resolves a same-directory reference", () => {
    expect(resolveInPublicationReference("OEBPS/text", "chapter2.xhtml")).toBe("OEBPS/text/chapter2.xhtml");
  });

  it("returns null for a reference that escapes the archive root", () => {
    expect(resolveInPublicationReference("OEBPS", "../../etc/passwd")).toBeNull();
  });

  it("returns null for a percent-encoded escape identically to a raw one", () => {
    expect(resolveInPublicationReference("OEBPS", "%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  it("returns null for a scheme-qualified reference", () => {
    expect(resolveInPublicationReference("OEBPS/text", "https://example.com/x")).toBeNull();
  });

  // Issue 4: NCX `content src` and EPUB3 nav `a href` routinely carry a fragment
  // (pointing within the target document, not naming a different resource) - resolution
  // must discard it, or the result matches no `ProcessedResource.href`.
  it("resolves the path portion of a fragment-bearing reference, discarding the fragment", () => {
    expect(resolveInPublicationReference("OEBPS/text", "chapter2.xhtml#sec1")).toBe("OEBPS/text/chapter2.xhtml");
  });

  it("returns null for a reference containing a control character", () => {
    expect(resolveInPublicationReference("OEBPS/text", "java\tscript:alert(1)")).toBeNull();
  });
});

describe("splitFragment", () => {
  it("splits a path with a fragment", () => {
    expect(splitFragment("chapter2.xhtml#sec1")).toEqual({ path: "chapter2.xhtml", fragment: "#sec1" });
  });

  it("returns an empty fragment for a path with none", () => {
    expect(splitFragment("chapter2.xhtml")).toEqual({ path: "chapter2.xhtml", fragment: "" });
  });
});

describe("hasUnsafeReferenceCharacters", () => {
  it("is false for an ordinary reference", () => {
    expect(hasUnsafeReferenceCharacters("chapter1.xhtml")).toBe(false);
  });

  it("is true for a reference containing a tab", () => {
    // The classic browser-normalization bypass: a browser strips the tab before
    // classifying the scheme, so this is `javascript:alert(1)` to a browser even though
    // it defeats a naive scheme regex.
    expect(hasUnsafeReferenceCharacters("java\tscript:alert(1)")).toBe(true);
  });

  it("is true for a reference containing a newline or a space", () => {
    expect(hasUnsafeReferenceCharacters("java\nscript:alert(1)")).toBe(true);
    expect(hasUnsafeReferenceCharacters("java script:alert(1)")).toBe(true);
  });
});

describe("externalUrlScheme", () => {
  it("returns null for a relative reference", () => {
    expect(externalUrlScheme("chapter1.xhtml")).toBeNull();
  });

  it("detects a scheme", () => {
    expect(externalUrlScheme("https://example.com")).toBe("https");
    expect(externalUrlScheme("javascript:alert(1)")).toBe("javascript");
    expect(externalUrlScheme("data:image/png;base64,AAAA")).toBe("data");
  });

  it("detects a protocol-relative reference", () => {
    expect(externalUrlScheme("//example.com/x")).toBe("//");
  });
});

describe("dirnameOf", () => {
  it("returns the directory portion of a nested path", () => {
    expect(dirnameOf("OEBPS/text/chapter1.xhtml")).toBe("OEBPS/text");
  });

  it("returns an empty string for a top-level path", () => {
    expect(dirnameOf("mimetype")).toBe("");
  });
});

describe("EPUB_MIME_TYPE fixture sanity", () => {
  it("matches the constant the archive validator checks against", () => {
    expect(EPUB_MIME_TYPE).toBe("application/epub+zip");
  });
});
