import { describe, expect, it } from "vitest";

import { readerPageCount } from "@/lib/reader/layout";

describe("readerPageCount", () => {
  it.each([
    [390, 1],
    [768, 1],
    [1279, 1],
    [1280, 2],
    [1440, 2],
  ] as const)("uses one page below the desktop reader shell at %ipx", (width, expected) => {
    // Break if the compact reader asks the engine for a fake desktop spread.
    expect(readerPageCount(width)).toBe(expected);
  });

  it("respects an explicit one-page desktop choice", () => {
    // Break if the desktop setting is ignored after the breakpoint is crossed.
    expect(readerPageCount(1440, 1)).toBe(1);
  });
});
