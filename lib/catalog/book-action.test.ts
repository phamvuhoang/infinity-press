import { describe, expect, it } from "vitest";

import { type BookActionInput, type BundleActionInput, resolveBookAction } from "@/lib/catalog/book-action";

const base: BookActionInput = {
  hasActiveEntitlement: false,
  offer: { priceMinor: 0, active: true },
  hasActivePublication: true,
  paymentsEnabled: true,
};

describe("resolveBookAction", () => {
  it.each([
    ["an entitled reader reads", { hasActiveEntitlement: true }, "read"],
    ["an entitled reader reads even without an offer", { hasActiveEntitlement: true, offer: null }, "read"],
    ["no publication is unavailable, even when entitled", { hasActiveEntitlement: true, hasActivePublication: false }, "unavailable"],
    ["no offer is unavailable", { offer: null }, "unavailable"],
    ["an inactive offer is unavailable", { offer: { priceMinor: 0, active: false } }, "unavailable"],
    ["a free offer is get_free", {}, "get_free"],
    ["a paid offer with payments is buy", { offer: { priceMinor: 129000, active: true } }, "buy"],
    ["a paid offer without payments is coming_soon", { offer: { priceMinor: 129000, active: true }, paymentsEnabled: false }, "coming_soon"],
    ["a free offer ignores disabled payments", { paymentsEnabled: false }, "get_free"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveBookAction({ ...base, ...overrides })).toBe(expected);
  });
});

// A bundle has no publication and no free path: it is a curated set of books at one fixed price,
// so the only questions are whether there is anything left to show, anything left to gain, and a
// live price to pay.
const bundle: BundleActionInput = {
  kind: "bundle",
  publishedMemberCount: 3,
  ownedMemberCount: 0,
  offer: { priceMinor: 199000, active: true },
  paymentsEnabled: true,
};

describe("resolveBookAction for a bundle", () => {
  it.each([
    ["a live paid offer with payments is buy", {}, "buy"],
    ["a live paid offer without payments is coming_soon", { paymentsEnabled: false }, "coming_soon"],
    ["no offer is unavailable", { offer: null }, "unavailable"],
    ["an inactive offer is unavailable", { offer: { priceMinor: 199000, active: false } }, "unavailable"],
    ["a free bundle is unavailable - bundles are never given away", { offer: { priceMinor: 0, active: true } }, "unavailable"],
    ["every visible member owned is owned_bundle", { ownedMemberCount: 3 }, "owned_bundle"],
    ["ownership outranks a missing offer", { ownedMemberCount: 3, offer: null }, "owned_bundle"],
    ["no visible member is unavailable, however many the reader owns", { publishedMemberCount: 0, ownedMemberCount: 0 }, "unavailable"],
    // The bundle price is never prorated, so partial ownership changes the copy the page shows
    // (from the owned count) and never the action.
    ["partial ownership still buys", { ownedMemberCount: 2 }, "buy"],
    ["partial ownership without payments is still coming_soon", { ownedMemberCount: 2, paymentsEnabled: false }, "coming_soon"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(resolveBookAction({ ...bundle, ...overrides })).toBe(expected);
  });

  it("leaves the book variant untouched", () => {
    expect(resolveBookAction(base)).toBe("get_free");
  });
});
