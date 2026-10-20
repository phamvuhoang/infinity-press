import { describe, expect, it, vi } from "vitest";

import { Locator, LocatorLocations, LocatorText, Manifest, Publication } from "@readium/shared";

import { FINISHED_TOTAL_PROGRESSION } from "@/lib/reader/completion";
import { isReaderLocator } from "@/lib/reader/engine";
import {
  createReadiumEngine,
  nameReaderFrames,
  type ReadiumNavigatorFactory,
  type ReadiumNavigatorHandle,
  withOriginBaseURL,
} from "@/lib/reader/readium-engine";
import type { ReaderLocator, ReaderPreferences } from "@/lib/reader/types";

// Mirrors what GET /api/reader/publications/{id}/manifest actually returns (lib/reader/session.ts
// `ReaderManifest`): every href already rewritten to an authenticated Route Handler URL, never a
// storage key and never a Supabase object URL. The adapter must cope with exactly this shape -
// notably a manifest with no `links` array at all.
//
// That is a statement about the SERVED manifest, and it stays true. The publication the adapter
// mounts is not the same document: `withOriginBaseURL` adds a `self` link at this origin's root
// before deserialization, so the mounted publication does have a baseURL. Without one the frame
// cannot resolve any of the hrefs above into a fetchable URL - see that function.
const manifestUrl = "/api/reader/publications/pub-1/manifest";
const chapterOne = "/api/reader/publications/pub-1/resources/ch1.xhtml";
const chapterTwo = "/api/reader/publications/pub-1/resources/ch2.xhtml";
// Deliberately *not* `application/xhtml+xml`. That is exactly `mediaTypeFor`'s fallback, so a
// fixture whose reading-order type equals the fallback cannot distinguish real recovery from the
// function doing nothing at all - gutting it would still pass.
const chapterThree = "/api/reader/publications/pub-1/resources/ch3.html";

const manifestJson = {
  "@context": "https://readium.org/webpub-manifest/context.jsonld",
  metadata: {
    title: "A Test Book",
    language: "en",
    identifier: "urn:uuid:test",
    authors: ["Test Author"],
  },
  readingOrder: [
    { href: chapterOne, type: "application/xhtml+xml" },
    { href: chapterTwo, type: "application/xhtml+xml" },
    { href: chapterThree, type: "text/html" },
  ],
  resources: [{ href: "/api/reader/publications/pub-1/resources/style.css", type: "text/css" }],
  toc: [{ title: "Chapter One", href: chapterOne, children: [] }],
};

// Ruling CR. withOriginBaseURL decides what the reader frame is permitted to load, and it was
// pinned only by the golden-path E2E - the slowest suite here and the one most easily skipped.
// These assert the three properties the fix actually rests on.
type ShapedManifest = {
  links: { href: string; rel: string[]; type: string }[];
  readingOrder: { href: string }[];
  resources: { href: string }[];
  toc: { href: string }[];
};

describe("withOriginBaseURL", () => {
  const origin = window.location.origin;

  function publicationFor(input: unknown): Publication {
    const manifest = Manifest.deserialize(input);
    if (!manifest) throw new Error("the manifest fixture failed to deserialize");
    return new Publication({ manifest });
  }

  it("prepends a self link at this origin's root", () => {
    const shaped = withOriginBaseURL(manifestJson) as ShapedManifest;

    expect(shaped.links[0].href).toBe(`${origin}/`);
    expect(shaped.links[0].rel).toContain("self");
  });

  // The property everything downstream depends on: with this link the publication has a baseURL,
  // so `Link.toURL()` yields an absolute URL and the `<base href>` Readium injects into each
  // blob: frame is resolvable. Without it the frame resolves nothing and silently loads no
  // stylesheet, image or font at all.
  it("gives the deserialized publication this origin as its baseURL", () => {
    expect(publicationFor(withOriginBaseURL(manifestJson)).baseURL).toBe(`${origin}/`);
  });

  // Ordering is load-bearing, not incidental: `Manifest.baseURL` takes the FIRST link carrying
  // `self`, so appending instead of prepending would let a manifest that already declared one
  // point the frame's base at a foreign origin.
  it("takes precedence over a self link the manifest already carries", () => {
    const foreign = "https://elsewhere.example/manifest";
    const shaped = withOriginBaseURL({
      ...manifestJson,
      links: [{ href: foreign, rel: ["self"], type: "application/webpub+json" }],
    }) as ShapedManifest;

    expect(shaped.links[0].href).toBe(`${origin}/`);
    expect(publicationFor(shaped).baseURL).toBe(`${origin}/`);
    // Kept, just no longer first - this drops nothing the manifest declared.
    expect(shaped.links.map((link) => link.href)).toContain(foreign);
  });

  // The hrefs must survive untouched: they are what `getLocator()` persists into
  // reading_progress.locator_json, so rewriting them here would silently change stored positions.
  it("leaves every href in the manifest untouched", () => {
    const shaped = withOriginBaseURL(manifestJson) as ShapedManifest;

    expect(shaped.readingOrder.map((item) => item.href)).toEqual([chapterOne, chapterTwo, chapterThree]);
    expect(shaped.resources[0].href).toBe("/api/reader/publications/pub-1/resources/style.css");
    expect(shaped.toc[0].href).toBe(chapterOne);
  });

  it("passes a non-object through rather than fabricating a manifest around it", () => {
    expect(withOriginBaseURL(null)).toBeNull();
    expect(withOriginBaseURL("not a manifest")).toBe("not a manifest");
  });
});

describe("nameReaderFrames", () => {
  it("gives every Readium content frame a publication-derived accessible name", () => {
    const container = document.createElement("div");
    container.innerHTML = '<iframe class="readium-navigator-iframe"></iframe><iframe class="other"></iframe>';

    nameReaderFrames(container, "A Test Book");

    expect(container.querySelector<HTMLIFrameElement>(".readium-navigator-iframe")?.title).toBe("A Test Book");
    expect(container.querySelector<HTMLIFrameElement>(".other")?.title).toBe("");
  });
});

const preferences: ReaderPreferences = {
  fontFamily: "serif",
  fontScale: 1.25,
  lineHeight: 1.6,
  width: "medium",
  theme: "dark",
};

type FactoryCall = Parameters<ReadiumNavigatorFactory>[0];

