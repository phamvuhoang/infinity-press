import type { Decoration, DecorationObserver, EpubNavigatorListeners, IEpubPreferences, VisualNavigatorViewport } from "@readium/navigator";
import {
  type FetchImplementation,
  HttpFetcher,
  type Link,
  Locator,
  LocatorLocations,
  LocatorText,
  Manifest,
  Publication,
} from "@readium/shared";

import { FINISHED_TOTAL_PROGRESSION } from "@/lib/reader/completion";
import { anchorForRange, domRangePoint, verifiedRange } from "@/lib/reader/readium-anchors";
import { parseReaderLocator, type ReaderEngine, type ReaderNavigationResult } from "@/lib/reader/engine";
import type { ReaderLocator, ReaderPreferences, ReaderSelection, ReaderTocEntry } from "@/lib/reader/types";

// The Readium Web adapter, and the only module in this repo permitted to name Readium types.
//
// Two bundle rules hold this in place, and the build output is what verifies them:
//  - `@readium/navigator` (the DOM/iframe machinery, by far the larger package) is reached *only*
//    through a dynamic `import()` inside `createEpubNavigator` below, so it lands in its own async
//    chunk rather than in any page's initial JS. Everything else it needs from that package is a
//    type-only import, which TypeScript erases entirely.
//  - This module is imported only by `components/reader/reader-client.tsx`, a Client Component, so
//    no Server Component, catalog page, or public bundle can pull it in.
//
// Nothing Readium-shaped crosses back out: callers see `ReaderEngine`, `ReaderLocator` and
// `ReaderPreferences` and nothing else. That is what makes a second engine droppable in behind
// this same boundary, which is the actual point of the spike.

export class ReaderManifestError extends Error {
  constructor(readonly status: number) {
    super(`The reader manifest request failed with status ${status}.`);
    this.name = "ReaderManifestError";
  }
}

// The slice of Readium's `EpubNavigator` this adapter actually uses. Narrowing it to an explicit
// type is what lets the lifecycle tests mock the navigator boundary without standing up jsdom
// iframes - and it documents, in one place, exactly how much of Readium we depend on.
export type ReadiumNavigatorHandle = {
  readonly frames: { href: string; iframe: HTMLIFrameElement; send(key: "go_id", id: string, cb: (ok: boolean) => void): void }[];
  readonly viewport: VisualNavigatorViewport;
  applyDecorations(decorations: Decoration[], group: string): void;
  registerDecorationObserver(group: string, observer: DecorationObserver): void;
  unregisterDecorationObserver(observer: DecorationObserver): void;
  load(): Promise<void>;
  submitPreferences(preferences: IEpubPreferences): Promise<void>;
  destroy(): Promise<void>;
  go(locator: Locator, animated: boolean, cb: (ok: boolean) => void): void;
  goForward(animated: boolean, cb: (ok: boolean) => void): void;
  goBackward(animated: boolean, cb: (ok: boolean) => void): void;
  readonly currentLocator: Locator;
  // Added for ReaderNavigationResult (ADR-005 gap (a)). Both are plain getters on
  // `EpubNavigator`, so this widens the mocked surface by exactly what the real navigator
  // already offers - no new Readium capability is being assumed.
  readonly canGoForward: boolean;
  readonly canGoBackward: boolean;
};

export type ReadiumNavigatorFactory = (input: {
  container: HTMLElement;
  publication: Publication;
  listeners: Partial<EpubNavigatorListeners>;
  initialPosition: Locator | undefined;
  // The publication's position list. Passed through the factory rather than built inside the
  // real one so the lifecycle tests can assert it is non-empty - see buildPositions below for
  // why an empty list is not a harmless default but a crash.
  positions: Locator[];
}) => Promise<ReadiumNavigatorHandle>;

// Readium has no named themes - `EpubPreferences` takes concrete colours - so the three themes the
// shared contract offers are resolved to values here rather than leaking a Readium concept into
// `ReaderPreferences`.
//
// `light` resolves to `null` for both colours, not to concrete white/near-black hex values. `null`
// is Readium's "leave the publisher's own colours alone" - the same convention `FONT_STACKS.publisher`
// already uses below. Light is the publisher's own presentation: the reader surface around the frame
// is already white (`bg-white` in `reader-client.tsx`), so there is nothing for a forced text colour
// to accomplish there, and submitting one silently overrides every publication's own `h1`/body
// styling for a reader who never opened the settings panel. This regressed once - `setPreferences`
// used to be dead code, and wiring it up at mount (`reader-client.tsx`) turned light's hardcoded
// `#111827` into a real user override that beat the fixture publication's own CSS and broke the
// golden-path stylesheet assertion (e2e/ebook-golden-path.spec.ts). Do not "fill in" these nulls.
// Only `sepia` and `dark` are deliberate reader overrides that are meant to beat publisher CSS.
const THEMES = {
  light: { backgroundColor: null, textColor: null },
  sepia: { backgroundColor: "#faf4e8", textColor: "#3b2f1e" },
  dark: { backgroundColor: "#12151a", textColor: "#e5e7eb" },
} as const;

