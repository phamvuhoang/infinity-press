import type { ReaderAnnotationDecoration, ReaderAnnotationRenderResult, ReaderLocator, ReaderPositionInfo, ReaderPreferences, ReaderSelection, ReaderTocEntry } from "@/lib/reader/types";

// The outcome of a navigation request. Task 9's ADR-005 recorded gap (a) - `next()`/`previous()`
// returning `Promise<void>` made "moved" and "refused, already at the last page"
// indistinguishable, so a page-turn control could not disable itself at a book boundary. Task 10
// builds that control, so the gap is closed here rather than worked around in the component.
//
// Widened deliberately as a *shared* abstraction, not around Readium. Every field is something
// any reflowable-EPUB engine already knows:
//  - Readium: `goForward`/`goBackward` hand their callback an `ok: boolean`, and the navigator
//    exposes `canGoForward`/`canGoBackward` getters.
//  - epub.js (the plan's fallback): `rendition.next()` resolves when the move settles, and
//    `rendition.location.atStart`/`atEnd` give the same two boundary facts.
// So a second engine can satisfy this without either engine's vocabulary leaking through it.
//
// `moved` answers "did this request change position", which is not the same question as
// `canGoForward` - a move can succeed and still land on the last page, which is precisely the
// case a control has to render.
export type ReaderNavigationState = {
  canGoForward: boolean;
  canGoBackward: boolean;
};

export type ReaderNavigationResult = ReaderNavigationState & {
  moved: boolean;
};

// Engine boundary the Task 9 Readium spike (or its epub.js fallback) must
// implement. No Readium- or epub.js-specific types may appear here or in
// lib/reader/types.ts - callers only ever see this shape.
export interface ReaderEngine {
  mount(input: { container: HTMLElement; manifestUrl: string; initialLocator: ReaderLocator | null }): Promise<void>;
  goTo(locator: ReaderLocator): Promise<ReaderNavigationResult>;
  next(): Promise<ReaderNavigationResult>;
  previous(): Promise<ReaderNavigationResult>;
  setPreferences(preferences: ReaderPreferences): Promise<void>;
  setSelectionListener(listener: (selection: ReaderSelection | null) => void): void;
  // Publishes a selection change that has not settled yet, synchronously, before an action reads it.
  settleSelection(): void;
  setAnnotationActivationListener(listener: (annotationId: string) => void): void;
  setAnnotations(annotations: ReaderAnnotationDecoration[]): Promise<ReaderAnnotationRenderResult>;
  setResponsiveLayout(input: { pageCount: 1 | 2 }): Promise<void>;
  getPositionInfo(): Promise<ReaderPositionInfo | null>;
  getLocator(): Promise<ReaderLocator>;
  // The same two facts, without moving. Needed because a page-turn control has to render
  // correctly on the *first* paint, before any navigation has happened - at the opening page
  // "previous" is already unavailable, and guessing that from a default would be wrong for a
  // reader restored to the middle or the end of a book. epub.js satisfies this from
  // `rendition.location.atStart`/`atEnd`, so it stays engine-neutral.
  getNavigationState(): Promise<ReaderNavigationState>;
  // The publication's table of contents, for a navigation drawer. Read from the manifest the
  // adapter already fetched during mount() - the component never fetches the manifest itself,
  // which would mean parsing a delivery format the adapter owns, twice per open.
  //
  // Returns [] for a publication whose manifest carries no toc, which is legal: the sample manifest
  // filters its toc to the servable set and a sample of a single resource can filter down to
  // nothing.
  getTableOfContents(): Promise<ReaderTocEntry[]>;
  destroy(): Promise<void>;
}

// `ReaderEngine` is a pure type with no runtime presence. This is the real
// runtime boundary for a `ReaderLocator` crossing a trust line: submitted in
// a progress-save request body (Task 10) or read back out of a jsonb
// column (Tasks 8/10). Validate with this before trusting a locator that
// did not come straight out of `getLocator()`. This only checks shape -
// it does not normalize or path-check `href`; rejecting traversal or
// non-in-publication hrefs is the consumer's job (Task 8's Step 3), not
// this guard's.
export function isReaderLocator(value: unknown): value is ReaderLocator {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.href !== "string" || candidate.href.length === 0) return false;
  if (!isFraction(candidate.progression)) return false;
  if (candidate.totalProgression !== null && !isFraction(candidate.totalProgression)) return false;
  if (!isLocationsMap(candidate.locations)) return false;
  if (candidate.text !== undefined && !isLocatorText(candidate.text)) return false;

  return true;
}

// `reading_progress.progression` (platform Task 6 migration) is
// `numeric not null check (progression between 0 and 1)` - Postgres accepts
// only exactly [0, 1]. A real reader engine can report progression a hair
// outside that band from IEEE-754 rounding (e.g. 1.0000000002 on the last
// page), and rejecting that outright would fail a progress save at exactly
// the moment a reader finishes the book. Tolerate only that much
// floating-point noise - not nonsense like `5` or `-0.3` - and clamp back
// into range so every downstream consumer, including the database, gets a
// value it will accept.
const PROGRESSION_EPSILON = 1e-6;

function isFraction(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -PROGRESSION_EPSILON &&
    value <= 1 + PROGRESSION_EPSILON
  );
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isLocationsMap(value: unknown): value is Record<string, string | number> {
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string" || typeof entry === "number",
  );
}

function isLocatorText(value: unknown): value is NonNullable<ReaderLocator["text"]> {
  if (typeof value !== "object" || value === null) return false;
  const text = value as Record<string, unknown>;
  return (["before", "highlight", "after"] as const).every(
    (key) => text[key] === undefined || typeof text[key] === "string",
  );
}

// Throws instead of returning null so callers (API route handlers reading a
// request body, job code reading a stored locator) can let an invalid shape
// propagate as a single error rather than adding a null check at every call
// site. Rebuilds the object from only the contract's own fields - not a
// `{ ...value }` spread - so an untrusted caller cannot smuggle arbitrary
// extra properties through into `reading_progress.locator_json`, a jsonb
// column with no shape or size constraint of its own. The numeric fields
// come back clamped (see `PROGRESSION_EPSILON` above) so callers never have
// to re-clamp before persisting.
export function parseReaderLocator(value: unknown): ReaderLocator {
  if (!isReaderLocator(value)) {
    throw new Error("Invalid reader locator");
  }
  return {
    href: value.href,
    progression: clampFraction(value.progression),
    totalProgression: value.totalProgression === null ? null : clampFraction(value.totalProgression),
    locations: value.locations,
    ...(value.text === undefined ? {} : { text: value.text }),
  };
}
