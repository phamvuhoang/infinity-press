import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  epubWithChapter1LinkingToChapter2,
  epubWithDisallowedDataUrl,
  epubWithExternalUrl,
  epubWithJavascriptUrl,
  epubWithPathTraversal,
  epubWithProtocolRelativeUrl,
  epubWithUnsafeCss,
  epubWithUnsafeScript,
  validEpub,
  validEpubWithFont,
} from "@/scripts/fixtures/create-test-epub";
import {
  DEFAULT_ALLOWED_DATA_URL_MEDIA_TYPES,
  DEFAULT_ALLOWED_MEDIA_TYPES,
  DEFAULT_PROCESSING_POLICY,
  decodeText,
  processEpub,
  type ProcessingPolicy,
} from "@/lib/epub/process";

const policy = DEFAULT_PROCESSING_POLICY;

describe("processEpub", () => {
  // The brief's exact required assertions (task-4-brief.md Step 3).
  it("rejects a path-traversal archive with INVALID_EPUB", async () => {
    await expect(processEpub(epubWithPathTraversal(), policy)).rejects.toMatchObject({ code: "INVALID_EPUB" });
  });

  it("sanitizes a document containing a <script> tag", async () => {
    const sanitized = await processEpub(epubWithUnsafeScript(), policy);
    expect(sanitized.resources.some((resource) => resource.text?.includes("<script"))).toBe(false);
  });

  it("rejects a document referencing an external https:// URL with UNSAFE_EXTERNAL_URL", async () => {
    await expect(processEpub(epubWithExternalUrl(), policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });

  // Minor 8: these fixtures existed but were never exercised end-to-end through
  // processEpub (only at the sanitizeXhtml unit level).
  it("rejects a document referencing a protocol-relative URL end-to-end", async () => {
    await expect(processEpub(epubWithProtocolRelativeUrl(), policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });

  it("rejects a document using a javascript: URL end-to-end", async () => {
    await expect(processEpub(epubWithJavascriptUrl(), policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });

  it("rejects a document embedding a non-allowlisted data: URL end-to-end", async () => {
    await expect(processEpub(epubWithDisallowedDataUrl(), policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });

  // Ruling AZ: a stylesheet's external url()/@import is rejected the same way an unsafe
  // XHTML reference is - CSS is stored unmodified when safe, never unsanitized when not.
  it("rejects a publication whose stylesheet references an external URL end-to-end", async () => {
    await expect(processEpub(epubWithUnsafeCss(), policy)).rejects.toMatchObject({ code: "UNSAFE_EXTERNAL_URL" });
  });

  it("excludes image/svg+xml from the default allowlists (named supported-profile exclusion)", () => {
    expect(DEFAULT_ALLOWED_MEDIA_TYPES.has("image/svg+xml")).toBe(false);
    expect(DEFAULT_ALLOWED_DATA_URL_MEDIA_TYPES.has("image/svg+xml")).toBe(false);
  });

  it("returns metadata, reading order, resources, toc, and sampleHrefs for a valid publication", async () => {
    const result = await processEpub(validEpub(), policy);

    expect(result.metadata.title).toBe("Test Publication");
    expect(result.readingOrder).toHaveLength(2);
    expect(result.resources).toHaveLength(5);
    expect(result.toc).toHaveLength(2);
    expect(result.sampleHrefs).toEqual([]);
  });

  it("derives search chunks and positions only after XHTML has been sanitized and assembled", async () => {
    const result = await processEpub(validEpub(), policy);

    expect(result.searchChunks.length).toBeGreaterThan(0);
    expect(result.positions.length).toBeGreaterThan(0);
    expect(result.searchChunks.every((chunk) => chunk.href.startsWith("OEBPS/text/"))).toBe(true);
    expect(result.searchChunks.map((chunk) => chunk.plainText).join(" ")).not.toContain("alert(");
  });

  it("sorts resources by normalized href", async () => {
    const result = await processEpub(validEpub(), policy);
    const hrefs = result.resources.map((resource) => resource.href);
    expect(hrefs).toEqual([...hrefs].sort());
  });

  it("hashes every resource's actual output bytes with SHA-256", async () => {
    const result = await processEpub(validEpub(), policy);

    for (const resource of result.resources) {
      expect(resource.sha256).toBe(createHash("sha256").update(resource.bytes).digest("hex"));
      expect(resource.byteSize).toBe(resource.bytes.byteLength);
    }
  });

  it("populates .text only for XHTML resources, leaving CSS/NCX decodable on demand via decodeText()", async () => {
    const result = await processEpub(validEpub(), policy);

    const chapter = result.resources.find((resource) => resource.href === "OEBPS/text/chapter1.xhtml")!;
    const stylesheet = result.resources.find((resource) => resource.href === "OEBPS/styles/style.css")!;

    expect(chapter.text).toBeDefined();
    expect(stylesheet.text).toBeUndefined();
    expect(decodeText(stylesheet)).toContain("font-family");
  });

  it("rejects a manifest resource whose declared media type is not allowlisted (UNSUPPORTED_MEDIA)", async () => {
    const restrictedPolicy: ProcessingPolicy = {
      ...policy,
      allowedMediaTypes: new Set([...policy.allowedMediaTypes].filter((mediaType) => mediaType !== "image/jpeg")),
    };

    await expect(processEpub(validEpub(), restrictedPolicy)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });
  });

  // Carry-forward: sampleHrefs must be derived from resources, not built independently -
  // an href the policy names that does not correspond to any real resource is silently
  // ignored, and every href that does end up in sampleHrefs must belong to a resource
  // whose own accessClass agrees.
  describe("sampleHrefs derivation", () => {
    it("derives sampleHrefs from resources' own accessClass, ignoring unknown candidate hrefs", async () => {
      const samplePolicy: ProcessingPolicy = {
        ...policy,
        sampleHrefs: new Set(["OEBPS/text/chapter1.xhtml", "OEBPS/does-not-exist.xhtml"]),
      };

      const result = await processEpub(validEpub(), samplePolicy);

      // Ruling AW: the sample set is the *closure* of the candidate hrefs, so chapter1's
      // own stylesheet and cover image ride along with it - see "sampleHrefs transitive
      // closure" below for the dedicated tests.
      expect(result.sampleHrefs.slice().sort()).toEqual(
        ["OEBPS/images/cover.jpg", "OEBPS/styles/style.css", "OEBPS/text/chapter1.xhtml"].sort(),
      );

      const byHref = new Map(result.resources.map((resource) => [resource.href, resource]));
      for (const href of result.sampleHrefs) {
        expect(byHref.get(href)?.accessClass).toBe("sample");
      }
      for (const resource of result.resources) {
        if (resource.accessClass === "paid") {
          expect(result.sampleHrefs).not.toContain(resource.href);
        }
      }
    });
  });

  // Ruling AW: Task 8's sample route serves only allowlisted hrefs, so a sample chapter's
  // supporting assets (CSS, images, fonts) must be in `sampleHrefs` too, or the sample
  // renders unstyled and imageless - but the closure must never let a sample document's
  // ordinary navigation link promote another (paid) content document into the sample set.
  describe("sampleHrefs transitive closure", () => {
    it("includes a sample chapter's referenced stylesheet and image", async () => {
      const samplePolicy: ProcessingPolicy = { ...policy, sampleHrefs: new Set(["OEBPS/text/chapter1.xhtml"]) };

      const result = await processEpub(validEpub(), samplePolicy);

      expect(result.sampleHrefs).toEqual(
        expect.arrayContaining(["OEBPS/text/chapter1.xhtml", "OEBPS/styles/style.css", "OEBPS/images/cover.jpg"]),
      );
    });

    it("excludes a resource that is referenced only by a paid chapter", async () => {
      // chapter2 (the fixture's other chapter) does not reference the cover image -
      // only chapter1 does.
      const samplePolicy: ProcessingPolicy = { ...policy, sampleHrefs: new Set(["OEBPS/text/chapter2.xhtml"]) };

      const result = await processEpub(validEpub(), samplePolicy);

      expect(result.sampleHrefs).not.toContain("OEBPS/images/cover.jpg");
      const cover = result.resources.find((resource) => resource.href === "OEBPS/images/cover.jpg")!;
      expect(cover.accessClass).toBe("paid");
    });

    it("includes a resource referenced by both a sample and a paid chapter (shared resource: sample wins)", async () => {
      // The fixture's stylesheet is linked from both chapter1 and chapter2.
      const samplePolicy: ProcessingPolicy = { ...policy, sampleHrefs: new Set(["OEBPS/text/chapter1.xhtml"]) };

      const result = await processEpub(validEpub(), samplePolicy);

      const stylesheet = result.resources.find((resource) => resource.href === "OEBPS/styles/style.css")!;
      expect(stylesheet.accessClass).toBe("sample");
      expect(result.sampleHrefs).toContain("OEBPS/styles/style.css");
    });

    it("does not promote a paid chapter reached only via a sample chapter's navigation link", async () => {
      const samplePolicy: ProcessingPolicy = { ...policy, sampleHrefs: new Set(["OEBPS/text/chapter1.xhtml"]) };

      const result = await processEpub(epubWithChapter1LinkingToChapter2(), samplePolicy);

      expect(result.sampleHrefs).not.toContain("OEBPS/text/chapter2.xhtml");
      const chapter2 = result.resources.find((resource) => resource.href === "OEBPS/text/chapter2.xhtml")!;
      expect(chapter2.accessClass).toBe("paid");

      // The chapter's actual asset references still propagate even though it also
      // contains a navigation link.
      expect(result.sampleHrefs).toEqual(
        expect.arrayContaining(["OEBPS/styles/style.css", "OEBPS/images/cover.jpg"]),
      );
    });

    // Issue 3: fonts are declared via CSS `@font-face`, essentially the only way EPUB
    // ever references one - the closure must reach through a sample chapter's stylesheet
    // to its font, not stop at the stylesheet itself.
    it("reaches a font declared via @font-face in a sample chapter's stylesheet", async () => {
      const samplePolicy: ProcessingPolicy = { ...policy, sampleHrefs: new Set(["OEBPS/text/chapter1.xhtml"]) };

      const result = await processEpub(validEpubWithFont(), samplePolicy);

      expect(result.sampleHrefs).toContain("OEBPS/fonts/body.woff2");
      const font = result.resources.find((resource) => resource.href === "OEBPS/fonts/body.woff2")!;
      expect(font.accessClass).toBe("sample");
    });
  });

  // Determinism is a property, not a one-shot assertion: run twice on identical input and
  // policy and compare the whole result, including hashes.
  describe("determinism", () => {
    it("produces an identical result for the same bytes and policy across two runs", async () => {
      const bytes = validEpub();
      const first = await processEpub(bytes, policy);
      const second = await processEpub(bytes, policy);

      expect(JSON.stringify(first, jsonReplacer)).toBe(JSON.stringify(second, jsonReplacer));
      expect(first.resources.map((r) => r.sha256)).toEqual(second.resources.map((r) => r.sha256));
    });
  });
});

// `Uint8Array` doesn't JSON.stringify informatively by default; render it as an array so
// the determinism comparison covers resource bytes too, not just their hashes.
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}