// `null` is Readium's "leave the publisher's own font alone", which is exactly what the
// `"publisher"` option means in the shared contract.
const FONT_STACKS = {
  publisher: null,
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;

// `locations` in the shared contract is a flat string/number map, while Readium models `position`
// and `fragments` as named fields and everything else as `otherLocations`. These two keys are the
// translation between the two, applied in both directions so a locator survives a round trip.
const POSITION_KEY = "position";
const FRAGMENT_KEY = "fragment";

// Resource requests carry the reader session, which lives in an httpOnly cookie scoped to /api
// (see app/api/reader/sessions/route.ts). `same-origin` is already fetch's default, but it is
// stated explicitly because the whole delivery model depends on it: strip the credentials and every
// manifest and resource fetch becomes an unauthenticated 401.
const sameOriginFetch: FetchImplementation = (input, init) =>
  fetch(input, { ...init, credentials: "same-origin" });

async function fetchManifestOverHttp(manifestUrl: string): Promise<unknown> {
  const response = await sameOriginFetch(manifestUrl, {
    headers: { Accept: "application/webpub+json, application/json" },
  });
  // The route answers 401 unauthenticated, 404 for every refusal, and 502 for an unreadable
  // publication. None of them is a manifest, and none of them should reach the parser.
  if (!response.ok) throw new ReaderManifestError(response.status);
  return response.json();
}

// Gives the publication a `self` link at this origin's ROOT, which is what makes the publication's
// own stylesheets, images and fonts load at all. Client-side only: the manifest the route serves is
// untouched.
//
// Readium builds every chapter frame as a `blob:` document and injects a `<base href>` taken from
// `Link.toURL(publication.baseURL)`. A `blob:` URL has an OPAQUE PATH, so a root-relative base href
// cannot be resolved against it - the `<base>` element is inert, `document.baseURI` stays the blob
// URL, and every relative reference inside the publication (`<link rel="stylesheet"
// href="../styles/style.css">`, `<img src="...">`, `@font-face`) fails to resolve. The browser then
// never issues the request at all. Observed in Chrome against a real published book, and reproduced
// standalone: `new URL("../styles/style.css", "blob:http://host/<uuid>")` throws `Invalid URL`.
//
// The ORIGIN ROOT is the only `self` href that fixes this. `Link.toURL()` strips a leading "/" and
// resolves the remainder against `baseURL`, so a `self` pointing at the manifest's own URL
// (`/api/reader/publications/<id>/manifest`) yields `baseURL = "/api/reader/publications/<id>/"` and
// DOUBLE-PREFIXES every resource into
// `/api/reader/publications/<id>/api/reader/publications/<id>/resources/...`. A path-only baseURL is
// not a valid CSP source expression either. The origin root yields `http://origin/` + `api/...`,
// which is the correct absolute URL and leaves every href's shape otherwise unchanged.
//
// It also closes a second, latent defect in the same place. `FrameBlobBuilder` substitutes its own
// `<meta>` CSP built from `[publication.baseURL, ...injector.allowedDomains]`; with both empty that
// policy is `style-src blob: 'unsafe-inline'; img-src blob: data:`, which does not admit our origin -
// so once the URLs resolved, the policy would refuse them. Setting `baseURL` puts our origin, and
// nothing but our origin, into every directive. That is why this is preferred over passing
// `configuration.injectables.allowedDomains`, which addresses only the policy and leaves the frame
// unable to resolve the URL in the first place (verified: with `allowedDomains` set and the origin
// present in every directive, the stylesheet still did not load and no request was ever issued).
//
// `Link.href` is untouched, so the locator `getLocator()` persists keeps the root-relative form
// already stored in `reading_progress.locator_json`.
// Exported for its unit test (Ruling CR). It determines what the reader frame is permitted to
// load, and was otherwise pinned only by the golden-path E2E - the slowest suite here and the one
// most easily skipped.
export function withOriginBaseURL(manifest: unknown): unknown {
  if (typeof manifest !== "object" || manifest === null) return manifest;
  const source = manifest as Record<string, unknown>;
  const existing = Array.isArray(source.links) ? source.links : [];
  return {
    ...source,
    // Ours goes first: `Manifest.baseURL` takes the first link carrying `self`.
    links: [
      { href: `${window.location.origin}/`, rel: ["self"], type: "application/webpub+json" },
      ...existing,
    ],
  };
}

export function nameReaderFrames(container: HTMLElement, title: string): void {
  for (const frame of container.querySelectorAll<HTMLIFrameElement>("iframe.readium-navigator-iframe")) {
    frame.title = title;
  }
}

const createEpubNavigator: ReadiumNavigatorFactory = async ({
  container,
  publication,
  listeners,
  initialPosition,
  positions,
}) => {
  const { EpubNavigator, EpubPreferences } = await import("@readium/navigator");

  // `EpubNavigator` fills every unset listener with a no-op of its own, so a partial set is safe.
  const navigator = new EpubNavigator(
    container,
    publication,
    listeners as EpubNavigatorListeners,
    positions,
    initialPosition,
  );
  const frameTitle = publication.metadata.title.getTranslation(publication.metadata.languages?.[0]);
  const observer = new MutationObserver(() => nameReaderFrames(container, frameTitle));
  observer.observe(container, { childList: true, subtree: true });

  return {
    load: async () => {
      await navigator.load();
      nameReaderFrames(container, frameTitle);
    },
    get frames() {
      return navigator._cframes.flatMap((frame, index) => frame ? [{
        href: navigator.viewport.readingOrder[index] ?? navigator.currentLocator.href,
        iframe: frame.iframe,
        send: (key: "go_id", id: string, cb: (ok: boolean) => void) => {
          if (frame.msg) frame.msg.send(key, id, cb);
          else cb(false);
        },
      }] : []);
    },
    get viewport() { return navigator.viewport; },
    applyDecorations: (decorations, group) => navigator.applyDecorations(decorations, group),
    registerDecorationObserver: (group, observer) => navigator.registerDecorationObserver(group, observer),
    unregisterDecorationObserver: (observer) => navigator.unregisterDecorationObserver(observer),
    submitPreferences: (preferences) => navigator.submitPreferences(new EpubPreferences(preferences)),
    destroy: () => {
      observer.disconnect();
      return navigator.destroy();
    },
    go: (locator, animated, cb) => navigator.go(locator, animated, cb),
    goForward: (animated, cb) => navigator.goForward(animated, cb),
    goBackward: (animated, cb) => navigator.goBackward(animated, cb),
    get currentLocator() {
      return navigator.currentLocator;
    },
    get canGoForward() {
      return navigator.canGoForward;
    },
    get canGoBackward() {
      return navigator.canGoBackward;
    },
  };
};

// `preferences.width` is deliberately not read here. Column width is a property of the container
// the engine renders into, not of the engine - the reader component applies it as a max-width on
// the host element - so it never becomes part of `IEpubPreferences`. See the field's own comment
// in lib/reader/types.ts.
function toEpubPreferences(preferences: ReaderPreferences): IEpubPreferences {
  const theme = THEMES[preferences.theme];
  return {
    fontFamily: FONT_STACKS[preferences.fontFamily],
    // Readium's `fontSize` is a multiplier, which is what `fontScale` already is.
    fontSize: preferences.fontScale,
    lineHeight: preferences.lineHeight,
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
  };
}

// `ReaderLocator` has no media type, because a media type is a delivery detail rather than a
// position. Readium's `Locator` requires one, so it is recovered from the publication's own
// reading order instead of being guessed at the call site.
function mediaTypeFor(publication: Publication | null, href: string): string {
  return publication?.linkWithHref(href)?.type ?? "application/xhtml+xml";
}

// Fallback positions for old/sample manifests: one entry per reading-order item.
// Entitled manifests with a validated infinityBooks extension use its stable list instead.
//
// This is not an optimization - without it the navigator crashes on open. `EpubNavigator.load()`
// does `this.positions?.length || (this.positions = await this.pub.positionsFromManifest())`, and
// `positionsFromManifest()` returns `[]` unless the manifest carries a link of media type
// `application/vnd.readium.position-list+json`. Our entitled manifest carries no such link - the
// served manifest has no `links` array at all, and the one `withOriginBaseURL` adds is a `self`
// link, not a position list - so the navigator ends up with zero positions. `load()` then does
// `this.currentLocation === undefined && (this.currentLocation = this.positions[0])`, which for a
// reader with no saved progress leaves `currentLocation` undefined, and `apply()` immediately
// dereferences it inside `framePool.update(...)`:
//
//     TypeError: Cannot read properties of undefined (reading 'locations')
//
// `go()` has the same shape (`this.positions.find(...)` yields undefined against an empty list),
// so locator restore would break for the same reason. Supplying positions fixes both.
//
// Task 9 could not have caught this: every adapter test mocks the navigator, so the real
// `EpubNavigator.load()` had never executed anywhere until the golden-path E2E ran it. ADR-005
// recorded that `positionsFromManifest()` degrades to `[]` without a request, which is true - but
// not that the navigator cannot then start.
function buildPositions(publication: Publication): Locator[] {
  const items = publication.readingOrder.items;
  return items.map((item, index) =>
    // Derived from the Link's own locator rather than hand-built, so href and media type come
    // from the manifest instead of being restated here.
    item.locator.copyWithLocations({
      position: index + 1,
      progression: 0,
      // Dead data on every read path: deriveTotalProgression (below) recomputes whole-book
      // progression itself and never reads this field back. It stays only because the list shape -
      // one entry per reading-order item - is load-bearing for EpubNavigator.load(); do not "fix"
      // this value without also checking deriveTotalProgression, or the seed's meaning drifts from
      // what actually ships.
      totalProgression: items.length > 0 ? index / items.length : 0,
    }),
  );
}

function toReadiumLocator(locator: ReaderLocator, type: string): Locator {
  const otherLocations = new Map<string, string | number>();
  const fragments: string[] = [];
  let position: number | undefined;

  for (const [key, value] of Object.entries(locator.locations)) {
    if (key === POSITION_KEY && typeof value === "number") {
      position = value;
    } else if (key === FRAGMENT_KEY && typeof value === "string") {
      fragments.push(value);
    } else {
      otherLocations.set(key, value);
    }
  }

  return new Locator({
    href: locator.href,
    type,
    locations: new LocatorLocations({
      progression: locator.progression,
      totalProgression: locator.totalProgression ?? undefined,
      position,
      fragments: fragments.length > 0 ? fragments : undefined,
      otherLocations: otherLocations.size > 0 ? otherLocations : undefined,
    }),
    text: locator.text ? new LocatorText(locator.text) : undefined,
  });
}

// Whole-book progression, derived rather than read back off the locator.
//
// `buildPositions` seeds one position per reading-order item with `totalProgression: index /
// items.length`, and Readium's `currentLocator` reports that seeded value unchanged - paging WITHIN
// a resource never moves it. So a publication with N reading-order items topped out at (N - 1) / N,
// `FINISHED_TOTAL_PROGRESSION` is 0.99, and no book under about a hundred chapters could ever be
// marked finished. Found by e2e/reader-completion.spec.ts against a real browser: a real two-chapter
// publication paged to its last page saved 0.5 and the library stayed on "In progress". No unit test
// could have caught it - every test in this file mocks the navigator, so `currentLocator` was
// whatever the mock said.
//
// The same defect quantized the library's percentage to chapter starts, since lib/data/library.ts
// renders that column too.
//
// S5.5 can supply the publication's stable digital positions instead of fallback entries.
// Neither list determines completion. A nonempty list remains necessary for mounting, while
// whole-book progress retains the boundary-derived conversion below.
//
// THE BOUNDARY LEADS, and column arithmetic only fills in behind it.
//
// Measured in Chrome against the real engine: `locations.progression` advances within a resource,
// normalized across that resource's COLUMNS, and reaches exactly 1 on the last page of a resource
// that has more than one - a four-column chapter reports 0, 1/3, 2/3, 1. But a resource that fits in
// a SINGLE column has `scrollWidth === clientWidth`, which leaves that normalization no range at
// all, and it reports 0 on the only page it has. Confirmed on four independent landings: a
// three-item publication whose final item was one short paragraph saved `progression: 0` there, on
// the true last page of the book with "Next page" already disabled, deriving (2 + 0) / 3 = 0.667.
//
// Short final items - a colophon, a dedication, a one-page "The End" - are the ordinary shape of a
// real book, so a purely fractional derivation would have shipped a whole class of books that could
// never be marked finished. `canGoForward === false` is not an approximation of the end; it IS the
// end, whatever the final resource's length or column count, and it needs nothing from inside the
// frame (`scrollWidth`/`clientWidth` live in the publication's own document and are not this
// adapter's to read).
//
// Below the boundary the fraction keeps mid-book percentages smooth, but it is CAPPED just under
// the finished threshold. The cap is not cosmetic. On a publication with 100 or more reading-order
// items, (N - 1) / N is already >= 0.99 - merely landing on the first page of item 120 of 120
// derives 0.9917 - so an uncapped fraction would mark the book finished, irreversibly
// (save_reading_progress never downgrades `library_items.state`), before a word of the final
// chapter was read. Completion comes from the boundary above and nowhere else.
function deriveTotalProgression(
  publication: Publication | null,
  locator: Locator,
  atEndOfBook: boolean,
): number | null {
  const items = publication?.readingOrder.items ?? [];
  if (items.length === 0) return locator.locations.totalProgression ?? null;

  if (atEndOfBook) return 1;

  const index = publication!.readingOrder.findIndexWithHref(locator.href);
  // A locator naming something outside the reading order (a resource, or a stale saved position
  // from a superseded publication) has no whole-book meaning. Falling back to whatever the engine
  // reported is better than inventing one.
  if (index < 0) return locator.locations.totalProgression ?? null;

  const within = locator.locations.progression ?? 0;
  // Completion comes from the navigation boundary above and nowhere else. Below it the fraction
  // must stay strictly under the threshold, or a book with 100+ reading-order items marks itself
  // finished - irreversibly - on merely landing in its final chapter. `0.99 - Number.EPSILON` is
  // 0.9899999999999998: below the threshold for deriveLibraryState, and still 99% once rounded, so
  // a long book is not visibly pinned at 98% across its final items.
  return Math.min((index + within) / items.length, FINISHED_TOTAL_PROGRESSION - Number.EPSILON);
}

function toReaderLocator(
  publication: Publication | null,
  locator: Locator,
  atEndOfBook: boolean,
): ReaderLocator {
  const locations: Record<string, string | number> = {};

  for (const [key, value] of locator.locations.otherLocations ?? new Map<string, unknown>()) {
    if (typeof value === "string" || typeof value === "number") locations[key] = value;
  }
  if (typeof locator.locations.position === "number") {
    locations[POSITION_KEY] = locator.locations.position;
  }
  const [fragment] = locator.locations.fragments ?? [];
  if (typeof fragment === "string") locations[FRAGMENT_KEY] = fragment;

  // Routed through parseReaderLocator rather than returned directly, for the clamp: a real engine
  // reports a progression a hair outside [0, 1] from floating-point rounding on the last page, and
  // `reading_progress.progression` is `check (progression between 0 and 1)`. Rebuilding through the
  // shared guard means no caller has to re-clamp before persisting, and no Readium class instance
  // survives into the returned value.
  return parseReaderLocator({
    href: locator.href,
    progression: locator.locations.progression ?? 0,
    totalProgression: deriveTotalProgression(publication, locator, atEndOfBook),
    locations,
    ...(locator.text
      ? {
          text: {
            before: locator.text.before,
            highlight: locator.text.highlight,
            after: locator.text.after,
          },
        }
      : {}),
  });
}

// Readium's `Links` is an object with an `items` array; each `Link` carries `href`, an optional
// `title`, and optional `children` (another `Links`). Mapped to the neutral tree here so no Readium
// type crosses the boundary.
//
// An untitled link is dropped rather than rendered as a blank row: a nav entry with no label is not
// something a reader can navigate by, and keeping it would put empty buttons in the drawer.
function toReaderTocEntries(links: { items: ReadonlyArray<Link> } | undefined): ReaderTocEntry[] {
  return (links?.items ?? []).flatMap((link) =>
    link.title
      ? [{ title: link.title, href: link.href, children: toReaderTocEntries(link.children) }]
      : toReaderTocEntries(link.children),
  );
}

const ANNOTATION_GROUP = "infinity-user-highlights";
const HIGHLIGHT_TINTS = { yellow: "#facc15", green: "#86efac", rose: "#fda4af" };

function visibleAnchor(handle: ReadiumNavigatorHandle, base: ReaderLocator): ReaderLocator {
  const frame = handle.frames.find((frame) => frame.href === base.href);
  const doc = frame?.iframe.contentDocument;
  const wnd = frame?.iframe.contentWindow;
  if (!doc?.body || !wnd) return base;
  const range = doc.createRange();
  // DOM geometry is unavailable in non-rendering environments.
  if (typeof range.getClientRects !== "function") return base;
  const visible = () => Array.from(range.getClientRects()).some((rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < wnd.innerWidth && rect.bottom > 0 && rect.top < wnd.innerHeight);
  const walker = doc.createTreeWalker(doc.body, 4);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.data.trim() || text.parentElement?.closest("script,style,noscript,template,[data-readium]")) continue;
    range.selectNodeContents(text);
    if (!visible()) continue;
    const characters = Array.from(text.data);
    const offsets = [0];
    for (const character of characters) offsets.push(offsets.at(-1)! + character.length);
    // Find the first visible glyph without measuring every preceding character in
    // a long paragraph. Both single pages and spreads use actual frame rectangles.
    let low = 0;
    let high = characters.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      range.setStart(text, offsets[low]);
      range.setEnd(text, offsets[middle + 1]);
      if (visible()) high = middle;
      else low = middle + 1;
    }
    for (let index = low; index < characters.length; index++) {
      const character = characters[index];
      const offset = offsets[index];
      range.setStart(text, offset);
      range.setEnd(text, offset + character.length);
      if (!/\s/u.test(character) && visible()) {
        range.setEnd(text, text.length);
        const anchor = anchorForRange(base.href, range, base);
        if (anchor?.text) {
          // Saved progress/search anchors stay small; selections have their own 1000 cap.
          const points = Array.from(anchor.text.highlight ?? "");
          anchor.text.highlight = points.slice(0, 160).join("");
          anchor.text.after = [...points.slice(160), ...Array.from(anchor.text.after ?? "")].slice(0, 64).join("");
          return anchor;
        }
      }
    }
  }
  return base;
}

