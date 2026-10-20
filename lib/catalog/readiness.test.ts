import { describe, expect, it } from "vitest";

import {
  checkBookReadiness,
  readinessIssueCodes,
  parsePublicationReadinessError,
  parseReadinessError,
  readinessIssueMessage,
  readinessIssueSection,
  type BookReadinessSnapshot,
} from "@/lib/catalog/readiness";

const ready: BookReadinessSnapshot = {
  localizations: [{ title: "Quan sát tỉnh biết", slug: "quan-sat-tinh-biet", description: "Một cuốn sách." }],
  hasAuthor: true,
  hasCover: true,
  hasPublishedEdition: true,
};

describe("checkBookReadiness", () => {
  it("returns no issues for a complete book", () => {
    expect(checkBookReadiness(ready)).toEqual([]);
  });

  it("requires a localization with title, slug, and a non-blank description", () => {
    expect(checkBookReadiness({ ...ready, localizations: [] })).toEqual(["missing_localization"]);
    expect(
      checkBookReadiness({ ...ready, localizations: [{ title: "T", slug: "t", description: "   " }] }),
    ).toEqual(["missing_localization"]);
  });

  it("accepts a book when any one locale is complete", () => {
    expect(
      checkBookReadiness({
        ...ready,
        localizations: [
          { title: "T", slug: "t", description: null },
          { title: "U", slug: "u", description: "Done" },
        ],
      }),
    ).toEqual([]);
  });

  it("lists every missing piece in the same order the database reports them", () => {
    expect(
      checkBookReadiness({
        localizations: [],
        hasAuthor: false,
        hasCover: false,
        hasPublishedEdition: false,
      }),
    ).toEqual(["missing_localization", "missing_author", "missing_cover", "missing_publication"]);
  });

  it("never asks for an offer: an edition without one is browsable, just not for sale", () => {
    expect(readinessIssueCodes).not.toContain("missing_offer");
  });

  it("maps every issue to an editor section and a message", () => {
    for (const code of checkBookReadiness({ ...ready, localizations: [], hasAuthor: false, hasCover: false, hasPublishedEdition: false })) {
      expect(readinessIssueSection[code]).toBeTruthy();
      expect(readinessIssueMessage[code]).toBeTruthy();
    }
  });
});

describe("parseReadinessError", () => {
  it("reads the codes out of publish_book's EB010 message", () => {
    expect(parseReadinessError("publish_book: book is not ready: missing_cover,missing_publication")).toEqual([
      "missing_cover",
      "missing_publication",
    ]);
  });

  it("ignores unknown codes and unrelated messages", () => {
    expect(parseReadinessError("publish_book: book is not ready: missing_cover,drop_table")).toEqual(["missing_cover"]);
    expect(parseReadinessError("something else")).toBeNull();
  });
});

describe("parsePublicationReadinessError", () => {
  it("reads the codes out of publish_publication's EB012 message", () => {
    expect(
      parsePublicationReadinessError("publish_publication: publication is not ready: epub_language_mismatch"),
    ).toEqual(["epub_language_mismatch"]);
  });

  it("drops unknown codes and ignores other messages", () => {
    expect(parsePublicationReadinessError("publication is not ready: epub_language_unverified,x")).toEqual([
      "epub_language_unverified",
    ]);
    expect(parsePublicationReadinessError("nope")).toBeNull();
  });
});
