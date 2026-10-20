import type { ReaderTocEntry } from "@/lib/reader/types";

// Matching a reader's position to a chapter title. Pure, and deliberately not in the adapter: this
// is a question about our own manifest's toc and our own locator, and every engine behind the
// boundary would answer it identically.

export type FlatTocEntry = { title: string; href: string; depth: number };

export function flattenToc(entries: ReaderTocEntry[], depth = 0): FlatTocEntry[] {
  return entries.flatMap((entry) => [
    { title: entry.title, href: entry.href, depth },
    ...flattenToc(entry.children, depth + 1),
  ]);
}

// A toc href routinely points WITHIN a document (`chapter1.xhtml#section-2`) rather than at a
// different one, and a locator carries whatever fragment the engine reported. Membership is
// therefore tested on the path alone - the same rule splitTocFragment applies server-side in
// lib/reader/session.ts. Comparing whole strings would drop every fragment-bearing entry, which for
// a real EPUB nav is most of them.
// Exported because ReaderTocDrawer highlights the current entry by exactly this rule, and two
// byte-for-byte copies of it would be two chances to fix only one of them.
export function pathOf(href: string): string {
  const hash = href.indexOf("#");
  return hash === -1 ? href : href.slice(0, hash);
}

// The DEEPEST matching entry wins, which is why this scans to the end rather than returning on the
// first hit: a part and its opening chapter commonly name the same document, and the chapter is the
// more precise answer to "where am I". flattenToc emits parents before children, so the last match
// is the deepest one.
//
// Returns null rather than guessing when the reader is in a document the nav does not name - a
// cover, a colophon, or front matter. No chapter title is better than a wrong one.
export function chapterTitleFor(entries: ReaderTocEntry[], href: string | null | undefined): string | null {
  if (!href) return null;
  const target = pathOf(href);

  let match: string | null = null;
  for (const entry of flattenToc(entries)) {
    if (pathOf(entry.href) === target) match = entry.title;
  }
  return match;
}
