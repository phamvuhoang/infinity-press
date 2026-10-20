import type { Locale } from "@/lib/i18n/config";

export const searchHitKinds = [
  "book",
  "author",
  "idea",
  "article",
  "series",
  "topic",
] as const;
export type SearchHitKind = (typeof searchHitKinds)[number];
export type SearchHit = {
  kind: SearchHitKind;
  slug: string;
  name: string;
  score: number;
};

// Keys in display order (S12 spec 8): the knowledge groups sit beneath books and authors.
export type GroupedSearchHits = {
  books: SearchHit[];
  authors: SearchHit[];
  ideas: SearchHit[];
  articles: SearchHit[];
  series: SearchHit[];
  topics: SearchHit[];
};

// Same bounds as search_catalog (20260915110000). Outside them the page shows the prompt state.
export function normalizeSearchQuery(
  value: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim() ?? "";
  return trimmed.length >= 2 && trimmed.length <= 100 ? trimmed : null;
}

export function groupSearchHits(
  hits: SearchHit[],
  locale: Locale,
): GroupedSearchHits {
  const collator = new Intl.Collator(locale);
  const ordered = [...hits].sort(
    (left, right) =>
      right.score - left.score || collator.compare(left.name, right.name),
  );
  const ofKind = (kind: SearchHitKind) =>
    ordered.filter((hit) => hit.kind === kind);
  return {
    books: ofKind("book"),
    authors: ofKind("author"),
    ideas: ofKind("idea"),
    articles: ofKind("article"),
    series: ofKind("series"),
    topics: ofKind("topic"),
  };
}
