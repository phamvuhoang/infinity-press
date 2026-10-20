import { describe, expect, it } from "vitest";

import {
  bundleReadinessIssueCodes,
  bundleReadinessIssueMessage,
  bundleReadinessIssueSection,
  checkBundleReadiness,
  parseBundleReadinessError,
  type BundleReadinessSnapshot,
} from "@/lib/catalog/bundle-readiness";

const ready: BundleReadinessSnapshot = {
  members: [{ published: true }, { published: true }],
  localizations: [{ title: "Gói sách", slug: "goi-sach", description: "Hai cuốn sách." }],
  hasCover: true,
  hasActiveOffer: true,
};

describe("checkBundleReadiness", () => {
  it("returns no blocking issues and no warnings for a complete bundle", () => {
    expect(checkBundleReadiness(ready)).toEqual({ blocking: [], warnings: [] });
  });

  it("blocks a bundle with fewer than two published members", () => {
    expect(checkBundleReadiness({ ...ready, members: [{ published: true }] }).blocking).toEqual([
      "too_few_published_members",
    ]);
    expect(checkBundleReadiness({ ...ready, members: [] }).blocking).toEqual(["too_few_published_members"]);
    expect(
      checkBundleReadiness({ ...ready, members: [{ published: true }, { published: false }] }).blocking,
    ).toEqual(["too_few_published_members"]);
  });

  it("requires a localization with a title, a slug, and a non-blank description", () => {
    expect(checkBundleReadiness({ ...ready, localizations: [] }).blocking).toEqual(["missing_localization"]);
    expect(
      checkBundleReadiness({ ...ready, localizations: [{ title: "T", slug: "t", description: "   " }] }).blocking,
    ).toEqual(["missing_localization"]);
    expect(
      checkBundleReadiness({ ...ready, localizations: [{ title: " ", slug: "t", description: "Done" }] }).blocking,
    ).toEqual(["missing_localization"]);
  });

  it("accepts a bundle when any one locale is complete", () => {
    expect(
      checkBundleReadiness({
        ...ready,
        localizations: [
          { title: "T", slug: "t", description: null },
          { title: "U", slug: "u", description: "Done" },
        ],
      }).blocking,
    ).toEqual([]);
  });

  it("blocks a bundle without a cover or without an active offer", () => {
    expect(checkBundleReadiness({ ...ready, hasCover: false }).blocking).toEqual(["missing_cover"]);
    expect(checkBundleReadiness({ ...ready, hasActiveOffer: false }).blocking).toEqual(["missing_offer"]);
  });

  it("lists every blocking issue in the same order the database reports them", () => {
    expect(
      checkBundleReadiness({ members: [], localizations: [], hasCover: false, hasActiveOffer: false }).blocking,
    ).toEqual(["too_few_published_members", "missing_localization", "missing_cover", "missing_offer"]);
  });

  it("warns about an unpublished member without blocking publication", () => {
    const verdict = checkBundleReadiness({
      ...ready,
      members: [{ published: true }, { published: true }, { published: false }],
    });
    expect(verdict.blocking).toEqual([]);
    expect(verdict.warnings).toEqual(["unpublished_member"]);
  });

  it("warns at most once however many members are unpublished", () => {
    expect(
      checkBundleReadiness({
        ...ready,
        members: [{ published: true }, { published: true }, { published: false }, { published: false }],
      }).warnings,
    ).toEqual(["unpublished_member"]);
  });

  it("maps every issue code to an editor section and a message", () => {
    for (const code of bundleReadinessIssueCodes) {
      expect(bundleReadinessIssueSection[code]).toBeTruthy();
      expect(bundleReadinessIssueMessage[code]).toBeTruthy();
    }
  });
});

describe("parseBundleReadinessError", () => {
  it("reads the codes out of the message publish_bundle raises", () => {
    expect(parseBundleReadinessError("publish_bundle: bundle is not ready: missing_cover,missing_offer")).toEqual([
      "missing_cover",
      "missing_offer",
    ]);
  });

  it("ignores codes it does not know", () => {
    expect(parseBundleReadinessError("publish_bundle: bundle is not ready: missing_cover,missing_moon")).toEqual([
      "missing_cover",
    ]);
  });

  it("returns null for an unrelated message", () => {
    expect(parseBundleReadinessError("publish_bundle: caller is not an admin")).toBeNull();
  });

  it("does not mistake a book readiness error for a bundle one", () => {
    expect(parseBundleReadinessError("publish_book: book is not ready: missing_cover")).toBeNull();
  });
});
