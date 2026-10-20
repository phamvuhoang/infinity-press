import { describe, expect, it } from "vitest";

import { toPublicationResourceHref, toReaderResourceHref } from "@/lib/reader/locator-paths";

const publicationId = "c0000000-0000-4000-8000-000000000001";

describe("reader locator href conversion", () => {
  it("round-trips a normalized publication href through the protected reader URL", () => {
    const href = "OEBPS/text/chương.xhtml";
    const readerHref = toReaderResourceHref(publicationId, href);

    expect(readerHref).toBe(
      `/api/reader/publications/${publicationId}/resources/OEBPS/text/ch%C6%B0%C6%A1ng.xhtml`,
    );
    expect(toPublicationResourceHref(publicationId, readerHref)).toBe(href);
  });

  it.each([
    ["external URL", "https://example.test/chapter.xhtml"],
    ["external scheme", "data:text/plain,chapter"],
    ["absolute path", "/OEBPS/chapter.xhtml"],
    ["traversal", "OEBPS/../secret.xhtml"],
    ["backslash", "OEBPS\\secret.xhtml"],
    ["query", "OEBPS/chapter.xhtml?download=1"],
    ["fragment", "OEBPS/chapter.xhtml#part"],
  ])("rejects an %s in-publication href", (_name, href) => {
    expect(() => toReaderResourceHref(publicationId, href)).toThrow();
  });

  it("rejects a protected URL for another publication", () => {
    expect(() =>
      toPublicationResourceHref(
        publicationId,
        "/api/reader/publications/c0000000-0000-4000-8000-000000000002/resources/OEBPS/chapter.xhtml",
      ),
    ).toThrow();
  });

  it("rejects malformed encoding, encoded traversal, and double-encoded traversal", () => {
    expect(() =>
      toPublicationResourceHref(
        publicationId,
        `/api/reader/publications/${publicationId}/resources/OEBPS/%E0%A4%A.xhtml`,
      ),
    ).toThrow();
    expect(() =>
      toPublicationResourceHref(
        publicationId,
        `/api/reader/publications/${publicationId}/resources/OEBPS/%2e%2e/secret.xhtml`,
      ),
    ).toThrow();
    expect(() =>
      toPublicationResourceHref(
        publicationId,
        `/api/reader/publications/${publicationId}/resources/OEBPS/%252e%252e/secret.xhtml`,
      ),
    ).toThrow();
  });
});