// The mocked Readium boundary. Only the *navigator* is faked - `Locator`, `Manifest` and
// `Publication` are the real classes from @readium/shared, so the locator mapping these tests
// exercise is checked against Readium's own data model rather than against a hand-written stand-in
// that could agree with the adapter while both disagree with Readium.
function createFakeNavigator(initial?: Locator) {
  let currentLocator =
    initial ??
    new Locator({
      href: chapterOne,
      type: "application/xhtml+xml",
      locations: new LocatorLocations({ progression: 0.25, totalProgression: 0.1, position: 3 }),
    });

  // Mutable so a test can put the fake navigator at a book boundary. Both are plain getters on
  // the real `EpubNavigator`, and both are read *after* a move settles, so a test that changes
  // them mid-move is reproducing exactly what the real navigator does when a page turn lands on
  // the last page.
  let canGoForward = true;
  let canGoBackward = true;

  const handle: ReadiumNavigatorHandle = {
    frames: [],
    viewport: { readingOrder: [chapterOne], progressions: new Map([[chapterOne, { start: 0.25, end: 0.7 }]]), positions: null },
    applyDecorations: vi.fn(),
    registerDecorationObserver: vi.fn(),
    unregisterDecorationObserver: vi.fn(),
    load: vi.fn(async () => {}),
    submitPreferences: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    go: vi.fn((_locator: Locator, _animated: boolean, cb: (ok: boolean) => void) => cb(true)),
    goForward: vi.fn((_animated: boolean, cb: (ok: boolean) => void) => cb(true)),
    goBackward: vi.fn((_animated: boolean, cb: (ok: boolean) => void) => cb(true)),
    get currentLocator() {
      return currentLocator;
    },
    get canGoForward() {
      return canGoForward;
    },
    get canGoBackward() {
      return canGoBackward;
    },
  };

  const calls: FactoryCall[] = [];
  const createNavigator: ReadiumNavigatorFactory = async (input) => {
    calls.push(input);
    return handle;
  };

  return {
    handle,
    createNavigator,
    calls,
    setCurrentLocator(next: Locator) {
      currentLocator = next;
    },
    setBoundaries(next: { canGoForward?: boolean; canGoBackward?: boolean }) {
      canGoForward = next.canGoForward ?? canGoForward;
      canGoBackward = next.canGoBackward ?? canGoBackward;
    },
  };
}

async function mountEngine(
  initialLocator: ReaderLocator | null = null,
  initial?: Locator,
  // Lets a test replace the fixture's toc (a raw RWPM link array, same shape readingOrder and
  // resources already use above) without hand-building a whole manifest. Passing `{ toc: undefined
  // }` drops it, which is how the "no toc" case below is built.
  overrides?: { toc?: unknown; infinityBooks?: unknown },
) {
  const fake = createFakeNavigator(initial);
  const manifest = { ...manifestJson, ...overrides };
  const fetchManifest = vi.fn(async () => manifest as unknown);
  const engine = createReadiumEngine({ createNavigator: fake.createNavigator, fetchManifest });
  const container = document.createElement("div");

  await engine.mount({ container, manifestUrl, initialLocator });

  return { ...fake, engine, container, fetchManifest };
}

describe("readium engine adapter - mount", () => {
  it("loads the protected manifest from the URL it was given", async () => {
    const { fetchManifest } = await mountEngine();

    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(fetchManifest).toHaveBeenCalledWith(manifestUrl);
  });

  it("builds a publication whose reading order is the manifest's, and loads the navigator", async () => {
    const { calls, handle, container } = await mountEngine();

    expect(calls).toHaveLength(1);
    const publication: Publication = calls[0].publication;
    expect(publication.readingOrder.items.map((item) => item.href)).toEqual([
      chapterOne,
      chapterTwo,
      chapterThree,
    ]);
    expect(publication.metadata.title.getTranslation("en")).toBe("A Test Book");
    expect(calls[0].container).toBe(container);
    expect(handle.load).toHaveBeenCalledTimes(1);
  });

  it("forwards the initial locator to the navigator as a Readium locator", async () => {
    const initialLocator: ReaderLocator = {
      href: chapterTwo,
      progression: 0.5,
      totalProgression: 0.75,
      locations: { position: 12 },
    };

    const { calls } = await mountEngine(initialLocator);

    const initialPosition = calls[0].initialPosition;
    expect(initialPosition).toBeDefined();
    expect(initialPosition?.href).toBe(chapterTwo);
    expect(initialPosition?.locations.progression).toBe(0.5);
    expect(initialPosition?.locations.totalProgression).toBe(0.75);
    // Readium's frame pool requires a position in THIS mounted publication's list,
    // even when the saved locator was written with an older fallback list.
    expect(initialPosition?.locations.position).toBe(2);
  });

  it("passes no initial position when the reader has never opened the book", async () => {
    const { calls } = await mountEngine(null);

    expect(calls[0].initialPosition).toBeUndefined();
  });

  it("refuses to mount twice over the same engine instance", async () => {
    const { engine, container } = await mountEngine();

    await expect(engine.mount({ container, manifestUrl, initialLocator: null })).rejects.toThrow();
  });
});

describe("readium engine adapter - setPreferences", () => {
  it("forwards typography and theme values to the navigator", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences(preferences);

    expect(handle.submitPreferences).toHaveBeenCalledTimes(1);
    const submitted = vi.mocked(handle.submitPreferences).mock.calls[0][0];
    // Typography: the scale is Readium's font-size multiplier, and line height passes through.
    expect(submitted.fontSize).toBe(1.25);
    expect(submitted.lineHeight).toBe(1.6);
    expect(submitted.fontFamily).toMatch(/serif/i);
    // Theme: Readium has no named themes, so light/sepia/dark must arrive as concrete colours.
    expect(submitted.backgroundColor).toEqual(expect.any(String));
    expect(submitted.textColor).toEqual(expect.any(String));
  });

  it("maps the publisher font to Readium's 'use the publisher's own font' null", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences({ ...preferences, fontFamily: "publisher" });

    expect(vi.mocked(handle.submitPreferences).mock.calls[0][0].fontFamily).toBeNull();
  });

  it("sends a different background for each theme", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences({ ...preferences, theme: "light" });
    await engine.setPreferences({ ...preferences, theme: "sepia" });
    await engine.setPreferences({ ...preferences, theme: "dark" });

    const backgrounds = vi
      .mocked(handle.submitPreferences)
      .mock.calls.map((call) => call[0].backgroundColor);
    expect(new Set(backgrounds).size).toBe(3);
  });

  it("maps the light theme to null colours, leaving the publisher's own presentation alone", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences({ ...preferences, theme: "light" });

    const submitted = vi.mocked(handle.submitPreferences).mock.calls[0][0];
    expect(submitted.backgroundColor).toBeNull();
    expect(submitted.textColor).toBeNull();
  });

  it("still sends concrete override colours for sepia and dark", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences({ ...preferences, theme: "sepia" });
    await engine.setPreferences({ ...preferences, theme: "dark" });

    const [sepia, dark] = vi.mocked(handle.submitPreferences).mock.calls.map((call) => call[0]);
    expect(sepia.backgroundColor).toBe("#faf4e8");
    expect(sepia.textColor).toBe("#3b2f1e");
    expect(dark.backgroundColor).toBe("#12151a");
    expect(dark.textColor).toBe("#e5e7eb");
  });

  it("does not pass the reading-column width to the engine", async () => {
    const { engine, handle } = await mountEngine();

    await engine.setPreferences({ ...preferences, width: "wide" });

    // Column width is a property of the container the engine renders into, not of the engine. The
    // component applies it as a max-width; if it ever leaks in here, the adapter has taken on a
    // layout concern that the second engine behind this boundary would have to reimplement.
    expect(vi.mocked(handle.submitPreferences).mock.calls[0][0]).not.toHaveProperty("width");
  });
});