function manifestPositions(raw: unknown, publication: Publication): Locator[] | null {
  try {
    const extension = (raw as { infinityBooks?: { positions?: unknown } }).infinityBooks?.positions;
    if (!Array.isArray(extension) || extension.length === 0) return null;
    let previousIndex = -1;
    let previousProgression = -1;
    const positions = extension.map((entry, index) => {
      const locator = parseReaderLocator(entry);
      const item = publication.readingOrder.findIndexWithHref(locator.href);
      if (item < 0 || item < previousIndex || (item === previousIndex && locator.progression < previousProgression) || locator.locations.position !== index + 1) throw new Error("Invalid positions");
      if (item !== previousIndex && (item !== previousIndex + 1 || locator.progression !== 0)) throw new Error("Incomplete positions");
      previousIndex = item;
      previousProgression = locator.progression;
      return toReadiumLocator(locator, mediaTypeFor(publication, locator.href));
    });
    return previousIndex === publication.readingOrder.items.length - 1 ? positions : null;
  } catch { return null; }
}

export function createReadiumEngine(
  options: {
    createNavigator?: ReadiumNavigatorFactory;
    fetchManifest?: (manifestUrl: string) => Promise<unknown>;
  } = {},
): ReaderEngine {
  const createNavigator = options.createNavigator ?? createEpubNavigator;
  const fetchManifest = options.fetchManifest ?? fetchManifestOverHttp;

  let navigator: ReadiumNavigatorHandle | null = null;
  let publication: Publication | null = null;
  let released = false;
  let mounting = false;
  let stablePositions: Locator[] | null = null;
  let selectionListener: ((selection: ReaderSelection | null) => void) | null = null;
  let activationListener: ((id: string) => void) | null = null;
  let annotationIds = new Set<string>();
  let currentDecorations: Decoration[] = [];
  let preferences: IEpubPreferences = {};
  let queue: Promise<unknown> = Promise.resolve();
  let navigationPending = false;
  const pendingNavigation = new Set<() => void>();
  const markerCleanups = new Set<() => void>();
  const documents = new Map<string, Promise<Document>>();
  const selectionCleanups = new Map<Document, () => void>();
  const observer: DecorationObserver = {
    onDecorationActivated(event) {
      if (released || event.group !== ANNOTATION_GROUP || !annotationIds.has(event.decoration.id)) return false;
      activationListener?.(event.decoration.id);
      return true;
    },
  };

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const pending = queue.then(() => { active(); return run(); });
    queue = pending.catch(() => {});
    return pending;
  }

  async function explicitNavigation(run: () => Promise<ReaderNavigationResult>): Promise<ReaderNavigationResult> {
    // Preserve S4's refusal of overlapping user turns. Serializing preference work
    // must not buffer a click burst and replay it after a slow resource transition.
    if (navigationPending) {
      const handle = active();
      return { moved: false, canGoForward: handle.canGoForward, canGoBackward: handle.canGoBackward };
    }
    navigationPending = true;
    try { return await serial(run); }
    finally { navigationPending = false; }
  }

  async function documentFor(href: string): Promise<Document> {
    const mounted = publication;
    const link = mounted?.readingOrder.findWithHref(href);
    if (!mounted || !link) throw new Error("Unknown reader resource.");
    const frame = active().frames.find((frame) => frame.href === href);
    if (frame?.iframe.contentDocument) return frame.iframe.contentDocument;
    let pending = documents.get(href);
    if (!pending) {
      pending = (async () => {
        const text = await mounted.get(link).readAsString();
        if (!text) throw new Error("Unreadable reader resource.");
        const doc = new DOMParser().parseFromString(text, "application/xhtml+xml");
        if (doc.querySelector("parsererror")) throw new Error("Invalid reader resource.");
        return doc;
      })();
      documents.set(href, pending);
    }
    return pending;
  }

  function clearSelection() { if (!released) selectionListener?.(null); }

  type ReadiumFrame = ReadiumNavigatorHandle["frames"][number];

  // Publishes a selected range of a frame. `reported` is Readium's pointerup rect, already relative
  // to the frame; without it the rect is read from the range.
  function publishSelection(frame: ReadiumFrame, range: Range, reported?: { x: number; y: number; width: number; height: number }) {
    if (released || !navigator || !publication) return;
    const text = range.toString();
    if (!text) { clearSelection(); return; }
    const locator = anchorForRange(frame.href, range, toReaderLocator(publication, navigator.currentLocator, !navigator.canGoForward));
    if (!locator || new TextEncoder().encode(JSON.stringify(locator)).length > 16384) { clearSelection(); return; }
    const fullAnchor = anchorForRange(frame.href, range, locator, 1001);
    const annotationText = Array.from(fullAnchor?.text?.highlight ?? "").length > 1000 ? null : locator.text!.highlight!;
    const box = reported ?? range.getClientRects?.()[0];
    if (!box) return;
    const rect = frame.iframe.getBoundingClientRect();
    selectionListener?.({ locator, text, annotationText, rect: { x: rect.left + box.x, y: rect.top + box.y, width: box.width, height: box.height } });
  }

  // Readium reports a selection only on pointerup. On touch screens the reader widens a long-press
  // selection by dragging the native handles, which fires selectionchange and no pointer events. Each
  // chapter document is watched; the latest selection is copied at once and published when it settles,
  // or earlier through settleSelection() when a toolbar action is about to read it.
  let pendingSelection: { doc: Document; range: Range } | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  function settleSelection() {
    clearTimeout(pendingTimer);
    const pending = pendingSelection;
    pendingSelection = null;
    if (!pending) return;
    const frame = navigator?.frames.find((candidate) => candidate.iframe.contentDocument === pending.doc);
    if (frame) publishSelection(frame, pending.range);
  }

  // Explicit navigation ends the selection. Readium keeps neighbouring frames cached with their DOM
  // selection (goTo even restores it around its marker), and selectionchange arrives asynchronously.
  // The ranges present at the move are remembered, so only a selection the reader makes afterwards
  // is published.
  const droppedRanges = new WeakMap<Document, { start: Node; startOffset: number; end: Node; endOffset: number }>();
  function dropSelection() {
    clearTimeout(pendingTimer);
    pendingSelection = null;
    for (const frame of navigator?.frames ?? []) {
      const selected = frame.iframe.contentWindow?.getSelection();
      const doc = frame.iframe.contentDocument;
      if (!doc) continue;
      if (selected?.rangeCount) {
        const range = selected.getRangeAt(0);
        droppedRanges.set(doc, { start: range.startContainer, startOffset: range.startOffset, end: range.endContainer, endOffset: range.endOffset });
      } else droppedRanges.delete(doc);
    }
    clearSelection();
  }
  function wasDropped(doc: Document, range: Range) {
    const dropped = droppedRanges.get(doc);
    return !!dropped && dropped.start === range.startContainer && dropped.startOffset === range.startOffset && dropped.end === range.endContainer && dropped.endOffset === range.endOffset;
  }

  function watchSelection(doc: Document) {
    if (selectionCleanups.has(doc)) return;
    let pressed = false;
    const down = () => { pressed = true; };
    // iOS can end a long press with pointercancel, so Readium never reports it: settle here too.
    const up = () => { pressed = false; if (pendingSelection?.doc === doc) schedule(); };
    function schedule() {
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(settleSelection, 250);
    }
    function changed() {
      const selected = doc.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed) {
        // A tap on the toolbar can collapse the frame's selection first; a copy still pending stays.
        clearSelection();
        return;
      }
      const range = selected.getRangeAt(0);
      if (wasDropped(doc, range)) return;
      droppedRanges.delete(doc);
      pendingSelection = { doc, range: range.cloneRange() };
      // A mouse drag is still reported by Readium's pointerup; only handle drags need the timer.
      if (!pressed) schedule();
    }
    // Readium's column snapper turns the first touchmove into a page swipe and deselects. iOS delivers
    // touchmove while a long press or a handle drag widens the selection (Android does not), so the
    // selection collapsed and the toolbar kept the first word. While text is selected, it never sees them.
    const hold = (event: Event) => { if (doc.getSelection()?.isCollapsed === false) event.stopImmediatePropagation(); };
    doc.defaultView?.addEventListener("touchmove", hold, { capture: true, passive: true });
    doc.addEventListener("selectionchange", changed);
    doc.addEventListener("pointerdown", down);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
    selectionCleanups.set(doc, () => {
      if (pendingSelection?.doc === doc) { clearTimeout(pendingTimer); pendingSelection = null; }
      doc.defaultView?.removeEventListener("touchmove", hold, { capture: true });
      doc.removeEventListener("selectionchange", changed);
      doc.removeEventListener("pointerdown", down);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
    });
  }

  function onSelection(selection: Parameters<EpubNavigatorListeners["textSelected"]>[0]) {
    if (released || !navigator || !publication) return;
    const frame = navigator.frames.find((frame) => frame.iframe.contentWindow?.location.href === selection.targetFrameSrc && (!selection.locator || frame.href === selection.locator.href));
    const doc = frame?.iframe.contentDocument;
    const selected = frame?.iframe.contentWindow?.getSelection();
    if (!frame || !doc || !selected?.rangeCount || !selection.text) { clearSelection(); return; }
    watchSelection(doc);
    droppedRanges.delete(doc);
    // This is the live selection, so any copy still pending is superseded.
    clearTimeout(pendingTimer);
    pendingSelection = null;
    publishSelection(frame, selected.getRangeAt(0), selection);
  }

  function onFrameLoaded(wnd: Window) {
    if (!released && wnd.document) watchSelection(wnd.document);
  }

  async function goToLocator(handle: ReadiumNavigatorHandle, locator: ReaderLocator): Promise<ReaderNavigationResult> {
    if (locator.locations.textOffset === undefined) {
      return navigate(handle, (cb) => handle.go(toReadiumLocator(locator, mediaTypeFor(publication, locator.href)), false, cb));
    }
    const refused = () => ({ moved: false, canGoForward: handle.canGoForward, canGoBackward: handle.canGoBackward });
    // Verify before changing resource; a corrupt/stale anchor must not land at its first quote.
    let doc: Document;
    try { doc = await documentFor(locator.href); } catch { return refused(); }
    if (released || !verifiedRange(doc, locator)) return refused();
    let frame = handle.frames.find((frame) => frame.href === locator.href);
    // Readium keeps neighbouring/cached resources in its frame pool. Finding a matching frame
    // therefore does not mean that resource is active: sending go_id to an inactive cached frame
    // scrolls the hidden document while the reader stays in the current chapter. Activate the
    // resource first unless it is part of the viewport's current reading order.
    if (!frame || handle.currentLocator.href !== locator.href) {
      const resource = toReadiumLocator({ ...locator, locations: {}, text: undefined, progression: 0 }, mediaTypeFor(publication, locator.href));
      const move = await navigate(handle, (cb) => handle.go(resource, false, cb));
      if (released || !move.moved) return refused();
      frame = handle.frames.find((frame) => frame.href === locator.href);
    }
    const range = frame?.iframe.contentDocument && verifiedRange(frame.iframe.contentDocument, locator);
    if (!frame || !range) return refused();
    // loadLocator drops domRange in Readium 2.10. Use its own go_id snapper with a
    // short-lived marker, so RTL/CJK and pagination remain owned by Readium.
    const start = range.startContainer as Text;
    const original = start.data;
    const selection = frame.iframe.contentWindow?.getSelection();
    const selectionRanges = Array.from({ length: selection?.rangeCount ?? 0 }, (_, index) => {
      const selected = selection!.getRangeAt(index);
      return { start: selected.startContainer, startOffset: selected.startOffset, end: selected.endContainer, endOffset: selected.endOffset };
    });
    const marker = range.startContainer.ownerDocument!.createElementNS("http://www.w3.org/1999/xhtml", "span");
    marker.id = `infinity-target-${crypto.randomUUID()}`;
    const collapsed = range.cloneRange();
    collapsed.collapse(true);
    collapsed.insertNode(marker);
    const split = marker.nextSibling;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      marker.remove();
      // Restore only the split text node; preserve publisher text-node indexes.
      if (split?.nodeType === 3 && start.nextSibling === split) {
        start.appendData((split as Text).data);
        split.parentNode?.removeChild(split);
      } else if (start.data !== original) start.data = original;
      if (selection && selectionRanges.length) {
        selection.removeAllRanges();
        for (const selected of selectionRanges) {
          const restored = start.ownerDocument.createRange();
          restored.setStart(selected.start, selected.startOffset);
          restored.setEnd(selected.end, selected.endOffset);
          selection.addRange(restored);
        }
      }
      // The decorator holds live ranges; rebuild them after repairing split nodes.
      if (!released && currentDecorations.length) {
        handle.applyDecorations([], ANNOTATION_GROUP);
        handle.applyDecorations(currentDecorations, ANNOTATION_GROUP);
      }
      markerCleanups.delete(cleanup);
    };
    markerCleanups.add(cleanup);
    try { return await navigate(handle, (cb) => frame!.send("go_id", marker.id, cb)); }
    finally { cleanup(); }
  }

  async function updatePreferences(update: IEpubPreferences) {
    const handle = active();
    const locator = visibleAnchor(handle, toReaderLocator(publication, handle.currentLocator, !handle.canGoForward));
    preferences = { ...preferences, ...update };
    dropSelection();
    await handle.submitPreferences(preferences);
    if (released || navigator !== handle) return;
    await goToLocator(handle, locator);
  }

  function active(): ReadiumNavigatorHandle {
    if (!navigator) throw new Error("The reader engine is not mounted.");
    return navigator;
  }

  // Readium reports navigation completion through a callback carrying `ok`. ADR-005 recorded the
  // boundary's inability to relay that as gap (a); Task 10 closes it, so the `ok` flag is now
  // carried out as `moved` instead of being discarded, and the navigator's own boundary getters
  // are read *after* the move settles so the result describes where the reader ended up.
  function navigate(
    handle: ReadiumNavigatorHandle,
    run: (cb: (ok: boolean) => void) => void,
  ): Promise<ReaderNavigationResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cancel = () => finish(false);
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        pendingNavigation.delete(cancel);
        resolve({
          moved: !released && navigator === handle && ok,
          canGoForward: handle.canGoForward,
          canGoBackward: handle.canGoBackward,
        });
      };
      pendingNavigation.add(cancel);
      try { run(finish); }
      catch (error) { pendingNavigation.delete(cancel); reject(error); }
    });
  }

  return {
    async mount({ container, manifestUrl, initialLocator }) {
      if (navigator || mounting || released) throw new Error("The reader engine is already mounted.");
      mounting = true;

      // The served manifest carries no `links`; withOriginBaseURL adds a `self` link at this
      // origin's root so the publication has a usable baseURL. See that function for why the frame
      // cannot load a stylesheet or image without one.
      const raw = await fetchManifest(manifestUrl);
      if (released) return;
      const manifest = Manifest.deserialize(withOriginBaseURL(raw));
      if (!manifest) throw new Error("The reader manifest could not be parsed.");

      const mounted = new Publication({ manifest, fetcher: new HttpFetcher(sameOriginFetch) });
      stablePositions = manifestPositions(raw, mounted);
      const mountPositions = stablePositions ?? buildPositions(mounted);
      // FramePoolManager indexes by position even for an exact textual restore.
      // Saved S4 fallback ordinals and newer textual anchors may not name an entry
      // in the current list. Seed from this resource's actual list before loading.
      const seed = initialLocator && (mountPositions.findLast((position) => position.href === initialLocator.href && (position.locations.progression ?? 0) <= initialLocator.progression) ?? mountPositions.find((position) => position.href === initialLocator.href));
      const initialPosition = initialLocator
        ? toReadiumLocator(initialLocator.locations.textOffset === undefined ? initialLocator : { ...initialLocator, locations: {}, text: undefined }, mediaTypeFor(mounted, initialLocator.href)).copyWithLocations({ position: seed?.locations.position })
        : undefined;

      const handle = await createNavigator({
        container,
        publication: mounted,
        initialPosition,
        // Never empty for a publication with a reading order: an empty list is what makes the
        // navigator start with no current location and throw. See buildPositions.
        positions: mountPositions,
        // Selection (and the frame load that lets it be watched) are the only navigator listeners. Page/keyboard controls still
        // invoke adapter methods and reconcile the returned navigation state.
        // Unset peripheral, swipe and position listeners remain Readium no-ops.
        listeners: { textSelected: onSelection, frameLoaded: onFrameLoaded },
      });

      if (released) { await handle.destroy(); return; }
      publication = mounted;
      navigator = handle;
      handle.registerDecorationObserver(ANNOTATION_GROUP, observer);
      await handle.load();
      if (!released && initialLocator?.locations.textOffset !== undefined) await goToLocator(handle, initialLocator);
    },

    goTo(locator) {
      return explicitNavigation(async () => { dropSelection(); return goToLocator(active(), locator); });
    },

    next() {
      return explicitNavigation(async () => { const handle = active(); dropSelection(); return navigate(handle, (cb) => handle.goForward(false, cb)); });
    },

    previous() {
      return explicitNavigation(async () => { const handle = active(); dropSelection(); return navigate(handle, (cb) => handle.goBackward(false, cb)); });
    },

    setPreferences(value) {
      return serial(() => updatePreferences(toEpubPreferences(value)));
    },

    setResponsiveLayout({ pageCount }) {
      return serial(() => updatePreferences({ columnCount: pageCount }));
    },

    setSelectionListener(listener) { if (!released) selectionListener = listener; },
    settleSelection() { if (!released) settleSelection(); },
    setAnnotationActivationListener(listener) { if (!released) activationListener = listener; },

    setAnnotations(annotations) {
      return serial(async () => {
        const handle = active();
        const decorations: Decoration[] = [];
        const unresolvedIds: string[] = [];
        for (const annotation of annotations) {
          try {
            const doc = await documentFor(annotation.locator.href);
            if (released) return { unresolvedIds: annotations.map((item) => item.id) };
            const range = verifiedRange(doc, annotation.locator);
            if (!range) throw new Error("Unresolved annotation.");
            const converted = toReadiumLocator(annotation.locator, mediaTypeFor(publication, annotation.locator.href));
            const otherLocations = new Map(converted.locations.otherLocations);
            otherLocations.set("domRange", {
              start: domRangePoint(range.startContainer, range.startOffset),
              end: domRangePoint(range.endContainer, range.endOffset),
            });
            const locator = converted.copyWithLocations({ otherLocations });
            decorations.push({ id: annotation.id, locator, style: { type: "highlight", tint: HIGHLIGHT_TINTS[annotation.color] } });
          } catch { unresolvedIds.push(annotation.id); }
        }
        if (!released) {
          annotationIds = new Set(decorations.map((item) => item.id));
          currentDecorations = decorations;
          handle.applyDecorations(decorations, ANNOTATION_GROUP);
        }
        return { unresolvedIds };
      });
    },

    async getPositionInfo() {
      const handle = active();
      if (!stablePositions) return null;
      const visible: number[] = [];
      for (const href of handle.viewport.readingOrder) {
        const boundary = handle.viewport.progressions.get(href);
        if (!boundary || !Number.isFinite(boundary.start) || !Number.isFinite(boundary.end) || boundary.end < boundary.start) continue;
        const positions = stablePositions.filter((position) => position.href === href);
        const start = positions.findLast((position) => (position.locations.progression ?? 0) <= boundary.start) ?? positions[0];
        const end = positions.findLast((position) => (position.locations.progression ?? 0) <= boundary.end) ?? start;
        if (start && end) visible.push(start.locations.position!, end.locations.position!);
      }
      if (!visible.length) return null;
      return { current: Math.max(1, Math.min(...visible)), end: Math.min(stablePositions.length, Math.max(...visible)), total: stablePositions.length };
    },

    async getLocator() {
      const handle = active();
      // `canGoForward` is read in the same breath as `currentLocator`, from the same handle, so the
      // two describe one moment rather than two.
      return visibleAnchor(handle, toReaderLocator(publication, handle.currentLocator, !handle.canGoForward));
    },

    async getNavigationState() {
      const handle = active();
      return { canGoForward: handle.canGoForward, canGoBackward: handle.canGoBackward };
    },

    async getTableOfContents() {
      // Read off the publication the adapter built during mount() - not a second fetch. `active()`
      // is called for its mounted-state check so this throws the same "not mounted" error as every
      // other member rather than quietly answering [].
      active();
      return toReaderTocEntries(publication?.toc);
    },

    async destroy() {
      const handle = navigator;
      // Detached before awaiting, so anything arriving during teardown finds nothing to touch.
      navigator = null;
      publication = null;
      released = true;
      for (const cancel of pendingNavigation) cancel();
      selectionListener = null;
      activationListener = null;
      annotationIds.clear();
      documents.clear();
      for (const cleanup of markerCleanups) cleanup();
      for (const cleanup of selectionCleanups.values()) cleanup();
      selectionCleanups.clear();
      handle?.unregisterDecorationObserver(observer);
      handle?.applyDecorations([], ANNOTATION_GROUP);
      await handle?.destroy();
    },
  };
}
