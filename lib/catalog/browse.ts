import type { CatalogBookCard, CatalogEntityKind, CatalogTopicRef } from "@/lib/catalog/public-types";
import type { Locale } from "@/lib/i18n/config";

export const catalogSorts = ["featured", "newest", "title"] as const;
export type CatalogSort = (typeof catalogSorts)[number];

export type CatalogFilters = {
  topic: string | null;
  author: string | null;
  series: string | null;
  price: "free" | "paid" | null;
  sort: CatalogSort;
};

export type CatalogSearchParams = Record<string, string | string[] | undefined>;

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function slugParam(params: CatalogSearchParams, key: string): string | null {
  const value = firstValue(params[key])?.trim();
  return value && slugPattern.test(value) ? value : null;
}

// Unknown or malformed values are ignored, never an error: these come straight from the URL.
export function parseCatalogFilters(params: CatalogSearchParams): CatalogFilters {
  const price = firstValue(params.price);
  const sort = firstValue(params.sort);
  return {
    topic: slugParam(params, "topic"),
    author: slugParam(params, "author"),
    series: slugParam(params, "series"),
    price: price === "free" || price === "paid" ? price : null,
    sort: catalogSorts.find((candidate) => candidate === sort) ?? "featured",
  };
}

export function hasActiveFilters(filters: CatalogFilters): boolean {
  return Boolean(filters.topic || filters.author || filters.series || filters.price) || filters.sort !== "featured";
}

function newestFirst(left: CatalogBookCard, right: CatalogBookCard): number {
  return Date.parse(right.createdAt) - Date.parse(left.createdAt) || left.bookId.localeCompare(right.bookId);
}

export function sortBooks(cards: CatalogBookCard[], sort: CatalogSort, locale: Locale): CatalogBookCard[] {
  const sorted = [...cards];
  if (sort === "title") {
    const collator = new Intl.Collator(locale);
    return sorted.sort((left, right) => collator.compare(left.title, right.title));
  }
  if (sort === "newest") return sorted.sort(newestFirst);
  return sorted.sort((left, right) => {
    if (left.shelfPosition !== null && right.shelfPosition !== null) return left.shelfPosition - right.shelfPosition;
    if (left.shelfPosition !== null) return -1;
    if (right.shelfPosition !== null) return 1;
    return newestFirst(left, right);
  });
}

export function filterAndSortBooks(cards: CatalogBookCard[], filters: CatalogFilters, locale: Locale): CatalogBookCard[] {
  const matches = cards.filter(
    (card) =>
      (!filters.topic || card.topics.some((topic) => topic.slug === filters.topic)) &&
      (!filters.author || card.author.slug === filters.author) &&
      (!filters.series || card.series?.slug === filters.series) &&
      (!filters.price ||
        (card.offer !== null && (filters.price === "free" ? card.offer.priceMinor === 0 : card.offer.priceMinor > 0))),
  );
  return sortBooks(matches, filters.sort, locale);
}

export function booksForEntity(
  cards: CatalogBookCard[],
  kind: CatalogEntityKind,
  slug: string,
  locale: Locale,
): CatalogBookCard[] {
  if (kind === "series") {
    return cards
      .filter((card) => card.series?.slug === slug)
      .sort((left, right) => (left.series?.position ?? 0) - (right.series?.position ?? 0));
  }
  const matches =
    kind === "author"
      ? cards.filter((card) => card.author.slug === slug)
      : cards.filter((card) => card.topics.some((topic) => topic.slug === slug));
  return sortBooks(matches, "newest", locale);
}

export function homeShelves(cards: CatalogBookCard[]): {
  featured: CatalogBookCard | null;
  shelf: CatalogBookCard[];
  journey: CatalogBookCard[];
} {
  const featured = cards.find((card) => card.featured) ?? null;
  // The journey band walks the featured book's series in order. It needs at least two published
  // books to be a path rather than a repeat of the featured spread.
  const seriesSlug = featured?.series?.slug;
  const journey = seriesSlug
    ? cards.filter((card) => card.series?.slug === seriesSlug).sort((l, r) => l.series!.position - r.series!.position)
    : [];
  return {
    featured,
    shelf: cards
      .filter((card) => card.shelfPosition !== null)
      .sort((left, right) => (left.shelfPosition ?? 0) - (right.shelfPosition ?? 0)),
    journey: journey.length >= 2 ? journey : [],
  };
}

export type CatalogFilterOptions = {
  topics: CatalogTopicRef[];
  authors: CatalogTopicRef[];
  series: CatalogTopicRef[];
};

function uniqueSorted(entries: CatalogTopicRef[], collator: Intl.Collator): CatalogTopicRef[] {
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]));
  return [...bySlug.values()].sort((left, right) => collator.compare(left.name, right.name));
}

// Options come from visible books only, so every option returns at least one book.
export function catalogFilterOptions(cards: CatalogBookCard[], locale: Locale): CatalogFilterOptions {
  const collator = new Intl.Collator(locale);
  return {
    topics: uniqueSorted(cards.flatMap((card) => card.topics), collator),
    authors: uniqueSorted(
      cards.flatMap((card) => (card.author.slug ? [{ slug: card.author.slug, name: card.author.name }] : [])),
      collator,
    ),
    series: uniqueSorted(
      cards.flatMap((card) => (card.series ? [{ slug: card.series.slug, name: card.series.name }] : [])),
      collator,
    ),
  };
}