describe("readium engine adapter - getLocator", () => {
  it("returns the shared locator shape, not a Readium locator", async () => {
    const { engine } = await mountEngine();

    const locator = await engine.getLocator();

    expect(isReaderLocator(locator)).toBe(true);
    expect(locator.href).toBe(chapterOne);
    expect(locator.progression).toBe(0.25);
    // Derived from the reading order, NOT the 0.1 the fake navigator reports - see the
    // whole-book progression block below for why the engine's own figure cannot be trusted.
    expect(locator.totalProgression).toBeCloseTo(0.25 / 3, 10);
    expect(locator.locations.position).toBe(3);
    // The Readium classes must not leak across the boundary.
    expect(locator).not.toBeInstanceOf(Locator);
    expect(locator.locations).not.toBeInstanceOf(LocatorLocations);
  });

  it("carries the textual context through when Readium supplies one", async () => {
    const { engine } = await mountEngine(
      null,
      new Locator({
        href: chapterOne,
        type: "application/xhtml+xml",
        locations: new LocatorLocations({ progression: 0.4 }),
        text: new LocatorText({ before: "before", highlight: "highlight", after: "after" }),
      }),
    );

    const locator = await engine.getLocator();

    expect(locator.text).toEqual({ before: "before", highlight: "highlight", after: "after" });
  });

  // A position outside the reading order - a resource, or a stale locator saved against a
  // superseded publication - has no whole-book meaning, so the adapter falls back to whatever the
  // engine reported rather than inventing one. The field is still present and null, never dropped.
  it("reports a null totalProgression rather than dropping the field", async () => {
    const { engine } = await mountEngine(
      null,
      new Locator({
        href: "/api/reader/publications/pub-1/resources/style.css",
        type: "text/css",
        locations: new LocatorLocations({ progression: 0.4 }),
      }),
    );

    const locator = await engine.getLocator();

    expect(locator.totalProgression).toBeNull();
  });

  // reading_progress.progression is `check (progression between 0 and 1)`, and a real engine can
  // report a hair outside that from floating-point rounding on the last page. The adapter must hand
  // back something the database will accept.
  it("clamps a progression that lands a hair outside [0, 1]", async () => {
    const { engine, setBoundaries } = await mountEngine(
      null,
      new Locator({
        href: chapterThree,
        type: "text/html",
        locations: new LocatorLocations({ progression: 1 + 1e-9, totalProgression: 1 + 1e-9 }),
      }),
    );
    // At the end of the book, so the whole-book figure comes from the boundary and the clamp is
    // left with the within-resource field, which is the one the database constrains.
    setBoundaries({ canGoForward: false });

    const locator = await engine.getLocator();

    expect(locator.progression).toBe(1);
    expect(locator.totalProgression).toBe(1);
  });

  // The whole-book figure can no longer exceed 1 by derivation - it is capped below the threshold
  // mid-book and set to exactly 1 at the boundary - but it is still handed back unchanged when the
  // locator names nothing in the reading order, and a real engine reports a hair over 1 there.
  it("clamps a whole-book progression the engine reported outside [0, 1]", async () => {
    const { engine } = await mountEngine(
      null,
      new Locator({
        href: "/api/reader/publications/pub-1/resources/not-in-the-reading-order.xhtml",
        type: "application/xhtml+xml",
        locations: new LocatorLocations({ progression: 0.5, totalProgression: 1 + 1e-9 }),
      }),
    );

    expect((await engine.getLocator()).totalProgression).toBe(1);
  });

  it("throws rather than inventing a locator before mount", async () => {
    const engine = createReadiumEngine({ createNavigator: createFakeNavigator().createNavigator });

    await expect(engine.getLocator()).rejects.toThrow();
  });
});

