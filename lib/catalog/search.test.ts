import { describe, expect, it } from "vitest";

import { groupSearchHits, normalizeSearchQuery } from "@/lib/catalog/search";

describe("normalizeSearchQuery", () => {
  it("trims and keeps queries of 2 to 100 characters", () => {
    expect(normalizeSearchQuery("  nhân tâm ")).toBe("nhân tâm");
    expect(normalizeSearchQuery(["ab", "cd"])).toBe("ab");
    expect(normalizeSearchQuery(" a ")).toBeNull();
    expect(normalizeSearchQuery("x".repeat(101))).toBeNull();
    expect(normalizeSearchQuery(undefined)).toBeNull();
  });
});

describe("groupSearchHits", () => {
  it("groups by kind and orders by score, then name", () => {
    const grouped = groupSearchHits(
      [
        { kind: "book", slug: "b", name: "Bến", score: 1 },
        { kind: "author", slug: "a", name: "An", score: 2 },
        { kind: "book", slug: "a", name: "Ánh", score: 1 },
        { kind: "book", slug: "c", name: "Cảng", score: 3 },
        { kind: "topic", slug: "t", name: "Tâm", score: 1 },
      ],
      "vi",
    );
    expect(grouped.books.map((hit) => hit.slug)).toEqual(["c", "a", "b"]);
    expect(grouped.authors.map((hit) => hit.slug)).toEqual(["a"]);
    expect(grouped.series).toEqual([]);
    expect(grouped.topics.map((hit) => hit.slug)).toEqual(["t"]);
  });

  it("keeps deterministic score-then-name order inside all six groups", () => {
    const kinds = [
      "book",
      "author",
      "idea",
      "article",
      "series",
      "topic",
    ] as const;
    const hits = kinds.flatMap((kind) => [
      { kind, slug: `${kind}-b`, name: "Beta", score: 1 },
      { kind, slug: `${kind}-a`, name: "Alpha", score: 1 },
      { kind, slug: `${kind}-top`, name: "Zeta", score: 5 },
    ]);
    const grouped = groupSearchHits([...hits].reverse(), "en");
    expect(Object.keys(grouped)).toEqual([
      "books",
      "authors",
      "ideas",
      "articles",
      "series",
      "topics",
    ]);
    for (const [group, kind] of [
      [grouped.books, "book"],
      [grouped.authors, "author"],
      [grouped.ideas, "idea"],
      [grouped.articles, "article"],
      [grouped.series, "series"],
      [grouped.topics, "topic"],
    ] as const) {
      expect(group.map((hit) => hit.slug)).toEqual([
        `${kind}-top`,
        `${kind}-a`,
        `${kind}-b`,
      ]);
    }
  });
});
