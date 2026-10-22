import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { ReaderClient, type ReaderClientProps, type ReaderCopy } from "@/components/reader/reader-client";
import styles from "@/components/reader/reader-shell.module.css";
import { sendAnalyticsEvent } from "@/lib/analytics/browser";
import { ReaderManifestError } from "@/lib/reader/readium-engine";
import type { ReaderLocator, ReaderSelection, ReaderTocEntry } from "@/lib/reader/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/analytics/browser", () => ({ sendAnalyticsEvent: vi.fn() }));

// The engine module is mocked whole, so `ReaderManifestError` has to be part of the mock: the
// component's `instanceof` check and the class these tests throw must be the same class object.
// It is redeclared here rather than pulled in with `importActual` because the real module imports
// `@readium/shared` at the top level, and loading Readium to get a two-line error class is a lot
// of jsdom for nothing.
const harness = vi.hoisted(() => {
  class MockReaderManifestError extends Error {
    readonly status: number;
    constructor(status: number) {
      super(`The reader manifest request failed with status ${status}.`);
      this.status = status;
      this.name = "ReaderManifestError";
    }
  }

  return {
    MockReaderManifestError,
    // Consumed one entry per engine created, then `mountFailure` applies to every engine after
    // that. This is how a refusal can be made to happen once (recoverable) or always (lost access).
    queuedMountFailures: [] as (Error | null)[],
    mountFailure: null as Error | null,
    // `mount()` never settling is what keeps the reader in its loading phase, which PR #16's
    // regression test depends on.
    mountHangs: false,
    // What getNavigationState resolves to. `canGoForward: false` is "at the last page", which is
    // what the sample end slot renders on.
    navigationState: { canGoForward: true, canGoBackward: false },
    // When set, setPreferences does not settle until this does. Lets a teardown be forced at the
    // exact point in the mount sequence where React 19 Strict Mode tears one down.
    setPreferencesGate: null as Promise<void> | null,
    positionInfo: null as { current: number; end: number; total: number } | null,
    toc: [] as ReaderTocEntry[],
    engines: [] as ReturnType<typeof makeEngine>[],
  };
});

type EngineStub = {
  mount: ReturnType<typeof vi.fn>;
  goTo: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  previous: ReturnType<typeof vi.fn>;
  setPreferences: ReturnType<typeof vi.fn>;
  setSelectionListener: ReturnType<typeof vi.fn>;
  setAnnotationActivationListener: ReturnType<typeof vi.fn>;
  setAnnotations: ReturnType<typeof vi.fn>;
  setResponsiveLayout: ReturnType<typeof vi.fn>;
  getPositionInfo: ReturnType<typeof vi.fn>;
  getLocator: ReturnType<typeof vi.fn>;
  getNavigationState: ReturnType<typeof vi.fn>;
  getTableOfContents: ReturnType<typeof vi.fn>;
  settleSelection: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function makeEngine(): EngineStub {
  const failure = harness.queuedMountFailures.length
    ? harness.queuedMountFailures.shift()
    : harness.mountFailure;

  const engine: EngineStub = {
    mount: vi.fn((options: { initialLocator?: ReaderLocator | null }) => {
      engine.getLocator.mockResolvedValue(options.initialLocator ?? {
        href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {},
      });
      if (harness.mountHangs) return new Promise<void>(() => {});
      return failure ? Promise.reject(failure) : Promise.resolve();
    }),
    goTo: vi.fn().mockResolvedValue({ moved: true, canGoForward: true, canGoBackward: true }),
    next: vi.fn().mockResolvedValue({ moved: true, canGoForward: true, canGoBackward: true }),
    previous: vi.fn().mockResolvedValue({ moved: true, canGoForward: true, canGoBackward: true }),
    setPreferences: vi.fn(() => harness.setPreferencesGate ?? Promise.resolve()),
    setSelectionListener: vi.fn(),
    setAnnotationActivationListener: vi.fn(),
    setAnnotations: vi.fn().mockResolvedValue({ unresolvedIds: [] }),
    setResponsiveLayout: vi.fn().mockResolvedValue(undefined),
    getPositionInfo: vi.fn(() => Promise.resolve(harness.positionInfo)),
    getLocator: vi
      .fn()
      .mockResolvedValue({ href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }),
    getNavigationState: vi.fn(() => Promise.resolve(harness.navigationState)),
    getTableOfContents: vi.fn(() => Promise.resolve(harness.toc)),
    settleSelection: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  return engine;
}

vi.mock("@/lib/reader/readium-engine", () => ({
  ReaderManifestError: harness.MockReaderManifestError,
  createReadiumEngine: () => {
    const engine = makeEngine();
    harness.engines.push(engine);
    return engine;
  },
}));

// The English strings from the dictionary, verbatim. Passed whole because `ReaderCopy` is exactly
// `Dictionary["reader"]` and the assertions below are written against these words.
const copy: ReaderCopy = {
  annotationTooLong: "Select at most 1,000 characters to highlight or add a note.",
  title: "Reader",
  loading: "Opening this book…",
  failed: "This book could not be opened.",
  retry: "Try again",
  nextPage: "Next page",
  previousPage: "Previous page",
  backToLibrary: "Back to library",
  saveFailed: "We couldn't save your place. Your position is still here — you can try again.",
  saveRetry: "Save my place",
  progressLabel: "read",
  settings: "Reading settings",
  settingsTitle: "Reading settings",
  fontSize: "Font size",
  decreaseFontSize: "Smaller text",
  increaseFontSize: "Larger text",
  font: "Font",
  fonts: { publisher: "Publisher", serif: "Lora", sans: "Sans" },
  lineHeight: "Line spacing",
  lineHeights: { tight: "Tight", normal: "Normal", loose: "Loose" },
  width: "Text width",
  widths: { narrow: "Narrow", medium: "Medium", wide: "Wide" },
  theme: "Theme",
  themes: { light: "Light", sepia: "Paper", dark: "Dark" },
  contents: "Contents",
  contentsTitle: "Contents",
  contentsEmpty: "This book has no table of contents.",
  close: "Close",
  lostAccessSignedOut: "You have been signed out. Sign in again to keep reading.",
  lostAccessRevoked: "You no longer have access to this book.",
  signIn: "Sign in",
  goToLibrary: "Go to my library",
  finishedTitle: "You finished this book.",
  finishedBody: "It is marked as finished in your library.",
  dismiss: "Keep reading",
  sampleEndTitle: "That is the end of the sample.",
  sampleEndBody: "Get the full book to keep reading.",
  backToBook: "Back to the book",
  sampleUnavailable: "This sample is not available right now.",
  bookmarks: "Bookmarks", notes: "Notes", highlights: "Highlights", unavailable: "Unavailable", delete: "Delete",
  addBookmark: "Add bookmark", editBookmark: "Edit bookmark", editNote: "Edit note", bookmarkLabel: "Bookmark label", bookmarkFallback: "Bookmark", save: "Save", cancel: "Cancel", note: "Note", yellow: "Yellow", green: "Green", rose: "Rose",
  highlightYellow: "Yellow", highlightGreen: "Green", highlightRose: "Rose", addNote: "Add note", copy: "Copy", share: "Share",
  askInfinity: "Ask Infinity", comingSoon: "Coming soon", copied: "Copied", copyFailed: "Could not copy quote", shareCancelled: "Sharing cancelled",
  quoteTruncated: "Quote shortened to 300 characters", shareUnavailable: "Sharing is unavailable; copied instead.", shareCreated: "A public quote page was created. You can remove it from your library.", sharePublic: "Sharing creates a public quote page you can remove from your library.", emptyBookmarks: "No bookmarks yet.", emptyNotes: "No notes yet.", loadingSavedItems: "Loading saved items…",
  search: "Search this book", searchPlaceholder: "Search words or phrases", searchPrompt: "Type at least 2 characters.", searching: "Searching…", searchEmpty: "No matches found.", searchFailed: "Search is unavailable right now.", untitledChapter: "Untitled chapter",
  annotationsFailed: "Saved items are unavailable right now.", locationUnavailable: "Location unavailable.", page: "Page", pages: "pages", searchOpen: "Search this book", menu: "Reader menu", onePage: "One page", twoPages: "Two pages", relatedBooks: "Continue reading", noRelatedBooks: "No recommendations yet.", rateBook: "Rate this book", askAuthor: "Ask the author", reportError: "Report a translation error", reportHere: "Report an error at this passage",
};

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
  // The console.error in the mount effect's catch is deliberate operational logging; it would
  // otherwise scream through every lost-access test.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  harness.queuedMountFailures.length = 0;
  harness.mountFailure = null;
  harness.mountHangs = false;
  harness.navigationState = { canGoForward: true, canGoBackward: false };
  harness.setPreferencesGate = null;
  harness.positionInfo = null;
  harness.toc = [];
  harness.engines.length = 0;
});

