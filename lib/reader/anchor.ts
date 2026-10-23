import { parseBoundedReaderLocator } from "@/lib/reader/annotations";
import type { ReaderLocator } from "@/lib/reader/types";

// `?anchor=<ordinal>` names an ebook_search_chunks row of the publication being read. Anything that
// is not one plain non-negative integer is ignored, so the page opens at the saved position.
export function parseAnchor(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^\d{1,7}$/.test(value)) return null;
  const anchor = Number(value);
  return anchor <= 1_000_000 ? anchor : null;
}

// A chunk RPC's locator, with its in-publication href turned into the URL the reader's manifest uses.
// Null for anything unusable, so a bad row falls back to the saved position instead of failing.
export function chunkLocator(value: unknown, toReaderHref: (href: string) => string): ReaderLocator | null {
  if (typeof value !== "object" || value === null) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.href !== "string") return null;
  try {
    return parseBoundedReaderLocator({ ...stored, href: toReaderHref(stored.href) });
  } catch {
    return null;
  }
}