// Whole-book progression, which decides whether a reader is told they finished the book and whether
// their library says "Finished". It is DERIVED from the reading order here rather than read off the
// locator, because the position list this adapter must supply seeds one `totalProgression` per
// reading-order item (`index / items.length`) and Readium reports that seeded value unchanged as the
// reader pages within a resource.
//
// The consequence, found by e2e/reader-completion.spec.ts in a real browser and not by anything in
// this file: a publication with N items topped out at (N - 1) / N, so against a threshold of 0.99 no
// book under about a hundred chapters could ever be marked finished, and the library's percentage
// was quantized to chapter starts.
//
// The fixture's reading order has three items, so the numbers below are thirds.
//
// These tests pin the adapter's arithmetic GIVEN that Readium normalizes `locations.progression`
// per resource - they supply that value directly through the fake navigator and never touch
// Readium's own normalization, so they cannot tell it apart from a mock that merely agrees with our
// expectations. Only e2e/reader-completion.spec.ts pins that premise itself, against the real
// engine; if it is ever wrong, this file's tests would keep passing anyway.
describe("readium engine adapter - whole-book progression", () => {
  const threeItems = 3;

  async function totalProgressionAt(
    href: string,
    progression: number,
    options: { seeded?: number; atEnd?: boolean } = {},
  ) {
    const { engine, setBoundaries } = await mountEngine(
      null,
      new Locator({
        href,
        type: "application/xhtml+xml",
        locations: new LocatorLocations({
          progression,
          ...(options.seeded === undefined ? {} : { totalProgression: options.seeded }),
        }),
      }),
    );
    // The fake navigator reports `canGoForward: true` unless a test says otherwise, which is the
    // mid-book case every assertion below except the boundary ones wants.
    if (options.atEnd) setBoundaries({ canGoForward: false });
    return (await engine.getLocator()).totalProgression;
  }

  // The regression this whole block exists for. Before the fix this reported 2/3.
  it("reaches the finished threshold on the last page of the last item", async () => {
    const total = await totalProgressionAt(chapterThree, 1, { atEnd: true });

    expect(total).toBe(1);
    expect(total!).toBeGreaterThanOrEqual(FINISHED_TOTAL_PROGRESSION);
  });

  // The other half of "the boundary leads": a fraction that reaches 1 while the navigator says
  // there is still a page ahead does NOT finish the book. Only the boundary does.
  it("stays under the threshold at a full fraction while the navigator can still go forward", async () => {
    const total = await totalProgressionAt(chapterThree, 1);

    expect(total!).toBeLessThan(FINISHED_TOTAL_PROGRESSION);
    expect(total).toBe(FINISHED_TOTAL_PROGRESSION - Number.EPSILON);
  });

  // The boundary branch, and why it has to LEAD rather than fill in behind the fraction. Measured
  // in Chrome: a final resource that fits in one column has `scrollWidth === clientWidth`, which
  // leaves Readium's column normalization no range, so it reports `progression: 0` on the only page
  // it has - on the true last page of the book, with "Next page" already disabled. The fraction
  // alone would derive (N - 1) / N there and no such book could ever be marked finished. Short
  // final items - a colophon, a dedication, a one-page "The End" - are ordinary in real EPUBs.
  it("reports the end of the book when the navigator cannot go forward, whatever the fraction says", async () => {
    const total = await totalProgressionAt(chapterThree, 0, { atEnd: true });

    expect(total).toBe(1);
  });

  // Not merely "the last item": the boundary is what decides. A mid-book resource the navigator
  // says it cannot move past is still the end of the book as far as the reader is concerned.
  it("prefers the boundary over the reading-order position", async () => {
    expect(await totalProgressionAt(chapterOne, 0, { atEnd: true })).toBe(1);
  });

  // The inverse, and the guard against the boundary check swallowing the fraction: while the
  // navigator can still go forward, position is what counts.
  it("uses the fraction while the navigator can still go forward", async () => {
    expect(await totalProgressionAt(chapterThree, 0, { atEnd: false })).toBeCloseTo(2 / 3, 10);
  });

  // The inverse, and the reason `index / (items.length - 1)` is wrong: that formula would make the
  // START of the final chapter read as 100% and mark the book finished the moment it opened - a
  // write save_reading_progress never downgrades.
  it("does not reach the finished threshold on the first page of the last item", async () => {
    const total = await totalProgressionAt(chapterThree, 0);

    expect(total).toBeCloseTo((threeItems - 1) / threeItems, 10);
    expect(total!).toBeLessThan(0.99);
  });

  it("advances as the reader pages within one resource", async () => {
    const start = await totalProgressionAt(chapterTwo, 0);
    const middle = await totalProgressionAt(chapterTwo, 0.5);
    const end = await totalProgressionAt(chapterTwo, 1);

    expect(start).toBeCloseTo(1 / 3, 10);
    expect(middle).toBeCloseTo(1.5 / 3, 10);
    expect(end).toBeCloseTo(2 / 3, 10);
  });

  it("opens the book at zero", async () => {
    expect(await totalProgressionAt(chapterOne, 0)).toBe(0);
  });

  // The engine's own figure is not merely unhelpful, it is wrong, so it must not win - neither at
  // the boundary nor mid-book.
  it("ignores the totalProgression the engine reports", async () => {
    expect(await totalProgressionAt(chapterThree, 0, { seeded: 2 / 3, atEnd: true })).toBe(1);
    expect(await totalProgressionAt(chapterTwo, 0, { seeded: 0.9 })).toBeCloseTo(1 / 3, 10);
  });
});

// Important 2, found only by reading the branch as one thing. `(index + within) / items.length` is
// fine for the three-item fixture above and for any book under a hundred chapters, and wrong for
// every book over it: at 120 reading-order items, merely LANDING on the first page of item 120
// derives 0.9917, which clears the 0.99 threshold, so save_reading_progress marks the book
// completed - a write it never downgrades - before a word of the final chapter is read. At 200
// items it happens on item 199.
describe("readium engine adapter - whole-book progression on a long publication", () => {
  const LONG_ITEM_COUNT = 120;
  const longHrefs = Array.from(
    { length: LONG_ITEM_COUNT },
    (_, index) => `/api/reader/publications/pub-1/resources/ch${index + 1}.xhtml`,
  );
  const longManifest = {
    ...manifestJson,
    readingOrder: longHrefs.map((href) => ({ href, type: "application/xhtml+xml" })),
    toc: [],
  };

  async function longTotalProgressionAt(
    href: string,
    progression: number,
    options: { atEnd?: boolean } = {},
  ) {
    const fake = createFakeNavigator(
      new Locator({
        href,
        type: "application/xhtml+xml",
        locations: new LocatorLocations({ progression }),
      }),
    );
    const engine = createReadiumEngine({
      createNavigator: fake.createNavigator,
      fetchManifest: vi.fn(async () => longManifest as unknown),
    });
    await engine.mount({ container: document.createElement("div"), manifestUrl, initialLocator: null });
    if (options.atEnd) fake.setBoundaries({ canGoForward: false });
    return (await engine.getLocator()).totalProgression;
  }

  it("does not mark a 120-item book finished on the first page of its final item", async () => {
    const total = await longTotalProgressionAt(longHrefs[LONG_ITEM_COUNT - 1], 0);

    // The uncapped fraction here is 119/120 = 0.9917, which would have finished the book.
    expect((LONG_ITEM_COUNT - 1) / LONG_ITEM_COUNT).toBeGreaterThanOrEqual(FINISHED_TOTAL_PROGRESSION);
    expect(total!).toBeLessThan(FINISHED_TOTAL_PROGRESSION);
    // And it still reads as 99% rather than being visibly pinned lower - the reason the cap is
    // one epsilon under the threshold and not 0.01 under it.
    expect(Math.round(total! * 100)).toBe(99);
  });

  // The cap must not swallow the boundary, which is the only thing allowed to finish a book.
  it("still reports exactly 1 at the navigation boundary of a long book", async () => {
    expect(await longTotalProgressionAt(longHrefs[LONG_ITEM_COUNT - 1], 1, { atEnd: true })).toBe(1);
  });

  // And it must not disturb anything below the threshold.
  it("leaves mid-book progression on a long publication untouched", async () => {
    expect(await longTotalProgressionAt(longHrefs[59], 0.5)).toBeCloseTo(59.5 / LONG_ITEM_COUNT, 10);
  });
});

