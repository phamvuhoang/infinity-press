import { describe, expect, it } from "vitest";

import {
  decidePublicationTransition,
  deriveLifecycleState,
  type PublicationLifecycleState,
} from "@/lib/publishing/state";

const allStates: PublicationLifecycleState[] = [
  "queued",
  "processing",
  "failed",
  "ready_for_preview",
  "published",
  "rejected",
  "superseded",
];

describe("decidePublicationTransition", () => {
  describe("publish", () => {
    it("accepts only ready_for_preview -> published", () => {
      expect(decidePublicationTransition("ready_for_preview", "publish")).toEqual({
        allowed: true,
        next: "published",
      });
    });

    it.each(allStates.filter((state) => state !== "ready_for_preview"))(
      "rejects publishing a %s publication",
      (state) => {
        const decision = decidePublicationTransition(state, "publish");
        expect(decision.allowed).toBe(false);
      },
    );

    // The brief's own wording: a queued or still-processing target has no publication yet at
    // all, and a failed run must not be publishable either - both are non-negotiable, not just
    // "any other state is rejected" incidentally.
    it.each(["queued", "processing", "failed"] as const)(
      "explicitly rejects publishing while %s",
      (state) => {
        const decision = decidePublicationTransition(state, "publish");
        expect(decision).toEqual({ allowed: false, reason: expect.any(String) });
      },
    );
  });

  describe("reject", () => {
    it("accepts only ready_for_preview -> rejected", () => {
      expect(decidePublicationTransition("ready_for_preview", "reject")).toEqual({
        allowed: true,
        next: "rejected",
      });
    });

    it.each(allStates.filter((state) => state !== "ready_for_preview"))(
      "rejects rejecting a %s publication",
      (state) => {
        const decision = decidePublicationTransition(state, "reject");
        expect(decision.allowed).toBe(false);
      },
    );
  });

  describe("supersede", () => {
    // Publishing a new version supersedes the previously active one: only a currently published
    // publication is eligible to become superseded.
    it("accepts only published -> superseded", () => {
      expect(decidePublicationTransition("published", "supersede")).toEqual({
        allowed: true,
        next: "superseded",
      });
    });

    it.each(allStates.filter((state) => state !== "published"))(
      "rejects superseding a %s publication",
      (state) => {
        const decision = decidePublicationTransition(state, "supersede");
        expect(decision.allowed).toBe(false);
      },
    );
  });

  describe("reactivate", () => {
    // Rollback accepts only a previously published (now superseded) version.
    it("accepts only superseded -> published", () => {
      expect(decidePublicationTransition("superseded", "reactivate")).toEqual({
        allowed: true,
        next: "published",
      });
    });

    it.each(allStates.filter((state) => state !== "superseded"))(
      "rejects reactivating a %s publication",
      (state) => {
        const decision = decidePublicationTransition(state, "reactivate");
        expect(decision.allowed).toBe(false);
      },
    );

    it("rejects reactivating a ready_for_preview publication distinctly (never published in the first place)", () => {
      const decision = decidePublicationTransition("ready_for_preview", "reactivate");
      expect(decision).toEqual({ allowed: false, reason: expect.any(String) });
    });
  });
});

describe("deriveLifecycleState", () => {
  it("uses the publication status once a publication exists, even if the asset status lags behind", () => {
    expect(deriveLifecycleState("ready_for_preview", "published")).toBe("published");
    expect(deriveLifecycleState("ready_for_preview", "rejected")).toBe("rejected");
  });

  it.each([
    ["queued", "queued"],
    ["processing", "processing"],
    ["failed", "failed"],
  ] as const)("maps asset status %s to lifecycle %s when no publication exists yet", (assetStatus, expected) => {
    expect(deriveLifecycleState(assetStatus, null)).toBe(expected);
  });
});
