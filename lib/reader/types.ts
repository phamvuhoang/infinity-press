export type ReaderLocator = {
  href: string;
  progression: number;
  totalProgression: number | null;
  locations: Record<string, string | number>;
  text?: { before?: string; highlight?: string; after?: string };
};

export type ReaderSelection = {
  locator: ReaderLocator;
  text: string;
  // Verified normalized text for persistence; null means the selection exceeds the annotation
  // limit. Raw browser text above remains available to attributed Copy/Share.
  annotationText?: string | null;
  rect: { x: number; y: number; width: number; height: number };
};

export type ReaderAnnotationDecoration = {
  id: string;
  locator: ReaderLocator;
  color: "yellow" | "green" | "rose";
};

export type ReaderPositionInfo = { current: number; end: number; total: number };
export type ReaderAnnotationRenderResult = { unresolvedIds: string[] };

// One node of a publication's table of contents, in the engine-neutral vocabulary. Every reflowable
// EPUB engine already has this tree: Readium exposes it as `publication.toc` (a `Links` whose items
// carry `title`, `href` and `children`), and epub.js - ADR-005's deferred fallback - exposes
// `book.navigation.toc` with the same three fields. So this is a shared abstraction rather than a
// Readium shape wearing a different name.
//
// `href` is the href as the served manifest carries it, which is a Route Handler URL, not an
// in-publication path. That is the same space ReaderLocator.href lives in, which is what lets
// lib/reader/toc.ts match the two by plain comparison.
export type ReaderTocEntry = {
  title: string;
  href: string;
  children: ReaderTocEntry[];
};

export type ReaderPreferences = {
  fontFamily: "publisher" | "serif" | "sans";
  // A multiplier, not a pixel size: this is what a reflowable engine's own font-size preference
  // takes. lib/reader/preferences.ts maps the 15-26px the settings panel offers onto it.
  fontScale: number;
  lineHeight: number;
  // The reading column's width. Deliberately NOT passed to the engine: column width is a property
  // of the container the engine renders into, not of the engine, so the component applies it as a
  // max-width and toEpubPreferences ignores it. The consequence is that changing it resizes the
  // engine's host element and the engine re-paginates - a position-affecting change exactly like a
  // font-size change, and covered by the same locator-restore test.
  width: "narrow" | "medium" | "wide";
  // The stored key is `sepia`; the settings panel labels it "Paper". The label lives in the
  // dictionary, which is where a label belongs - renaming the key would change THEMES,
  // toEpubPreferences and their tests for a word on a button.
  theme: "light" | "sepia" | "dark";
};