describe("readium engine adapter - navigation", () => {
  it("delegates next and previous to the navigator", async () => {
    const { engine, handle } = await mountEngine();

    await engine.next();
    await engine.previous();

    expect(handle.goForward).toHaveBeenCalledTimes(1);
    expect(handle.goBackward).toHaveBeenCalledTimes(1);
  });

  it("converts a shared locator to a Readium locator when going to one", async () => {
    const { engine, handle } = await mountEngine();

    await engine.goTo({
      href: chapterTwo,
      progression: 0.5,
      totalProgression: null,
      locations: {},
    });

    const [target] = vi.mocked(handle.go).mock.calls[0];
    expect(target).toBeInstanceOf(Locator);
    expect(target.href).toBe(chapterTwo);
    expect(target.locations.progression).toBe(0.5);
    // The media type is not part of ReaderLocator, so the adapter must recover it from the
    // publication's own reading order rather than guessing.
    expect(target.type).toBe("application/xhtml+xml");
  });

  it("recovers a media type that differs from the fallback when going to a locator", async () => {
    const { engine, handle } = await mountEngine();

    await engine.goTo({
      href: chapterThree,
      progression: 0.25,
      totalProgression: null,
      locations: {},
    });

    const [target] = vi.mocked(handle.go).mock.calls[0];
    expect(target.type).toBe("text/html");
  });

  it("falls back to XHTML for an href the publication does not list", async () => {
    const { engine, handle } = await mountEngine();

    await engine.goTo({
      href: "/api/reader/publications/pub-1/resources/not-in-manifest.xhtml",
      progression: 0,
      totalProgression: null,
      locations: {},
    });

    const [target] = vi.mocked(handle.go).mock.calls[0];
    expect(target.type).toBe("application/xhtml+xml");
  });
});

describe("readium engine adapter - media type recovery on mount", () => {
  // Regression guard for the defect the golden-path E2E found: with an empty positions list the
  // real EpubNavigator.load() leaves `currentLocation` undefined for a reader with no saved
  // progress and then throws "Cannot read properties of undefined (reading 'locations')" inside
  // apply(). Every test here mocks the navigator, so nothing in this file could see that until
  // the positions list became an observable input.
  it("supplies one position per reading-order item, never an empty list", async () => {
    const { calls } = await mountEngine();

    expect(calls[0].positions).toHaveLength(manifestJson.readingOrder.length);
    expect(calls[0].positions.map((position) => position.href)).toEqual([
      chapterOne,
      chapterTwo,
      chapterThree,
    ]);
    // Positions must be ordered and addressable: the navigator indexes into this list, and go()
    // matches against it by href.
    expect(calls[0].positions.map((position) => position.locations.position)).toEqual([1, 2, 3]);
  });

  it("recovers a non-fallback media type for the initial locator", async () => {
    const { calls } = await mountEngine({
      href: chapterThree,
      progression: 0.1,
      totalProgression: null,
      locations: {},
    });

    expect(calls[0].initialPosition?.type).toBe("text/html");
  });

  // Readium reports a refused move (already at the last page) as `ok === false`. That must still
  // settle rather than reject - a boundary refusal is a normal outcome, not an error - but since
  // Task 10 closed ADR-005's gap (a) it must now settle with `moved: false` rather than
  // discarding the distinction. This is the test that would fail if the `ok` flag were dropped
  // again on the way out.
  it("reports a refused move as moved: false instead of rejecting", async () => {
    const { engine, handle } = await mountEngine();
    vi.mocked(handle.goForward).mockImplementation((_animated, cb) => cb(false));

    await expect(engine.next()).resolves.toEqual({
      moved: false,
      canGoForward: true,
      canGoBackward: true,
    });
  });

  it("reports a successful move as moved: true", async () => {
    const { engine } = await mountEngine();

    await expect(engine.next()).resolves.toEqual({
      moved: true,
      canGoForward: true,
      canGoBackward: true,
    });
  });

  // The whole point of the widening: a page-turn control has to be able to disable itself at the
  // start and end of a book. `moved` alone cannot express that - a move can succeed and still
  // land on the last page, which is this case.
  it("carries the navigator's boundary flags out of a successful move", async () => {
    const { engine, handle, setBoundaries } = await mountEngine();
    vi.mocked(handle.goForward).mockImplementation((_animated, cb) => {
      setBoundaries({ canGoForward: false, canGoBackward: true });
      cb(true);
    });

    await expect(engine.next()).resolves.toEqual({
      moved: true,
      canGoForward: false,
      canGoBackward: true,
    });
  });

  // Without this the opening page would have to guess, and would guess wrong: at the start of a
  // book "previous" is already unavailable, and a reader restored to the last page has no "next".
  it("reports the boundary state before any navigation has happened", async () => {
    const { engine, setBoundaries } = await mountEngine();
    setBoundaries({ canGoForward: true, canGoBackward: false });

    await expect(engine.getNavigationState()).resolves.toEqual({
      canGoForward: true,
      canGoBackward: false,
    });
  });

  it("stops reporting a navigation state for a navigator it has released", async () => {
    const { engine } = await mountEngine();

    await engine.destroy();

    await expect(engine.getNavigationState()).rejects.toThrow();
  });

  it("reports boundary flags from previous() and goTo() too, not only next()", async () => {
    const { engine, setBoundaries } = await mountEngine();
    setBoundaries({ canGoForward: true, canGoBackward: false });

    await expect(engine.previous()).resolves.toEqual({
      moved: true,
      canGoForward: true,
      canGoBackward: false,
    });
    await expect(
      engine.goTo({ href: chapterTwo, progression: 0.5, totalProgression: null, locations: {} }),
    ).resolves.toEqual({ moved: true, canGoForward: true, canGoBackward: false });
  });
});

