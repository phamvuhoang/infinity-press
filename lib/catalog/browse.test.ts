import { describe, expect, it } from "vitest";

import {
  booksForEntity,
  catalogFilterOptions,
  filterAndSortBooks,
  hasActiveFilters,
  homeShelves,
  parseCatalogFilters,
} from "@/lib/catalog/browse";
import type { CatalogBookCard } from "@/lib/catalog/public-types";

function card(overrides: Partial<CatalogBookCard> & { bookId: string }): CatalogBookCard {
  return {
    slug: overrides.bookId,
    title: overrides.bookId,
    subtitle: null,
    shortDescription: null,
    author: { name: "Author", slug: "author" },
    cover: null,
    offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
    hasSample: false, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

const older = card({ bookId: "older", title: "Ánh trăng", createdAt: "2026-09-01T00:00:00+00:00" });
const newer = card({
  bookId: "newer",
  title: "Bến cảng",
  createdAt: "2026-09-05T00:00:00+00:00",
  offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  topics: [{ slug: "habits", name: "Habits" }],
});
const shelved = card({
  bookId: "shelved",
  title: "Cánh đồng",
  shelfPosition: 1,
  author: { name: "Other", slug: "other" },
  series: { slug: "harbour", name: "Harbour", position: 2 },
});
const first = card({ bookId: "first", series: { slug: "harbour", name: "Harbour", position: 1 }, featured: true });

describe("parseCatalogFilters", () => {
  it("reads known values and ignores unknown ones", () => {
    expect(parseCatalogFilters({ topic: "habits", author: ["other", "x"], series: "Bad Slug", price: "cheap", sort: "title" })).toEqual({
      topic: "habits",
      author: "other",
      series: null,
      price: null,
      sort: "title",
    });
  });

  it("defaults to the featured sort with no filters", () => {
    const filters = parseCatalogFilters({});
    expect(filters.sort).toBe("featured");
    expect(hasActiveFilters(filters)).toBe(false);
    expect(hasActiveFilters({ ...filters, price: "free" })).toBe(true);
  });
});

describe("filterAndSortBooks", () => {
  const all = [older, newer, shelved];

  it("filters by topic, author, series, and price", () => {
    const none = parseCatalogFilters({});
    expect(filterAndSortBooks(all, { ...none, topic: "habits" }, "vi")).toEqual([newer]);
    expect(filterAndSortBooks(all, { ...none, author: "other" }, "vi")).toEqual([shelved]);
    expect(filterAndSortBooks(all, { ...none, series: "harbour" }, "vi")).toEqual([shelved]);
    expect(filterAndSortBooks(all, { ...none, price: "paid" }, "vi")).toEqual([newer]);
    expect(filterAndSortBooks(all, { ...none, price: "free" }, "vi").map((book) => book.bookId)).toEqual(["shelved", "older"]);
  });

  it("puts shelf books first, then newest, for the featured sort", () => {
    expect(filterAndSortBooks(all, parseCatalogFilters({}), "vi").map((book) => book.bookId)).toEqual(["shelved", "newer", "older"]);
  });

  it("sorts by newest and by title", () => {
    expect(filterAndSortBooks(all, parseCatalogFilters({ sort: "newest" }), "vi").map((book) => book.bookId)).toEqual(["newer", "older", "shelved"]);
    expect(filterAndSortBooks(all, parseCatalogFilters({ sort: "title" }), "vi").map((book) => book.title)).toEqual(["Ánh trăng", "Bến cảng", "Cánh đồng"]);
  });

  it("never mutates its input", () => {
    const input = [older, newer];
    filterAndSortBooks(input, parseCatalogFilters({ sort: "newest" }), "vi");
    expect(input).toEqual([older, newer]);
  });
});

describe("booksForEntity", () => {
  it("orders series books by position", () => {
    expect(booksForEntity([shelved, first, older], "series", "harbour", "vi")).toEqual([first, shelved]);
  });

  it("finds author and topic books", () => {
    expect(booksForEntity([older, shelved], "author", "other", "vi")).toEqual([shelved]);
    expect(booksForEntity([older, newer], "topic", "habits", "vi")).toEqual([newer]);
  });
});

describe("homeShelves", () => {
  it("returns the featured book and the shelf in order", () => {
    const second = card({ bookId: "second", shelfPosition: 2 });
    expect(homeShelves([second, first, shelved, older])).toEqual({
      featured: first,
      shelf: [shelved, second],
      journey: [first, shelved],
    });
    expect(homeShelves([older])).toEqual({ featured: null, shelf: [], journey: [] });
  });

  it("walks the featured book's series in position order, only once two of its books are published", () => {
    const series = { slug: "harbour", name: "Harbour" };
    const one = card({ bookId: "one", featured: true, series: { ...series, position: 1 } });
    const three = card({ bookId: "three", series: { ...series, position: 3 } });
    const two = card({ bookId: "two", series: { ...series, position: 2 } });
    const other = card({ bookId: "other", series: { slug: "other", name: "Other", position: 1 } });
    expect(homeShelves([three, other, one, two]).journey).toEqual([one, two, three]);
    expect(homeShelves([one, other]).journey).toEqual([]);
  });
});

describe("catalogFilterOptions", () => {
  it("lists each topic, author, and series once, sorted by name", () => {
    expect(catalogFilterOptions([older, newer, shelved, first], "vi")).toEqual({
      topics: [{ slug: "habits", name: "Habits" }],
      authors: [
        { slug: "author", name: "Author" },
        { slug: "other", name: "Other" },
      ],
      series: [{ slug: "harbour", name: "Harbour" }],
    });
  });
});