function renderReader(overrides: Partial<ReaderClientProps> = {}) {
  const { unmount } = render(
    <ReaderClient
      askHref="/en/ask?book=book-id"
      authorName="Test author"
      backHref="/en/library"
      bookId="book-id"
      bookTitle="Test book"
      canonicalBookUrl="https://books.example/en/books/test-book"
      copy={copy}
      reviewHref="/en/library/reviews/book-id"
      reportHref={null}
      initialLocator={null}
      libraryHref="/en/library"
      locale="en"
      manifestUrl="/api/reader/publications/publication-id/manifest"
      mode="entitled"
      publicationId="publication-id"
      relatedBooks={[]}
      signInHref="/en/sign-in?next=%2Fen%2Fread%2Fbook-id"
      {...overrides}
    />,
  );

  return {
    unmount,
    get engine() {
      return harness.engines[harness.engines.length - 1];
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function mountRejectsOnceWith(error: Error) {
  harness.queuedMountFailures.push(error);
}

function mountAlwaysRejectsWith(error: Error) {
  harness.mountFailure = error;
}

it("sizes Readium's runtime iframe to the full reader viewport", () => {
  harness.mountHangs = true;
  fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

  renderReader();

  const viewport = screen.getByRole("region", { name: "Reader" });
  expect(viewport).toHaveClass("relative");
  expect(viewport.className).toContain("[&>.readium-navigator-iframe]:inset-0");
  expect(viewport.className).toContain("[&>.readium-navigator-iframe]:h-full");
  expect(viewport.className).toContain("[&>.readium-navigator-iframe]:w-full");
  expect(viewport.className).toContain("[&>.readium-navigator-iframe]:border-0");
});

describe("sample mode", () => {
  // Turning a page is what schedules a save, and the save is debounced: a reader who never moves
  // posts nothing in EITHER mode, so a sample-mode assertion made without this would pass for the
  // wrong reason. The tab-hidden flush is used rather than the 1.5s debounce because it is the one
  // path that flushes immediately, and it reaches the very guard under test.
  async function turnThePageAndFlush() {
    // Waiting for the page controls, not for the region: the region is on screen throughout the
    // loading phase, so asserting there would prove only that nothing had happened yet.
    const nextPage = await screen.findByRole("button", { name: /Next page/ });
    await userEvent.click(nextPage);
    await waitFor(() => expect(harness.engines[0].getLocator).toHaveBeenCalled());

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  }

  it("mints no reader session and saves no progress", async () => {
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });
    await turnThePageAndFlush();

    // The whole sample contract in one assertion: a sample reader is anonymous, so a session POST
    // would 401 and a progress POST would 404, and neither should ever be attempted.
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toContain("/api/reader/");
    }
  });

  // The control for the test above: the same page turn in entitled mode DOES post progress, so the
  // absence proved there is the mode's doing and not the test's.
  it("does post progress in entitled mode after the same page turn", async () => {
    renderReader({ mode: "entitled" });
    await turnThePageAndFlush();

    await waitFor(() => {
      const progressPosts = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes("/api/reader/progress"),
      );
      expect(progressPosts).toHaveLength(1);
    });
  });

  it("does not render or fetch reader-depth controls", async () => {
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });
    await screen.findByRole("button", { name: /Next page/ });

    expect(screen.queryByRole("button", { name: "Search this book" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Contents" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add bookmark" })).toBeNull();
    expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes("/annotations") || String(call[0]).includes("/search"))).toBe(false);
  });

  it("uses the desktop sample canvas without reserving a hidden sidebar column", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });

    const viewport = await screen.findByRole("region", { name: "Reader" });
    const main = viewport.parentElement!;
    const shell = main.parentElement!;

    // A max-width text measure or an empty <aside> would make the sample look like a collapsed
    // entitled spread. The wide engine canvas must own the shell's only track.
    expect(shell.querySelector("aside")).toBeNull();
    expect(shell).toHaveClass(styles.sampleShell);
    expect(shell).not.toHaveClass(styles.entitledShell);
    expect(main).toHaveClass(styles.sampleMain);
    expect(main).toHaveClass("max-w-none");
    expect(main).toHaveClass("w-full");
  });
});