describe("readium engine adapter - destroy", () => {
  it("releases the navigator", async () => {
    const { engine, handle } = await mountEngine();

    await engine.destroy();

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("is safe to call twice without destroying the navigator twice", async () => {
    const { engine, handle } = await mountEngine();

    await engine.destroy();
    await engine.destroy();

    expect(handle.destroy).toHaveBeenCalledTimes(1);
  });

  it("stops answering for a navigator it has released", async () => {
    const { engine } = await mountEngine();

    await engine.destroy();

    await expect(engine.getLocator()).rejects.toThrow();
    await expect(engine.next()).rejects.toThrow();
  });

  it("registers only selection and frame loads, leaving keyboard, swipe and peripheral navigation disabled", async () => {
    const { calls } = await mountEngine();

    // A selection listener must not quietly opt into Readium-owned movement. frameLoaded only lets
    // the engine watch a chapter's selection. Navigation still enters through explicit adapter
    // methods and returns its boundary state.
    expect(Object.keys(calls[0].listeners)).toEqual(["textSelected", "frameLoaded"]);
  });
});

describe("readium engine adapter - getTableOfContents", () => {
  it("maps the publication's toc into the neutral tree", async () => {
    const { engine } = await mountEngine(null, undefined, {
      toc: [
        {
          href: chapterOne,
          title: "Part One",
          children: [{ href: `${chapterOne}#a`, title: "A Beginning" }],
        },
      ],
    });

    await expect(engine.getTableOfContents()).resolves.toEqual([
      {
        title: "Part One",
        href: chapterOne,
        children: [{ title: "A Beginning", href: `${chapterOne}#a`, children: [] }],
      },
    ]);
  });

  it("returns nothing for a publication with no toc", async () => {
    const { engine } = await mountEngine(null, undefined, { toc: undefined });

    await expect(engine.getTableOfContents()).resolves.toEqual([]);
  });

  it("refuses before the engine is mounted", async () => {
    await expect(createReadiumEngine().getTableOfContents()).rejects.toThrow(
      "The reader engine is not mounted.",
    );
  });
});

describe("readium engine depth", () => {
  const target: ReaderLocator = {
    href: chapterOne, progression: 0.25, totalProgression: null,
    locations: { cssSelector: "#passage", textOffset: 15 },
    text: { before: "First 😀 quote. ", highlight: "Second quote.", after: " End." },
  };

  function addFrame(handle: ReadiumNavigatorHandle) {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    iframe.contentDocument!.body.innerHTML = '<p id="passage">First 😀 quote. Second quote. End.</p>';
    vi.spyOn(iframe, "getBoundingClientRect").mockReturnValue({ x: 100, y: 200, left: 100, top: 200, width: 600, height: 800 } as DOMRect);
    const send = vi.fn((_key: "go_id", _id: string, cb: (ok: boolean) => void) => cb(true));
    handle.frames.push({ href: chapterOne, iframe, send });
    return { iframe, doc: iframe.contentDocument!, send };
  }

  it("translates frame coordinates and retains full selected text separately from bounded anchors", async () => {
    const { engine, handle, calls } = await mountEngine();
    const { iframe, doc } = addFrame(handle);
    doc.querySelector("p")!.textContent = "a".repeat(1200);
    const range = doc.createRange();
    range.selectNodeContents(doc.querySelector("p")!);
    const selection = iframe.contentWindow!.getSelection()!;
    selection.addRange(range);
    const listener = vi.fn();
    engine.setSelectionListener(listener);
    calls[0].listeners.textSelected!({ text: "a".repeat(1200), x: 10, y: 20, width: 30, height: 40, targetFrameSrc: iframe.contentWindow!.location.href, locator: new Locator({ href: chapterOne, type: "application/xhtml+xml" }) });
    const result = listener.mock.calls[0][0];
    expect(result.rect).toEqual({ x: 110, y: 220, width: 30, height: 40 });
    expect(result.text).toHaveLength(1200);
    expect(result.annotationText).toBeNull();
    expect(result.locator.text.highlight).toHaveLength(1000);
    expect(result.locator.locations.textOffset).toBe(0);
    await engine.destroy();
    listener.mockClear();
    calls[0].listeners.textSelected!({ text: "late", x: 0, y: 0, width: 1, height: 1, targetFrameSrc: "" });
    expect(listener).not.toHaveBeenCalled();
    iframe.remove();
  });

  it("follows a touch selection that grows by dragging its handles, which fires no pointer events", async () => {
    vi.useFakeTimers();
    try {
      const { engine, handle, calls } = await mountEngine();
      const { iframe, doc } = addFrame(handle);
      const rects = vi.fn(() => [{ x: 5, y: 6, width: 7, height: 8 }] as unknown as DOMRectList);
      Object.defineProperty(doc.defaultView!.Range.prototype, "getClientRects", { configurable: true, value: rects });
      const text = doc.querySelector("p")!.firstChild as Text;
      const selection = iframe.contentWindow!.getSelection()!;
      const word = doc.createRange();
      word.setStart(text, 16);
      word.setEnd(text, 22);
      selection.addRange(word);
      const listener = vi.fn();
      engine.setSelectionListener(listener);
      // A long press selects one word and lifts the finger: Readium reports that word.
      calls[0].listeners.textSelected!({ text: "Second", x: 0, y: 0, width: 1, height: 1, targetFrameSrc: iframe.contentWindow!.location.href, locator: new Locator({ href: chapterOne, type: "application/xhtml+xml" }) });
      expect(listener.mock.lastCall![0].text).toBe("Second");
      // Dragging the native handles only changes the selection.
      selection.getRangeAt(0).setEnd(text, 29);
      doc.dispatchEvent(new Event("selectionchange"));
      expect(listener).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(300);
      const grown = listener.mock.lastCall![0];
      expect(grown.text).toBe("Second quote.");
      expect(grown.locator.text.highlight).toBe("Second quote.");
      expect(grown.rect).toEqual({ x: 105, y: 206, width: 7, height: 8 });
      // A long press that iOS ends with pointercancel is never reported by Readium.
      doc.dispatchEvent(new Event("pointerdown"));
      selection.getRangeAt(0).setStart(text, 0);
      doc.dispatchEvent(new Event("selectionchange"));
      await vi.advanceTimersByTimeAsync(300);
      expect(listener.mock.lastCall![0].text).toBe("Second quote.");
      doc.dispatchEvent(new Event("pointercancel"));
      await vi.advanceTimersByTimeAsync(300);
      expect(listener.mock.lastCall![0].text).toBe("First 😀 quote. Second quote.");
      await engine.destroy();
      iframe.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a widened selection synchronously before an action, even after the frame collapsed it", async () => {
    vi.useFakeTimers();
    try {
      const { engine, handle, calls } = await mountEngine();
      const { iframe, doc } = addFrame(handle);
      Object.defineProperty(doc.defaultView!.Range.prototype, "getClientRects", { configurable: true, value: () => [{ x: 5, y: 6, width: 7, height: 8 }] });
      const text = doc.querySelector("p")!.firstChild as Text;
      const selection = iframe.contentWindow!.getSelection()!;
      const word = doc.createRange(); word.setStart(text, 16); word.setEnd(text, 22);
      selection.addRange(word);
      const listener = vi.fn();
      engine.setSelectionListener(listener);
      calls[0].listeners.textSelected!({ text: "Second", x: 0, y: 0, width: 1, height: 1, targetFrameSrc: iframe.contentWindow!.location.href, locator: new Locator({ href: chapterOne, type: "application/xhtml+xml" }) });
      selection.getRangeAt(0).setEnd(text, 29);
      doc.dispatchEvent(new Event("selectionchange"));
      // Tapping the toolbar can collapse the frame's selection before the action runs.
      selection.removeAllRanges();
      doc.dispatchEvent(new Event("selectionchange"));
      engine.settleSelection();
      expect(listener.mock.lastCall![0].text).toBe("Second quote.");
      const published = listener.mock.calls.length;
      await vi.advanceTimersByTimeAsync(300);
      // The collapse is still reported as null; nothing republishes a selection.
      expect(listener.mock.calls.slice(published).every(([next]) => next === null)).toBe(true);
      await engine.destroy();
      iframe.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never republishes a pending selection after the reader turns the page", async () => {
    vi.useFakeTimers();
    try {
      const { engine, handle, calls } = await mountEngine();
      const { iframe, doc } = addFrame(handle);
      Object.defineProperty(doc.defaultView!.Range.prototype, "getClientRects", { configurable: true, value: () => [{ x: 5, y: 6, width: 7, height: 8 }] });
      const listener = vi.fn();
      engine.setSelectionListener(listener);
      // The frame is watched from its load, as Readium's frameLoaded reports it.
      calls[0].listeners.frameLoaded!(iframe.contentWindow!);
      const range = doc.createRange(); range.selectNodeContents(doc.querySelector("p")!);
      iframe.contentWindow!.getSelection()!.addRange(range);
      doc.dispatchEvent(new Event("selectionchange"));
      await engine.next();
      engine.settleSelection();
      await vi.advanceTimersByTimeAsync(300);
      expect(listener.mock.calls.every(([selection]) => selection === null)).toBe(true);
      await engine.destroy();
      iframe.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves and replaces annotations individually and activates only current user highlights", async () => {
    const { engine, handle } = await mountEngine();
    const { iframe } = addFrame(handle);
    const listener = vi.fn();
    engine.setAnnotationActivationListener(listener);
    const invalid = { ...target, text: { highlight: "missing" } };
    expect(await engine.setAnnotations([{ id: "good", locator: target, color: "green" }, { id: "bad", locator: invalid, color: "yellow" }])).toEqual({ unresolvedIds: ["bad"] });
    const [decorations, group] = vi.mocked(handle.applyDecorations).mock.calls.at(-1)!;
    expect(decorations).toHaveLength(1);
    expect(decorations[0].locator.locations.otherLocations?.get("domRange")).toEqual({ start: { cssSelector: "#passage", textNodeIndex: 0, charOffset: 16 }, end: { cssSelector: "#passage", textNodeIndex: 0, charOffset: 29 } });
    const observer = vi.mocked(handle.registerDecorationObserver).mock.calls[0][1];
    const event = { decoration: decorations[0], group, rect: { top: 0, left: 0, width: 1, height: 1 }, point: { x: 0, y: 0 } };
    observer.onDecorationActivated!({ ...event, group: "other" });
    observer.onDecorationActivated!(event);
    expect(listener.mock.calls).toEqual([["good"]]);
    await engine.setAnnotations([]);
    expect(handle.applyDecorations).toHaveBeenLastCalledWith([], group);
    observer.onDecorationActivated!(event);
    expect(listener).toHaveBeenCalledTimes(1);
    await engine.destroy();
    expect(handle.unregisterDecorationObserver).toHaveBeenCalledWith(observer);
    observer.onDecorationActivated!(event);
    expect(listener).toHaveBeenCalledTimes(1);
    iframe.remove();
  });

  it("navigates a verified later quote through a temporary marker and restores original text nodes", async () => {
    const { engine, handle } = await mountEngine();
    const { iframe, doc, send } = addFrame(handle);
    const original = doc.querySelector("p")!.firstChild;
    send.mockImplementation((_key, id, cb) => {
      const marker = doc.getElementById(id)!;
      expect(marker.previousSibling!.textContent).toBe("First 😀 quote. ");
      cb(true);
    });
    expect((await engine.goTo(target)).moved).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(doc.querySelector("p")!.childNodes).toHaveLength(1);
    expect(doc.querySelector("p")!.firstChild).toBe(original);
    expect(doc.querySelector("p")!.textContent).toBe("First 😀 quote. Second quote. End.");
    expect((await engine.getLocator()).locations).not.toHaveProperty("fragment");
    const mismatch = { ...target, text: { ...target.text, before: "incorrect" } };
    expect((await engine.goTo(mismatch)).moved).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    iframe.remove();
  });

  it("activates a cached inactive resource before navigating to its exact passage", async () => {
    const current = new Locator({
      href: chapterTwo,
      type: "application/xhtml+xml",
      locations: new LocatorLocations({ progression: 0.5 }),
    });
    const { engine, handle } = await mountEngine(null, current);
    handle.viewport.readingOrder = [chapterTwo];
    const { iframe, send } = addFrame(handle);

    await expect(engine.goTo(target)).resolves.toMatchObject({ moved: true });

    expect(handle.go).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handle.go).mock.calls[0][0].href).toBe(chapterOne);
    expect(send).toHaveBeenCalledTimes(1);
    iframe.remove();
  });

  it("restores a passage anchor after column and typography changes, serializing with navigation", async () => {
    const anchored = new Locator({ href: chapterOne, type: "application/xhtml+xml", text: new LocatorText({ highlight: "Second quote." }), locations: new LocatorLocations({ progression: 0.25 }) });
    const { engine, handle } = await mountEngine(null, anchored);
    let release!: () => void;
    vi.mocked(handle.submitPreferences).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const layout = engine.setResponsiveLayout({ pageCount: 2 });
    const next = engine.next();
    await Promise.resolve();
    expect(handle.goForward).not.toHaveBeenCalled();
    await expect(engine.next()).resolves.toMatchObject({ moved: false });
    release();
    await layout;
    await next;
    expect(vi.mocked(handle.go).mock.calls[0][0].text?.highlight).toBe("Second quote.");
    await engine.setPreferences(preferences);
    expect(vi.mocked(handle.submitPreferences).mock.calls.at(-1)![0].columnCount).toBe(2);
    await engine.setResponsiveLayout({ pageCount: 1 });
    expect(vi.mocked(handle.submitPreferences).mock.calls.at(-1)![0]).toMatchObject({ columnCount: 1, fontSize: 1.25 });
  });

  it("uses stable positions spanning actual visible boundaries without changing completion", async () => {
    const positions = [0, 0.2, 0.4, 0.6, 0.8].map((progression, index) => ({ href: chapterOne, progression, totalProgression: index / 6, locations: { position: index + 1 } }));
    positions.push({ href: chapterTwo, progression: 0, totalProgression: 5 / 6, locations: { position: 6 } });
    positions.push({ href: chapterThree, progression: 0, totalProgression: 1, locations: { position: 7 } });
    const { engine, calls } = await mountEngine(null, undefined, { infinityBooks: { positions } });
    expect(calls[0].positions).toHaveLength(7);
    expect(await engine.getPositionInfo()).toEqual({ current: 2, end: 4, total: 7 });
    expect((await engine.getLocator()).totalProgression).toBeLessThan(0.99);
    expect(await (await mountEngine()).engine.getPositionInfo()).toBeNull();
    expect(await (await mountEngine(null, undefined, { infinityBooks: { positions: [{ ...positions[0], href: "https://evil.test/" }] } })).engine.getPositionInfo()).toBeNull();
  });

  it("does not resurrect a navigator whose asynchronous creation completes after destroy", async () => {
    const fake = createFakeNavigator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = createReadiumEngine({ fetchManifest: async () => manifestJson, createNavigator: async (input) => { await gate; return fake.createNavigator(input); } });
    const mounting = engine.mount({ container: document.createElement("div"), manifestUrl, initialLocator: null });
    await Promise.resolve();
    await engine.destroy();
    release();
    await mounting;
    expect(fake.handle.load).not.toHaveBeenCalled();
    expect(fake.handle.destroy).toHaveBeenCalledOnce();
    await expect(engine.getLocator()).rejects.toThrow();
  });

  it("captures the visible passage instead of restoring the same fraction after repagination", async () => {
    const { engine, handle } = await mountEngine();
    const { iframe, doc, send } = addFrame(handle);
    Object.defineProperty(doc.createRange().constructor.prototype, "getClientRects", { configurable: true, value: function(this: Range) {
      const visible = this.endOffset > 16;
      return [{ left: visible ? 20 : -200, top: 20, width: 10, height: 10, right: visible ? 30 : -190, bottom: 30 }];
    } });
    const before = await engine.getLocator();
    expect(before.text?.highlight).toBe("Second quote. End.");
    vi.mocked(handle.submitPreferences).mockImplementation(async () => {
      handle.viewport.progressions.set(chapterOne, { start: 0.6, end: 0.9 });
    });
    await engine.setResponsiveLayout({ pageCount: 2 });
    expect(send).toHaveBeenCalledOnce();
    expect((await engine.getLocator()).text?.highlight).toBe("Second quote. End.");
    iframe.remove();
  });

  it("cleans a pending marker on destroy and ignores its late callback on a separate mount", async () => {
    const { engine, handle } = await mountEngine();
    const { iframe, doc, send } = addFrame(handle);
    let finish!: (ok: boolean) => void;
    send.mockImplementation((_key, _id, cb) => { finish = cb; });
    const navigation = engine.goTo(target);
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(doc.querySelector("span")).not.toBeNull();
    await engine.destroy();
    expect(doc.querySelector("span")).toBeNull();
    expect(doc.querySelector("p")!.childNodes).toHaveLength(1);
    const replacement = await mountEngine();
    const listener = vi.fn();
    replacement.engine.setSelectionListener(listener);
    finish(true);
    expect((await navigation).moved).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    iframe.remove();
  });

  it("restores DOM and live selection ranges when marker navigation throws", async () => {
    const { engine, handle } = await mountEngine();
    const { iframe, doc, send } = addFrame(handle);
    const range = doc.createRange();
    range.setStart(doc.querySelector("p")!.firstChild!, 23);
    range.setEnd(doc.querySelector("p")!.firstChild!, 29);
    const selection = iframe.contentWindow!.getSelection()!;
    selection.addRange(range);
    send.mockImplementation(() => { throw new Error("message failed"); });
    await expect(engine.goTo(target)).rejects.toThrow("message failed");
    expect(doc.querySelector("span")).toBeNull();
    expect(doc.querySelector("p")!.childNodes).toHaveLength(1);
    expect(selection.toString()).toBe("quote.");
    iframe.remove();
  });

  it("does not restore a locator after an asynchronous preference submission is destroyed", async () => {
    const { engine, handle } = await mountEngine();
    let finish!: () => void;
    vi.mocked(handle.submitPreferences).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = engine.setResponsiveLayout({ pageCount: 2 });
    await Promise.resolve();
    await engine.destroy();
    finish();
    await pending;
    expect(handle.go).not.toHaveBeenCalled();
  });

  it("settles a navigation on destroy even when the frame never acknowledges it", async () => {
    const { engine, handle } = await mountEngine();
    vi.mocked(handle.goForward).mockImplementation(() => {});
    const navigation = engine.next();
    await Promise.resolve();
    await engine.destroy();
    await expect(navigation).resolves.toMatchObject({ moved: false });
  });

  it("resolves initial text offsets after loading without giving native navigation an ambiguous quote", async () => {
    const fake = createFakeNavigator();
    const { iframe, send } = addFrame(fake.handle);
    const engine = createReadiumEngine({ createNavigator: fake.createNavigator, fetchManifest: async () => manifestJson });
    await engine.mount({ container: document.createElement("div"), manifestUrl, initialLocator: target });
    expect(fake.calls[0].initialPosition?.text).toBeUndefined();
    expect(fake.calls[0].initialPosition?.locations.position).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    iframe.remove();
  });

  it("refuses overlapping explicit turns instead of replaying queued clicks after a resource loads", async () => {
    const { engine, handle, setCurrentLocator } = await mountEngine();
    let finish!: (ok: boolean) => void;
    vi.mocked(handle.goForward).mockImplementation((_animated, cb) => { finish = cb; });
    const first = engine.next();
    await Promise.resolve();
    const second = engine.next();
    // This result must settle before the resource transition acknowledges the first turn.
    await expect(second).resolves.toMatchObject({ moved: false });
    await expect(engine.previous()).resolves.toMatchObject({ moved: false });
    await expect(engine.goTo(target)).resolves.toMatchObject({ moved: false });
    expect(handle.goForward).toHaveBeenCalledOnce();
    expect(handle.goBackward).not.toHaveBeenCalled();
    expect(handle.go).not.toHaveBeenCalled();
    setCurrentLocator(new Locator({ href: chapterTwo, type: "application/xhtml+xml", locations: new LocatorLocations({ progression: 0 }) }));
    finish(true);
    await expect(first).resolves.toMatchObject({ moved: true });
    expect(handle.goForward).toHaveBeenCalledOnce();
  });

  it("releases the pending-navigation flag after a failed request", async () => {
    const { engine, handle } = await mountEngine();
    vi.mocked(handle.goForward).mockImplementationOnce(() => { throw new Error("navigation failed"); });
    await expect(engine.next()).rejects.toThrow("navigation failed");
    await expect(engine.next()).resolves.toMatchObject({ moved: true });
  });
});
