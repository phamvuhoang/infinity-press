import { describe, expect, it } from "vitest";

import { chunkLocator, parseAnchor } from "@/lib/reader/anchor";

describe("parseAnchor", () => {
  it.each([
    ["12", 12],
    ["0", 0],
    ["1000000", 1_000_000],
    ["1000001", null],
    ["-1", null],
    ["1.5", null],
    ["", null],
    [" 3", null],
    ["1e3", null],
    [["1", "2"], null],
    [undefined, null],
  ] as const)("%j -> %j", (value, expected) => {
    expect(parseAnchor(value as string | string[] | undefined)).toBe(expected);
  });
});

describe("chunkLocator", () => {
  const stored = { href: "OEBPS/c1.xhtml", progression: 0.5, totalProgression: 0.2, locations: { position: 3 }, text: { highlight: "x" } };

  it("rewrites the in-publication href", () => {
    expect(chunkLocator(stored, (href) => `/r/${href}`)).toEqual({ ...stored, href: "/r/OEBPS/c1.xhtml" });
  });

  it("is null for a missing, malformed or unconvertible locator", () => {
    expect(chunkLocator(null, (href) => href)).toBeNull();
    expect(chunkLocator({ ...stored, progression: 2 }, (href) => href)).toBeNull();
    expect(
      chunkLocator(stored, () => {
        throw new Error("bad href");
      }),
    ).toBeNull();
  });
});
