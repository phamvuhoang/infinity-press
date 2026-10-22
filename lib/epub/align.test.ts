import { describe, expect, it } from "vitest";

import { alignChunks, type AlignChunk } from "@/lib/epub/align";

// `side` prefixes ids so a pair says which chunk it took; ordinals run on across groups.
function chunks(side: string, groups: Array<[href: string, count: number, length?: number]>): AlignChunk[] {
  const out: AlignChunk[] = [];
  for (const [href, count, length = 100] of groups) {
    for (let index = 0; index < count; index += 1) {
      out.push({ id: `${side}-${href}-${index}`, href, ordinal: out.length, length });
    }
  }
  return out;
}

describe("alignChunks", () => {
  it("pairs equal counts one to one with confidence 1", () => {
    const result = alignChunks(chunks("s", [["a", 3], ["b", 2]]), chunks("t", [["x", 3], ["y", 2]]));
    expect(result.coverage).toBe(1);
    expect(result.pairs).toEqual([
      { sourceId: "s-a-0", targetId: "t-x-0", confidence: 1 },
      { sourceId: "s-a-1", targetId: "t-x-1", confidence: 1 },
      { sourceId: "s-a-2", targetId: "t-x-2", confidence: 1 },
      { sourceId: "s-b-0", targetId: "t-y-0", confidence: 1 },
      { sourceId: "s-b-1", targetId: "t-y-1", confidence: 1 },
    ]);
  });

  it("pairs every source chunk by nearest midpoint at confidence 0.6 when counts differ by at most 10%", () => {
    const result = alignChunks(chunks("s", [["a", 10]]), chunks("t", [["x", 11]]));
    expect(result.coverage).toBe(1);
    expect(result.pairs).toHaveLength(10);
    expect(result.pairs.every((pair) => pair.confidence === 0.6)).toBe(true);
    expect(result.pairs[0]).toEqual({ sourceId: "s-a-0", targetId: "t-x-0", confidence: 0.6 });
    expect(result.pairs[9]).toEqual({ sourceId: "s-a-9", targetId: "t-x-10", confidence: 0.6 });
  });

  it("skips a group whose counts differ by more than 10%", () => {
    expect(alignChunks(chunks("s", [["a", 10]]), chunks("t", [["x", 15]]))).toEqual({ pairs: [], coverage: 0 });
  });

  it("pairs only the first groups when the sides have different numbers of hrefs", () => {
    const result = alignChunks(chunks("s", [["a", 2], ["b", 2], ["c", 4]]), chunks("t", [["x", 2], ["y", 2]]));
    expect(result.pairs.map((pair) => pair.sourceId)).toEqual(["s-a-0", "s-a-1", "s-b-0", "s-b-1"]);
    expect(result.pairs.map((pair) => pair.targetId)).toEqual(["t-x-0", "t-x-1", "t-y-0", "t-y-1"]);
    expect(result.coverage).toBe(0.5);
  });

  it("skips a group with no target chunks without throwing", () => {
    expect(alignChunks(chunks("s", [["a", 3]]), [])).toEqual({ pairs: [], coverage: 0 });
    expect(alignChunks([], chunks("t", [["x", 3]]))).toEqual({ pairs: [], coverage: 0 });
  });

  it("is deterministic", () => {
    const source = chunks("s", [["a", 10, 40], ["b", 7]]);
    const target = chunks("t", [["x", 11, 90], ["y", 7]]);
    expect(alignChunks(source, target)).toEqual(alignChunks(source, target));
  });
});