describe("reader depth controller", () => {
  it.each(["pending", "failed"] as const)("retains the specific optimistic note saved after a %s create", async (state) => {
    const creation = deferred<Response>();
    const other = { id: "d0000000-0000-4000-8000-000000000001", publicationId: "c0000000-0000-4000-8000-000000000001", kind: "highlight", selectedText: "Other passage", noteText: "Other note", color: "yellow", locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: "Other passage" } }, createdAt: "now", updatedAt: "now" };
    const selected = { locator: { ...other.locator, text: { highlight: "Target passage" } }, annotationText: "Target passage", text: "Target passage", rect: { x: 10, y: 10, width: 40, height: 20 } };
    const target = { ...other, id: "d0000000-0000-4000-8000-000000000002", selectedText: selected.text, locator: selected.locator, noteText: null };
    let posts = 0;
    fetchSpy.mockImplementation((path, init) => {
      if (init?.method === "POST" && String(path).includes("/annotations")) {
        posts++;
        return posts === 1 ? creation.promise : Promise.resolve(new Response(JSON.stringify({ annotation: { ...target, ...JSON.parse(String(init.body)) } }), { status: 200 }));
      }
      if (init?.method === "PATCH") return Promise.resolve(new Response(JSON.stringify({ annotation: { ...target, ...JSON.parse(String(init.body)) } }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ annotations: [other] }), { status: 200 }));
    });
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    act(() => reader.engine.setSelectionListener.mock.calls[0][0](selected));
    fireEvent.click(await screen.findByRole("button", { name: "Yellow" }));
    await waitFor(() => expect(reader.engine.setAnnotations.mock.calls.at(-1)?.[0]).toHaveLength(2));
    const targetKey = reader.engine.setAnnotations.mock.calls.at(-1)![0].find((item: { id: string }) => item.id !== other.id)!.id;
    if (state === "failed") await act(async () => { creation.resolve(new Response("{}", { status: 502 })); await creation.promise; });
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](targetKey));
    fireEvent.change(await screen.findByRole("textbox", { name: "Note" }), { target: { value: "Keep this target note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Note" })).toBeNull());
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](targetKey));
    expect(await screen.findByRole("textbox", { name: "Note" })).toHaveValue("Keep this target note");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (state === "pending") await act(async () => { creation.resolve(new Response(JSON.stringify({ annotation: target }), { status: 200 })); await creation.promise; });
    else {
      fireEvent.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
      fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    }
    await waitFor(() => expect(reader.engine.setAnnotations.mock.calls.at(-1)![0]).toEqual(expect.arrayContaining([expect.objectContaining({ id: target.id })])));
    const write = fetchSpy.mock.calls.find(([path, init]) => state === "pending" ? init?.method === "PATCH" && String(path).includes(target.id) : init?.method === "POST" && JSON.parse(String(init.body)).noteText === "Keep this target note");
    expect(JSON.parse(String(write?.[1]?.body)).noteText).toBe("Keep this target note");
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](target.id));
    expect(await screen.findByRole("textbox", { name: "Note" })).toHaveValue("Keep this target note");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](other.id));
    expect(await screen.findByRole("textbox", { name: "Note" })).toHaveValue("Other note");
  });

  it("saves verified normalized selection text and decorates an optimistic highlight through failure and retry", async () => {
    const create = deferred<Response>();
    fetchSpy.mockImplementation((path, init) => init?.method === "POST" && String(path).includes("/annotations")
      ? create.promise : Promise.resolve(new Response(JSON.stringify({ annotations: [] }), { status: 200 })));
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const selected = { locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: { cssSelector: "body", textOffset: 0 }, text: { highlight: "First.Second." } }, text: "First.\n\nSecond.", annotationText: "First.Second.", rect: { x: 10, y: 10, width: 40, height: 20 } };
    act(() => reader.engine.setSelectionListener.mock.calls[0][0](selected));
    fireEvent.click(await screen.findByRole("button", { name: "Yellow" }));
    await waitFor(() => expect(reader.engine.setAnnotations.mock.calls.at(-1)?.[0]).toMatchObject([{ locator: selected.locator, color: "yellow" }]));
    const decorationId = reader.engine.setAnnotations.mock.calls.at(-1)![0][0].id;
    const post = fetchSpy.mock.calls.find(([path, init]) => String(path).includes("/annotations") && init?.method === "POST");
    expect(JSON.parse(String(post![1]?.body)).selectedText).toBe("First.Second.");
    await act(async () => { create.resolve(new Response("{}", { status: 502 })); await create.promise; });
    expect(reader.engine.setAnnotations.mock.calls.at(-1)![0][0].id).toBe(decorationId);
    fireEvent.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
    const retry = await screen.findByRole("button", { name: "Try again" });
    const retried = deferred<Response>();
    fetchSpy.mockImplementation((path, init) => init?.method === "POST" && String(path).includes("/annotations") ? retried.promise : Promise.resolve(new Response("{}", { status: 200 })));
    fireEvent.click(retry);
    expect(reader.engine.setAnnotations.mock.calls.at(-1)![0][0].id).toBe(decorationId);
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](decorationId));
    expect(await screen.findByRole("dialog", { name: "Note" })).toBeInTheDocument();
    await act(async () => { retried.resolve(new Response(JSON.stringify({ annotation: { ...JSON.parse(String(post![1]?.body)), id: "d0000000-0000-4000-8000-000000000009", publicationId: "c0000000-0000-4000-8000-000000000001", createdAt: "now", updatedAt: "now" } }), { status: 200 })); await retried.promise; });
    await waitFor(() => expect(reader.engine.setAnnotations.mock.calls.at(-1)![0][0].id).toBe("d0000000-0000-4000-8000-000000000009"));
  });

  it("opens the activated annotation's note among several saved highlights", async () => {
    const row = (suffix: string, noteText: string) => ({ id: `d0000000-0000-4000-8000-00000000000${suffix}`, publicationId: "c0000000-0000-4000-8000-000000000001", kind: "highlight", selectedText: `Passage ${suffix}`, noteText, color: "yellow", locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: `Passage ${suffix}` } }, createdAt: "now", updatedAt: "now" });
    const rows = [row("1", "First note"), row("2", "Specific second note")];
    fetchSpy.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ annotations: rows }), { status: 200 })));
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    act(() => reader.engine.setAnnotationActivationListener.mock.calls[0][0](rows[1].id));
    expect(await screen.findByRole("textbox", { name: "Note" })).toHaveValue("Specific second note");
  });

  it.each([401, 404])("removes private selection and search surfaces after terminal %i", async (status) => {
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    fireEvent.click(screen.getByRole("button", { name: "Search this book" }));
    act(() => reader.engine.setSelectionListener.mock.calls[0][0]({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: "Private passage" } }, annotationText: "Private passage", text: "Private passage", rect: { x: 10, y: 10, width: 40, height: 20 } }));
    fetchSpy.mockResolvedValue(new Response("{}", { status }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "private" } });
    await screen.findByRole("alert");
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Reader menu" })).toBeNull();
  });
  it("refuses overlapping page clicks before queueing a slow turn", async () => {
    const reader = renderReader();
    const next = await screen.findByRole("button", { name: /Next page/ });
    const turn = deferred<{ moved: boolean; canGoForward: boolean; canGoBackward: boolean }>();
    reader.engine.next.mockReturnValueOnce(turn.promise);
    fireEvent.click(next);
    await waitFor(() => expect(reader.engine.next).toHaveBeenCalledTimes(1));
    fireEvent.click(next);
    fireEvent.click(next);
    await act(async () => { turn.resolve({ moved: true, canGoForward: true, canGoBackward: true }); await turn.promise; });
    await waitFor(() => expect(reader.engine.getLocator).toHaveBeenCalledTimes(2));
    expect(reader.engine.next).toHaveBeenCalledTimes(1);
  });
  it("connects a selected passage to the owned selection toolbar", async () => {
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    // Break if the controller stops translating the engine-only listener into visible actions.
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: "A passage" } }, text: "A passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    expect(await screen.findByRole("toolbar", { name: "A passage" })).toBeInTheDocument();
  });

  it("gives the Share mint a 3s timeout and falls back to the book URL when it aborts", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    fetchSpy.mockImplementation((request, init) => String(request).includes("/api/reader/quotes")
      ? new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
      : Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: "A passage" } }, text: "A passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    await user.click(await screen.findByRole("button", { name: "Share" }));
    await waitFor(() => expect(fetchSpy.mock.calls.some(([path]) => String(path).includes("/api/reader/quotes"))).toBe(true));
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
    expect(share).not.toHaveBeenCalled();
    timeout.abort();
    await waitFor(() => expect(share).toHaveBeenCalledOnce());
    expect(share.mock.calls[0][0].text).not.toContain("/q/");
  });

  it("does not turn pages while a search input owns arrow keys", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await user.click(await screen.findByRole("button", { name: "Search this book" }));
    const input = await screen.findByRole("searchbox", { name: "Search this book" });
    input.focus();
    await user.keyboard("{ArrowRight}");
    expect(reader.engine.next).not.toHaveBeenCalled();
  });

  it("lets the selection toolbar own arrow keys without turning the page", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Keyboard passage", rect: { x: 10, y: 10, width: 40, height: 20 } });

    const yellow = await screen.findByRole("button", { name: "Yellow" });
    yellow.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("button", { name: "Green" })).toHaveFocus();
    expect(screen.getByRole("toolbar", { name: "Keyboard passage" })).toBeInTheDocument();
    expect(reader.engine.next).not.toHaveBeenCalled();
  });

  it("keeps a real selection through incidental null events and clears it explicitly with Escape", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Kept passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    expect(await screen.findByRole("toolbar", { name: "Kept passage" })).toBeInTheDocument();

    listener(null);
    expect(screen.getByRole("toolbar", { name: "Kept passage" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("toolbar", { name: "Kept passage" })).toBeNull();
    expect(screen.getByRole("region", { name: "Reader" })).toHaveFocus();
  });

  it("offers an explicit selection dismissal without navigating the engine", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Dismissed passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    await user.click(await screen.findByRole("button", { name: "Keep reading" }));
    expect(screen.queryByRole("toolbar", { name: "Dismissed passage" })).toBeNull();
    expect(reader.engine.goTo).not.toHaveBeenCalled();
  });

  it("offers real desktop layout controls and keeps the sample canvas full width", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const { unmount } = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    expect(screen.getByTestId("reader-shell")).toHaveClass(styles.entitledShell);
    expect(screen.getByTestId("reader-shell")).not.toHaveClass(styles.sampleShell);
    expect(screen.getByRole("button", { name: "One page" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Two pages" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Ask Infinity" })).toBeDisabled();
    unmount();

    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });
    await screen.findByRole("button", { name: /Next page/ });
    expect(screen.getByTestId("reader-shell")).toHaveAttribute("data-reader-mode", "sample");
  });

  it("changes desktop columns on the mounted engine without remounting it", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });

    await user.click(screen.getByRole("button", { name: "One page" }));

    await waitFor(() => expect(reader.engine.setResponsiveLayout).toHaveBeenLastCalledWith({ pageCount: 1 }));
    expect(harness.engines).toHaveLength(1);
    expect(reader.engine.destroy).not.toHaveBeenCalled();
  });

  it("uses the persistent Contents tab on desktop and the drawer on narrow screens", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    const desktop = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("button", { name: "Reader menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Contents" }));
    expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute("aria-selected", "true");
    desktop.unmount();

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("button", { name: "Reader menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Contents" }));
    expect(await screen.findByRole("dialog", { name: "Contents" })).toBeInTheDocument();
  });

  it.each([390, 768])("keeps Settings reachable in the %ipx sample shell without depth actions", async (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });
    await screen.findByRole("button", { name: /Next page/ });

    expect(screen.getByRole("button", { name: "Reading settings" })).not.toHaveClass("hidden");
    expect(screen.queryByRole("button", { name: "Reader menu" })).toBeNull();
  });

  it("loads annotations before the ready position and reapplies them after a responsive reflow", async () => {
    const annotation = {
      id: "d0000000-0000-4000-8000-000000000001",
      publicationId: "c0000000-0000-4000-8000-000000000001",
      kind: "highlight",
      selectedText: "Marked text",
      color: "yellow",
      noteText: null,
      locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {}, text: { highlight: "Marked text" } },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fetchSpy.mockImplementation((request) => Promise.resolve(
      String(request).includes("/annotations")
        ? new Response(JSON.stringify({ annotations: [annotation] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    ));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await waitFor(() => expect(reader.engine.setAnnotations).toHaveBeenCalledWith([
      expect.objectContaining({ id: annotation.id, color: "yellow" }),
    ]));
    expect(reader.engine.setAnnotations.mock.invocationCallOrder[0]).toBeLessThan(
      reader.engine.getPositionInfo.mock.invocationCallOrder[0],
    );

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1400 });
    reader.engine.setResponsiveLayout.mockClear();
    reader.engine.setAnnotations.mockClear();
    reader.engine.getPositionInfo.mockClear();
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(reader.engine.setResponsiveLayout).toHaveBeenLastCalledWith({ pageCount: 2 }));
    await waitFor(() => expect(reader.engine.setAnnotations).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reader.engine.getPositionInfo).toHaveBeenCalledTimes(1));
    expect(reader.engine.setResponsiveLayout.mock.invocationCallOrder[0]).toBeLessThan(
      reader.engine.setAnnotations.mock.invocationCallOrder[0],
    );
    expect(reader.engine.setAnnotations.mock.invocationCallOrder[0]).toBeLessThan(
      reader.engine.getPositionInfo.mock.invocationCallOrder[0],
    );
  });

  it("keeps the search panel open until controller navigation succeeds", async () => {
    const user = userEvent.setup();
    const locator = { href: "c2.xhtml", progression: 0.5, totalProgression: 0.5, locations: { cssSelector: "#target", textOffset: 321 }, text: { before: "before ", highlight: "Found passage", after: " after" } };
    fetchSpy.mockImplementation((request) => Promise.resolve(
      String(request).includes("/search")
        ? new Response(JSON.stringify({ results: [{ chapterTitle: "Chapter two", excerpt: "Found passage", locator }] }), { status: 200 })
        : new Response(JSON.stringify({ annotations: [] }), { status: 200 }),
    ));
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("button", { name: "Search this book" }));
    const dialog = await screen.findByRole("dialog", { name: "Search this book" });
    await user.type(screen.getByRole("searchbox", { name: "Search this book" }), "passage");
    const result = await screen.findByRole("button", { name: "Found passage" });

    reader.engine.goTo.mockResolvedValueOnce({ moved: false, canGoForward: true, canGoBackward: true });
    await user.click(result);
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText("Location unavailable.")).toBeInTheDocument();

    reader.engine.goTo.mockResolvedValueOnce({ moved: true, canGoForward: true, canGoBackward: true });
    reader.engine.getLocator.mockResolvedValueOnce({ href: "c2.xhtml", progression: 0.52, totalProgression: 0.52, locations: { cssSelector: "#page-start" } });
    await user.click(result);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Search this book" })).toBeNull());

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await waitFor(() => {
      const progress = fetchSpy.mock.calls.find(([request, init]) =>
        String(request).includes("/api/reader/progress") && init?.method === "POST",
      );
      expect(progress).toBeDefined();
      expect(JSON.parse(String(progress![1]?.body)).locator).toEqual({
        href: "c2.xhtml",
        progression: 0.52,
        totalProgression: 0.52,
        locations: { cssSelector: "#target", textOffset: 321 },
        text: locator.text,
      });
    });
  });

  it("keeps the Contents drawer open until table-of-contents navigation succeeds", async () => {
    const user = userEvent.setup();
    harness.toc = [{ title: "Chapter two", href: "c2.xhtml", children: [] }];
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("button", { name: "Contents" }));
    const dialog = await screen.findByRole("dialog", { name: "Contents" });
    const entry = screen.getByRole("button", { name: "Chapter two" });

    reader.engine.goTo.mockResolvedValueOnce({ moved: false, canGoForward: true, canGoBackward: true });
    await user.click(entry);
    expect(dialog).toBeInTheDocument();

    reader.engine.goTo.mockResolvedValueOnce({ moved: true, canGoForward: true, canGoBackward: true });
    await user.click(entry);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull());
  });

  it("keeps the narrow saved-items drawer open until saved-item navigation succeeds", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const annotation = {
      id: "d0000000-0000-4000-8000-000000000002", publicationId: "c0000000-0000-4000-8000-000000000001", kind: "bookmark", label: "Saved chapter", locator: { href: "c2.xhtml", progression: 0, totalProgression: 0, locations: {} }, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    };
    fetchSpy.mockImplementation((request) => Promise.resolve(
      String(request).includes("/annotations")
        ? new Response(JSON.stringify({ annotations: [annotation] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    ));
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("button", { name: "Contents" }));
    const dialog = await screen.findByRole("dialog", { name: "Contents" });
    await user.click(screen.getByRole("tab", { name: "Bookmarks (1)" }));
    const saved = screen.getByRole("button", { name: "Saved chapter" });

    reader.engine.goTo.mockResolvedValueOnce({ moved: false, canGoForward: true, canGoBackward: true });
    await user.click(saved);
    expect(dialog).toBeInTheDocument();

    reader.engine.goTo.mockResolvedValueOnce({ moved: true, canGoForward: true, canGoBackward: true });
    await user.click(saved);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull());
  });

  it("captures the opening locator so a bookmark can be saved before the first page turn", async () => {
    const user = userEvent.setup();
    const openingLocator = { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} };
    fetchSpy.mockImplementation((_request, init) => {
      if (init?.method === "POST" && String(_request).includes("/annotations")) {
        const draft = JSON.parse(String(init.body));
        return Promise.resolve(new Response(JSON.stringify({ annotation: {
          ...draft,
          id: "d0000000-0000-4000-8000-000000000003",
          publicationId: "publication-id",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        } }), { status: 201 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ annotations: [] }), { status: 200 }));
    });
    const reader = renderReader();
    reader.engine.getLocator.mockResolvedValue(openingLocator);
    await screen.findByRole("button", { name: /Next page/ });

    await user.click(screen.getByRole("button", { name: "Add bookmark" }));
    await user.clear(screen.getByRole("textbox", { name: "Bookmark label" }));
    await user.type(screen.getByRole("textbox", { name: "Bookmark label" }), "Opening page");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const request = fetchSpy.mock.calls.find(([path, init]) =>
        String(path).includes("/annotations") && init?.method === "POST",
      );
      expect(request).toBeDefined();
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        kind: "bookmark",
        label: "Opening page",
        locator: openingLocator,
      });
    });
  });

  it("dismisses an engine selection when a blocking settings panel opens", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Panel passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    expect(await screen.findByRole("toolbar", { name: "Panel passage" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    expect(await screen.findByRole("dialog", { name: "Reading settings" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Panel passage" })).toBeNull();
  });

  it("dismisses an engine selection when its note editor opens", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const listener = reader.engine.setSelectionListener.mock.calls[0]?.[0] as (selection: ReaderSelection | null) => void;
    listener({ locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Annotated passage", rect: { x: 10, y: 10, width: 40, height: 20 } });
    await screen.findByRole("toolbar", { name: "Annotated passage" });

    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(await screen.findByRole("dialog", { name: "Note" })).toBeInTheDocument();
    expect(screen.queryByRole("toolbar", { name: "Annotated passage" })).toBeNull();
  });

  it.each([
    [401, "You have been signed out. Sign in again to keep reading."],
    [404, "You no longer have access to this book."],
  ])("does not resurrect a ready engine when the opening annotation request loses access (%i)", async (status, message) => {
    fetchSpy.mockImplementation((request) => Promise.resolve(
      String(request).includes("/annotations")
        ? new Response(null, { status })
        : new Response(JSON.stringify({}), { status: 200 }),
    ));
    const reader = renderReader();

    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Next page/ })).toBeNull();
    expect(reader.engine.destroy).toHaveBeenCalled();
  });

  it("keeps annotation-load failure readable and retryable after the reader opens", async () => {
    const user = userEvent.setup();
    fetchSpy.mockImplementation((request) => Promise.resolve(
      String(request).includes("/annotations")
        ? new Response(null, { status: 502 })
        : new Response(JSON.stringify({}), { status: 200 }),
    ));
    renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    await user.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
    expect(screen.getByText("Saved items are unavailable right now.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fetchSpy.mock.calls.filter((call) => String(call[0]).includes("/annotations"))).toHaveLength(2));
  });

  it("hides unknown positions and localizes a singular page label", async () => {
    harness.positionInfo = null;
    const first = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    expect(screen.queryByText(/^Page \d+ \/ \d+$/)).toBeNull();
    first.unmount();

    harness.positionInfo = { current: 2, end: 2, total: 10 };
    renderReader({ copy: { ...copy, page: "Trang", pages: "Trang" } });
    await screen.findByRole("button", { name: /Next page/ });
    expect(screen.getByText("Trang 2 / 10")).toBeInTheDocument();
  });

  it("ignores an activation that no longer belongs to a current annotation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    const activate = reader.engine.setAnnotationActivationListener.mock.calls[0]?.[0] as (id: string) => void;
    act(() => activate("removed-annotation"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("refreshes a localized position after every successful move and guards page arrows inside editable surfaces", async () => {
    const user = userEvent.setup();
    const reader = renderReader();
    await screen.findByRole("button", { name: /Next page/ });
    reader.engine.getPositionInfo.mockResolvedValue({ current: 3, end: 4, total: 10 });
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(reader.engine.getPositionInfo).toHaveBeenCalledTimes(2));
    expect(screen.getByText("pages 3–4 / 10")).toBeInTheDocument();

    const editable = document.createElement("div"); editable.setAttribute("contenteditable", "true");
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog");
    const menu = document.createElement("div"); menu.setAttribute("role", "menu");
    for (const target of [document.createElement("input"), document.createElement("textarea"), editable, dialog, menu]) {
      document.body.append(target);
      fireEvent.keyDown(target, { key: "ArrowRight" });
      target.remove();
    }
    expect(reader.engine.next).toHaveBeenCalledTimes(1);
  });

  it("opens the mobile saved drawer when completion asks for Notes", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderReader({ initialLocator: { href: "c2.xhtml", progression: 1, totalProgression: 1, locations: {} } });
    await screen.findByRole("button", { name: /Next page/ });
    await userEvent.click(screen.getByRole("button", { name: "Notes" }));
    expect(await screen.findByRole("dialog", { name: "Contents" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notes (0)" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("engine lifecycle", () => {
  // React 19 Strict Mode tears an effect down mid-mount on every mount, and the awaits between
  // mount() and `ready` are where that lands. A continuation that ran on past its teardown would
  // query - and then publish into engineRef - an engine that has already been destroyed.
  it("abandons an engine torn down while its preferences are being applied", async () => {
    let releasePreferences: () => void = () => {};
    harness.setPreferencesGate = new Promise<void>((resolve) => {
      releasePreferences = resolve;
    });

    const reader = renderReader({ mode: "entitled" });
    await waitFor(() => expect(harness.engines[0].setPreferences).toHaveBeenCalled());

    reader.unmount();
    releasePreferences();

    await waitFor(() => expect(harness.engines[0].destroy).toHaveBeenCalled());
    expect(harness.engines[0].getTableOfContents).not.toHaveBeenCalled();
    expect(harness.engines[0].getNavigationState).not.toHaveBeenCalled();
  });

  it("starts a keepalive progress flush before releasing the API client on unmount", async () => {
    const progress = deferred<Response>();
    fetchSpy.mockImplementation((request) =>
      String(request).includes("/api/reader/progress")
        ? progress.promise
        : Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    const reader = renderReader({ mode: "entitled" });
    await userEvent.click(await screen.findByRole("button", { name: /Next page/ }));
    await waitFor(() => expect(reader.engine.getLocator).toHaveBeenCalled());

    reader.unmount();

    await waitFor(() => {
      const request = fetchSpy.mock.calls.find((call) =>
        String(call[0]).includes("/api/reader/progress"),
      );
      expect(request?.[1]).toEqual(expect.objectContaining({ method: "POST", keepalive: true }));
    });
    progress.resolve(new Response(JSON.stringify({}), { status: 200 }));
    await progress.promise;
  });
});

describe("the sample end slot", () => {
  const endSlot = <button type="button">Get this book</button>;

  // The regression: `navigation` initialises to `canGoForward: false`, so an ungated end slot is on
  // screen from the first paint - "That is the end of the sample" before the book has even opened,
  // then gone once it has.
  it("stays hidden while the book is still opening", () => {
    harness.mountHangs = true;
    renderReader({ mode: "sample", endSlot });

    expect(screen.queryByText("That is the end of the sample.")).toBeNull();
  });

  it("appears once the reader is at the last page", async () => {
    harness.navigationState = { canGoForward: false, canGoBackward: true };
    renderReader({ mode: "sample", endSlot });

    expect(await screen.findByText("That is the end of the sample.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Get this book" })).toBeInTheDocument();
  });

  it("stays hidden while there are pages left", async () => {
    renderReader({ mode: "sample", endSlot });

    await screen.findByRole("button", { name: /Next page/ });
    expect(screen.queryByText("That is the end of the sample.")).toBeNull();
  });
});

describe("lost access", () => {
  it("re-mints the session once and retries after a manifest 404", async () => {
    mountRejectsOnceWith(new ReaderManifestError(404));
    renderReader({ mode: "entitled" });

    await screen.findByRole("region", { name: "Reader" });
    await vi.waitFor(() => {
      const sessionPosts = fetchSpy.mock.calls.filter((call) =>
        String(call[0]).includes("/api/reader/sessions"),
      );
      expect(sessionPosts).toHaveLength(2);
    });
  });

  it("converges a manifest 401 directly to signed-out without re-minting", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(401));
    renderReader({ mode: "entitled" });

    expect(
      await screen.findByText("You have been signed out. Sign in again to keep reading."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toBeInTheDocument();
    const sessionPosts = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("/api/reader/sessions"),
    );
    expect(sessionPosts).toHaveLength(1);
  });

  it("shows the revoked state for a 404", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(404));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("You no longer have access to this book.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to my library" })).toBeInTheDocument();
  });

  it("keeps lost-access chrome readable in the stored dark theme", async () => {
    window.localStorage.setItem(
      "infinity-books.reader.preferences",
      JSON.stringify({ fontFamily: "publisher", fontScale: 1, lineHeight: 1.6, width: "medium", theme: "dark" }),
    );
    mountAlwaysRejectsWith(new ReaderManifestError(404));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("You no longer have access to this book.")).toHaveClass("text-current");
  });

  it("keeps page-turn controls readable in the stored dark theme", async () => {
    window.localStorage.setItem(
      "infinity-books.reader.preferences",
      JSON.stringify({ fontFamily: "publisher", fontScale: 1, lineHeight: 1.6, width: "medium", theme: "dark" }),
    );

    renderReader();

    const next = await screen.findByRole("button", { name: /Next page/ });
    expect(next).toHaveClass("border-current", "text-current", "disabled:opacity-60");
    expect(next.closest(".min-h-dvh")).toHaveStyle({ "--ring": "var(--ivory)" });
  });

  // An outage is not lost access. Telling a reader their entitlement is gone because a storage
  // bucket hiccuped is the worst possible wrong answer here.
  it("keeps the retryable error for a 502", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(502));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("This book could not be opened.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // Minor 2, a cross-task defect: this branch had no sample-mode coverage at all, so an anonymous
  // visitor whose sample 404'd was told "You no longer have access to this book" under a button
  // labelled "Go to my library" - for a book they never had access to and a library they may not
  // have. A sample reader holds no entitlement to lose and no library to return to.
  it("shows sample-appropriate copy when a sample is refused", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(404));
    renderReader({ mode: "sample", backHref: "/en/books/a-book", libraryHref: "/en/books/a-book" });

    expect(await screen.findByText("This sample is not available right now.")).toBeInTheDocument();
    expect(screen.queryByText("You no longer have access to this book.")).toBeNull();

    // Scoped to the refusal panel: the header's own exit link is also "Back to the book" in
    // sample mode, and it is the control beside the message that has to be the right one.
    const panel = screen.getByRole("alert").parentElement!;
    expect(within(panel).getByRole("link", { name: "Back to the book" })).toHaveAttribute(
      "href",
      "/en/books/a-book",
    );
    expect(screen.queryByRole("link", { name: "Go to my library" })).toBeNull();
  });

  // The 401 branch too: sample mode never mints a session, but a refusal that classifies as
  // signed-out must not offer an anonymous visitor a sign-in wall for public content.
  it("shows the same sample copy for a 401 rather than a sign-in prompt", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(401));
    renderReader({ mode: "sample", backHref: "/en/books/a-book" });

    expect(await screen.findByText("This sample is not available right now.")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  // A failed initial mint is already a definitive refusal; retrying it would create a second
  // session POST before the reader has made even one protected request.
  it("shows the revoked state when the initial session POST 404s", async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));
    renderReader({ mode: "entitled" });

    expect(await screen.findByText("You no longer have access to this book.")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("re-mints and retries a progress save once after a 404", async () => {
    let progressCalls = 0;
    fetchSpy.mockImplementation((request) => {
      const path = String(request);
      if (path.includes("/api/reader/progress")) {
        progressCalls += 1;
        return Promise.resolve(
          progressCalls === 1
            ? new Response(null, { status: 404 })
            : new Response(JSON.stringify({}), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    });
    renderReader({ mode: "entitled" });
    await userEvent.click(await screen.findByRole("button", { name: /Next page/ }));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }

    await waitFor(() => expect(progressCalls).toBe(2));
    const sessionPosts = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes("/api/reader/sessions"),
    );
    expect(sessionPosts).toHaveLength(2);
    expect(screen.queryByText("You no longer have access to this book.")).toBeNull();
  });

  it("tears down reader content when a progress request reports signed-out", async () => {
    fetchSpy.mockImplementation((request) =>
      Promise.resolve(
        String(request).includes("/api/reader/progress")
          ? new Response(null, { status: 401 })
          : new Response(JSON.stringify({}), { status: 200 }),
      ),
    );
    const reader = renderReader({ mode: "entitled" });
    await userEvent.click(await screen.findByRole("button", { name: /Next page/ }));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }

    expect(
      await screen.findByText("You have been signed out. Sign in again to keep reading."),
    ).toBeInTheDocument();
    expect(reader.engine.destroy).toHaveBeenCalled();
  });
});

describe("completion", () => {
  const nearlyDone: ReaderLocator = {
    href: "c9.xhtml",
    progression: 1,
    totalProgression: 1,
    locations: {},
  };

  it("shows the completion card at the end of the book", async () => {
    renderReader({ mode: "entitled", initialLocator: nearlyDone });

    expect(await screen.findByText("You finished this book.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Rate this book" })).toHaveAttribute("href", "/en/library/reviews/book-id");
    expect(screen.getByRole("link", { name: "Ask the author" })).toHaveAttribute("href", "/en/ask?book=book-id");
  });

  it("shows no completion card partway through", async () => {
    renderReader({
      mode: "entitled",
      initialLocator: { href: "c2.xhtml", progression: 0.5, totalProgression: 0.5, locations: {} },
    });

    await screen.findByRole("region", { name: "Reader" });
    expect(screen.queryByText("You finished this book.")).toBeNull();
  });

  // Two contradictory messages at once, under a Keep reading button that does nothing. The card is
  // gated on `phase === "ready"` precisely so a revoked reader near the end never sees this.
  it("shows no completion card when access is gone", async () => {
    mountAlwaysRejectsWith(new ReaderManifestError(404));
    renderReader({ mode: "entitled", initialLocator: nearlyDone });

    expect(await screen.findByText("You no longer have access to this book.")).toBeInTheDocument();
    expect(screen.queryByText("You finished this book.")).toBeNull();
  });

  // Minor 1: the header rounds a raw figure while the completion card reads a raw threshold, and
  // 0.992 falls between them - "99% read" directly above "You finished this book." The library
  // already pins a completed book to 100; the reader must not disagree with it about the same book.
  it("pins the header percentage to 100 once the book is finished", async () => {
    renderReader({
      mode: "entitled",
      initialLocator: { href: "c9.xhtml", progression: 1, totalProgression: 1, locations: {} },
    });

    expect(await screen.findByText("You finished this book.")).toBeInTheDocument();
    expect(screen.getByText("100% read")).toBeInTheDocument();
    expect(screen.queryByText("99% read")).toBeNull();
  });

  it("shows the whole-book sign-in banner in sample mode only, and only when given", async () => {
    const notice = "Sign in to save your progress through each session.";
    const sample = renderReader({ mode: "sample", sampleFullNotice: notice, signInHref: "/vi/sign-in?next=%2Fvi%2Fread-sample%2Fb" });
    await screen.findByRole("region", { name: "Reader" });
    expect(screen.getByRole("link", { name: notice })).toHaveAttribute("href", "/vi/sign-in?next=%2Fvi%2Fread-sample%2Fb");
    sample.unmount();

    const listed = renderReader({ mode: "sample" });
    await screen.findByRole("region", { name: "Reader" });
    expect(screen.queryByTestId("sample-full-notice")).toBeNull();
    listed.unmount();

    renderReader({ mode: "entitled", sampleFullNotice: notice });
    await screen.findByRole("region", { name: "Reader" });
    expect(screen.queryByTestId("sample-full-notice")).toBeNull();
  });

  it("shows no completion card in sample mode", async () => {
    renderReader({ mode: "sample", initialLocator: nearlyDone });

    await screen.findByRole("region", { name: "Reader" });
    expect(screen.queryByText("You finished this book.")).toBeNull();
  });
});

describe("settings", () => {
  it("applies stored preferences to the engine after mounting", async () => {
    window.localStorage.setItem(
      "infinity-books.reader.preferences",
      JSON.stringify({ fontFamily: "sans", fontScale: 1.25, lineHeight: 2, width: "wide", theme: "dark" }),
    );

    const reader = renderReader({ mode: "entitled" });
    await screen.findByRole("region", { name: "Reader" });

    await vi.waitFor(() => {
      expect(reader.engine.setPreferences).toHaveBeenCalledWith({
        fontFamily: "sans",
        fontScale: 1.25,
        lineHeight: 2,
        width: "wide",
        theme: "dark",
      });
    });
  });
});

describe("analytics", () => {
  // The open event is sent from a plain `useEffect` gated on `phase === "ready"`, so it fires in a
  // passive-effect flush that lands after React has already committed the DOM the button appears
  // in. `findByRole` resolves as soon as that DOM commit is visible (its polling/MutationObserver
  // check can win a race against React's passive-effect scheduling, especially under load), so
  // asserting immediately after it can run before the effect has actually called
  // `sendAnalyticsEvent`. `waitFor` gives the effect the room it needs to settle.
  it("records open_reader once the entitled book is on screen", async () => {
    renderReader({ mode: "entitled" });
    expect(sendAnalyticsEvent).not.toHaveBeenCalled();

    await screen.findByRole("button", { name: /Next page/ });

    await waitFor(() => {
      expect(sendAnalyticsEvent).toHaveBeenCalledExactlyOnceWith({
        eventName: "open_reader",
        bookId: "book-id",
        publicationId: "publication-id",
        locale: "en",
      });
    });
  });

  it("records open_sample, with no publication, once the sample is on screen", async () => {
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest", locale: "vi" });

    await screen.findByRole("button", { name: /Next page/ });

    await waitFor(() => {
      expect(sendAnalyticsEvent).toHaveBeenCalledExactlyOnceWith({ eventName: "open_sample", bookId: "book-id", locale: "vi" });
    });
  });

  it("records no open event when the book never opens", async () => {
    mountAlwaysRejectsWith(new harness.MockReaderManifestError(404));
    renderReader({ mode: "entitled" });

    await screen.findByText("You no longer have access to this book.");

    expect(sendAnalyticsEvent).not.toHaveBeenCalled();
  });

  it("records a setting change without any preference data", async () => {
    renderReader({ mode: "entitled" });
    await screen.findByRole("button", { name: /Next page/ });
    // The open_reader event is sent from a passive effect that can still be pending when the
    // button above is already on screen (see the comment on the open-event tests). Waiting for it
    // here before clearing the mock keeps that event from landing after the clear and polluting
    // the change_reader_setting assertion below.
    await waitFor(() => expect(sendAnalyticsEvent).toHaveBeenCalledOnce());
    vi.mocked(sendAnalyticsEvent).mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Reading settings" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));

    expect(sendAnalyticsEvent).toHaveBeenCalledExactlyOnceWith({
      eventName: "change_reader_setting",
      bookId: "book-id",
      publicationId: "publication-id",
      locale: "en",
    });
  });

  it("records no setting change from the anonymous sample reader", async () => {
    // The intake refuses change_reader_setting without a session, and the sample reader is the one
    // reading surface that needs none; sending it would only earn a 401.
    renderReader({ mode: "sample", manifestUrl: "/api/samples/p1/manifest" });
    await screen.findByRole("button", { name: /Next page/ });
    await waitFor(() => expect(sendAnalyticsEvent).toHaveBeenCalledOnce());
    vi.mocked(sendAnalyticsEvent).mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Reading settings" }));
    await userEvent.click(await screen.findByRole("radio", { name: "Dark" }));

    expect(sendAnalyticsEvent).not.toHaveBeenCalled();
  });
});
