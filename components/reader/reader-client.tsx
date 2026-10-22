"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { ProgressLine } from "@/components/brand/progress-line";
import { ReaderAnnotationEditor } from "@/components/reader/reader-annotation-editor";
import { ReaderCompletionPanel } from "@/components/reader/reader-completion-panel";
import { ReaderSearchPanel } from "@/components/reader/reader-search-panel";
import { ReaderSelectionToolbar } from "@/components/reader/reader-selection-toolbar";
import { ReaderSidebar, reportPlaceHref } from "@/components/reader/reader-sidebar";
import { ReaderSettingsPanel } from "@/components/reader/reader-settings-panel";
import { ReaderTocDrawer } from "@/components/reader/reader-toc-drawer";
import { useReaderAnnotations } from "@/components/reader/use-reader-annotations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogPanel, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { sendAnalyticsEvent } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";
import type { ReaderCopy } from "@/lib/reader/copy";
import type { ReaderEngine, ReaderNavigationState } from "@/lib/reader/engine";
import { createReaderApiClient, ReaderApiError } from "@/lib/reader/api-client";
import { DEFAULT_READER_PREFERENCES, READER_WIDTH_CLASS, loadReaderPreferences, saveReaderPreferences } from "@/lib/reader/preferences";
import { ReaderManifestError, createReadiumEngine } from "@/lib/reader/readium-engine";
import { readerPageCount } from "@/lib/reader/layout";
import { chapterTitleFor } from "@/lib/reader/toc";
import type { HighlightColor } from "@/lib/reader/annotations";
import type { ReaderLocator, ReaderPositionInfo, ReaderPreferences, ReaderSelection, ReaderTocEntry } from "@/lib/reader/types";
import styles from "@/components/reader/reader-shell.module.css";

// The only component that touches the reader engine, and the reason `lib/reader/readium-engine.ts`
// stays out of every server and catalog bundle: this file is reached solely through the `ssr: false`
// dynamic import in `reader-mount.tsx`.

export type { ReaderCopy } from "@/lib/reader/copy";

type ReaderClientBaseProps = {
  // "sample" is the public reader: no session is minted, no progress is saved, and the way back is
  // the book page rather than the library. One component rather than two, because the engine
  // lifecycle and PR #16's iframe-sizing contract are exactly the kind of thing that gets fixed in
  // one copy and left broken in the other.
  publicationId: string;
  // Identifiers for the analytics beacon only (S5 spec 8.2). They stay in this component and never
  // reach the ReaderEngine interface, which knows nothing about books, locales, or analytics.
  bookId: string;
  locale: Locale;
  bookTitle: string;
  manifestUrl: string;
  initialLocator: ReaderLocator | null;
  backHref: string;
  // Where to go when access is gone. In entitled mode this is the library; sign-in is derived from
  // the page and passed in so this component never builds a locale-prefixed URL itself.
  libraryHref: string;
  signInHref: string;
  // Rendered after the last page in sample mode: the book's Get or Buy control, built on the
  // server. A ReactNode because BookActionControl needs bound Server Actions, which cannot cross
  // into a client module.
  endSlot?: React.ReactNode;
  copy: ReaderCopy;
  // Where "Report an error" goes; the reader adds the place being read. Null in the sample reader.
  reportHref: string | null;
  // Sample mode only: set when the admin opened the whole edition as a free sample and the visitor is
  // signed out. The text of a banner that links to signInHref.
  sampleFullNotice?: string;
};

export type ReaderClientProps = ReaderClientBaseProps &
  (
    | {
        mode: "entitled";
        authorName: string;
        canonicalBookUrl: string;
        // Null once the book leaves the catalog: the review page 404s for it, so no link is offered.
        reviewHref: string | null;
        askHref: string | null;
        relatedBooks: Array<{ title: string; authorName: string; href: string; coverUrl: string | null }>;
      }
    | {
        mode: "sample";
        authorName?: string;
        canonicalBookUrl?: string;
        reviewHref?: string;
        askHref?: string;
        relatedBooks?: Array<{ title: string; authorName: string; href: string; coverUrl: string | null }>;
      }
  );

type Phase = "loading" | "ready" | "error" | "lost-signed-out" | "lost-revoked";
type SaveState = "idle" | "saving" | "failed";

// Long enough that turning several pages in a row is one save rather than one per page, short
// enough that a reader who closes the tab without using the back link rarely loses more than a
// page. The exit path below does not rely on it: it flushes immediately.
const SAVE_DEBOUNCE_MS = 1500;

const DEVICE_ID_STORAGE_KEY = "infinity-books.reader.device-id";

// A stable label for this browser, used only to tell the reader's own devices apart during
// reconciliation. It authorizes nothing - the server derives the profile from the session - so a
// per-session fallback when storage is unavailable (private mode, blocked cookies) is harmless:
// the worst case is that this browser looks like a new device and its saves are ordered by the
// server clock instead of by its own sequence.
function toPercent(locator: ReaderLocator | null): number {
  const progression = locator?.totalProgression;
  return typeof progression === "number" && Number.isFinite(progression) ? Math.round(progression * 100) : 0;
}

function resolveDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

// 401 and 404 are the only refusals the reader API produces - there is no 403 anywhere on these
// paths, because a distinguishable "exists but forbidden" would be an existence oracle
// (lib/reader/session.ts). 401 means the caller is not signed in; 404 covers a revoked entitlement,
// a superseded publication, and a book that never existed, all deliberately indistinguishable.
// Anything else - 502, a network failure, an engine that could not build its frame pool - is an
// outage, and must NOT be reported as lost access.
function lostAccessPhase(error: unknown): Extract<Phase, "lost-signed-out" | "lost-revoked"> | null {
  const status =
    error instanceof ReaderManifestError || error instanceof ReaderApiError ? error.status : null;
  if (status === 401) return "lost-signed-out";
  if (status === 404) return "lost-revoked";
  return null;
}

export function ReaderClient({
  mode,
  publicationId,
  bookId,
  locale,
  bookTitle,
  manifestUrl,
  initialLocator,
  backHref,
  libraryHref,
  signInHref,
  endSlot,
  copy,
  authorName,
  canonicalBookUrl,
  reviewHref,
  reportHref,
  askHref,
  relatedBooks = [],
  sampleFullNotice,
}: ReaderClientProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const engineRef = useRef<ReaderEngine | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [navigation, setNavigation] = useState<ReaderNavigationState>({
    canGoForward: false,
    canGoBackward: false,
  });
  // Bumped by the retry button to re-run the mount effect. A failed mount is genuinely retryable:
  // the usual cause is an expired reader session, and POST /api/reader/sessions mints a fresh one.
  const [attempt, setAttempt] = useState(0);
  // Whole-book progress for the hairline across the top of the reader (board 1k). Display only:
  // it is read off locators the reader already produces and is never what gets saved.
  const [progressPercent, setProgressPercent] = useState(() => toPercent(initialLocator));
  // Read straight out of localStorage on the first render, which is safe here and nowhere else:
  // this module is reached only through `reader-mount.tsx`'s `next/dynamic` with `ssr: false`, so
  // there is no server render to disagree with and no hydration pass. `loadReaderPreferences`
  // never throws, so a browser that refuses storage simply gets the defaults.
  const [preferences, setPreferences] = useState<ReaderPreferences>(() =>
    typeof window === "undefined" ? DEFAULT_READER_PREFERENCES : loadReaderPreferences(),
  );
  const [toc, setToc] = useState<ReaderTocEntry[]>([]);
  const [currentHref, setCurrentHref] = useState<string | null>(initialLocator?.href ?? null);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const [totalProgression, setTotalProgression] = useState<number | null>(
    initialLocator?.totalProgression ?? null,
  );
  // One silent re-mint per mount attempt. A session that merely expired mid-book must recover
  // without interrupting the reader; a second failure is a real loss of access.
  const remintedRef = useRef(false);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [positionInfo, setPositionInfo] = useState<ReaderPositionInfo | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [desktopPageChoice, setDesktopPageChoice] = useState<1 | 2>(2);
  const desktopPageChoiceRef = useRef(desktopPageChoice);
  const [sidebarTab, setSidebarTab] = useState<"contents" | "bookmarks" | "notes">("contents");
  const [locationMessage, setLocationMessage] = useState("");
  const [editor, setEditor] = useState<{ mode: "bookmark" | "note"; key?: string; selection?: ReaderSelection } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // The position to open at. Seeded from the server's stored locator and then kept current as the
  // reader moves, so a retry after a failed mount resumes where they actually are rather than
  // rewinding to where the page was first rendered.
  //
  // This is a ref, and `initialLocator` is deliberately NOT in the mount effect's dependency
  // array. A locator is an object, so its identity changes on every parent render; listing it
  // would re-run the effect on renders where nothing about the book changed, tearing down and
  // rebuilding a single-use engine each time. The effect is keyed only on primitives.
  const locatorRef = useRef<ReaderLocator | null>(initialLocator);

  // Same rule, same reason: `preferences` is an object, so listing it in the mount effect's
  // dependency array would tear down and rebuild the engine on every preference change. A reader
  // nudging the font size must never remount their book. The mount effect reads the current value
  // through this ref instead.
  const preferencesRef = useRef(preferences);

  // The last position not yet accepted by the server. Held across a failed save so the retry
  // button has something to send, and cleared only when a save actually succeeds.
  const pendingRef = useRef<ReaderLocator | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const sharedRemintRef = useRef<Promise<void> | null>(null);
  const skipNextInitialMintRef = useRef(false);
  const accessLostRef = useRef(false);

  function deviceId(): string {
    deviceIdRef.current ??= resolveDeviceId();
    return deviceIdRef.current;
  }

  // Monotonic per device, and monotonic *across reloads*, which a counter starting at zero would
  // not be: after a refresh its first save would carry a sequence lower than the one already
  // stored and the server would correctly refuse it, silently breaking saving for the rest of the
  // session. Wall-clock milliseconds are already monotonic across reloads; the max() keeps two
  // saves in the same millisecond strictly increasing.
  function nextSequence(): number {
    const next = Math.max(Date.now(), sequenceRef.current + 1);
    sequenceRef.current = next;
    return next;
  }

  // Kept in step in an effect rather than by assigning during render, which the lint rules reject
  // and which React does not guarantee for a render that is thrown away. Declared before the mount
  // effect so the ref is already current when that effect first runs.
  useEffect(() => {
    preferencesRef.current = preferences;
  }, [preferences]);

  useEffect(() => {
    desktopPageChoiceRef.current = desktopPageChoice;
  }, [desktopPageChoice]);

  const mintSession = useCallback(async (): Promise<void> => {
    if (mode === "sample") return;
    const session = await fetch("/api/reader/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ publicationId }),
    });
    if (!session.ok) throw new ReaderApiError(session.status);
  }, [mode, publicationId]);

  // Engine refusals and annotation/search/progress refusals all reach this function. Keeping the
  // promise here, outside either caller, means simultaneous 404s still mint only one cookie.
  const remintSession = useCallback((): Promise<void> => {
    if (sharedRemintRef.current) return sharedRemintRef.current;
    const current = mintSession();
    sharedRemintRef.current = current;
    void current.then(
      () => {
        if (sharedRemintRef.current === current) sharedRemintRef.current = null;
      },
      () => {
        if (sharedRemintRef.current === current) sharedRemintRef.current = null;
      },
    );
    return current;
  }, [mintSession]);

  const onLostAccess = useCallback((status: 401 | 404) => {
    accessLostRef.current = true;
    pendingRef.current = null;
    locatorRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const engine = engineRef.current;
    engineRef.current = null;
    if (engine) void engine.destroy();
    setToc([]);
    setSelection(null);
    setEditor(null);
    setDrawerOpen(false);
    setSearchOpen(false);
    setSettingsOpen(false);
    setMenuOpen(false);
    setPositionInfo(null);
    setLocationMessage("");
    setCurrentHref(null);
    setNavigation({ canGoForward: false, canGoBackward: false });
    setTotalProgression(null);
    setSaveState("idle");
    setPhase(status === 401 ? "lost-signed-out" : "lost-revoked");
  }, []);

  // Task 8 deliberately does not mount annotation/search surfaces. The entitled controller owns
  // their shared request path now, ready for Task 10; sample mode never even creates that path.
  const readerApiClientRef = useRef<ReturnType<typeof createReaderApiClient> | null>(null);
  const engineQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pageTurnPendingRef = useRef(false);
  const appliedPageCountRef = useRef<1 | 2 | null>(null);
  const appliedAnnotationSignatureRef = useRef<string | null>(null);

  const request = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (accessLostRef.current) throw new ReaderApiError(404);
    const client = readerApiClientRef.current;
    if (!client) throw new ReaderApiError(502);
    return client.request<T>(path, init);
  }, []);
  // S16: the toolbar hands back the selection; this mints the card through the reader session.
  const createShareUrl = useCallback(async (quote: string): Promise<string | null> => {
    const result = await request<{ url: string }>(`/api/reader/quotes?publicationId=${publicationId}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote, locale }),
      // Sharing must never block on an unavailable server: give up after 3s and let the toolbar fall back.
      signal: AbortSignal.timeout(3000),
    });
    return typeof result.url === "string" ? result.url : null;
  }, [locale, publicationId, request]);
  // Entitled annotations deliberately begin while the engine mounts. The controller awaits this
  // first result before it publishes ready, so the opening passage and its highlights agree.
  const depthEnabled = mode === "entitled" && phase !== "lost-signed-out" && phase !== "lost-revoked";
  const annotations = useReaderAnnotations({ publicationId, enabled: depthEnabled, request, autoLoad: false });
  const { items: annotationItems, reload: reloadAnnotations, setUnresolvedIds } = annotations;
  const annotationItemsRef = useRef(annotationItems);
  useEffect(() => { annotationItemsRef.current = annotationItems; }, [annotationItems]);

  const serializeEngine = useCallback(<T,>(engine: ReaderEngine, work: () => Promise<T>): Promise<T> => {
    const result = engineQueueRef.current.then(work, work);
    engineQueueRef.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const annotationDecorations = useCallback((items: typeof annotationItems) =>
    items.flatMap((item) => item.annotation.kind === "highlight"
      ? [{ id: "id" in item.annotation ? item.annotation.id : item.key, locator: item.annotation.locator, color: item.annotation.color }]
      : []), []);

  const applyAnnotations = useCallback(async (engine: ReaderEngine, items: typeof annotationItems, force = false) => {
    if (accessLostRef.current) return;
    const decorations = annotationDecorations(items);
    const signature = JSON.stringify(decorations);
    if (!force && appliedAnnotationSignatureRef.current === signature) return;
    const rendered = await engine.setAnnotations(decorations);
    appliedAnnotationSignatureRef.current = signature;
    setUnresolvedIds(rendered.unresolvedIds);
  }, [annotationDecorations, setUnresolvedIds]);

  // Sends whatever position is outstanding. Returns true when the server has it.
  //
  // `keepalive` lets the request outlive a page that is going away, which is what makes the
  // visibility flush below worth attempting - but nothing here treats it as proof of delivery:
  // the pending locator is cleared only on a response that actually arrived and was ok.
  const flush = useCallback(
    async (options: { keepalive?: boolean } = {}): Promise<boolean> => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const locator = pendingRef.current;
      // A sample reader has no entitlement and no session, so /api/reader/progress would 404. It
      // also has nothing worth keeping: a sample is a few resources with no place to return to.
      // One guard at the single exit rather than at each of the four call sites.
      if (!locator || mode === "sample") return true;

      setSaveState("saving");
      try {
        const readerApiClient = readerApiClientRef.current;
        if (!readerApiClient) return true;
        await readerApiClient.request<unknown>("/api/reader/progress", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          keepalive: options.keepalive ?? false,
          body: JSON.stringify({
            publicationId,
            locator,
            deviceId: deviceId(),
            clientSequence: nextSequence(),
          }),
        });

        // Only the locator this call actually sent is cleared. A newer position recorded while
        // the request was in flight must survive, or a fast reader loses the page they are on.
        if (pendingRef.current === locator) pendingRef.current = null;
        setSaveState("idle");
        return true;
      } catch {
        if (accessLostRef.current) return false;
        // Non-blocking on purpose: the reader keeps reading, the position stays in memory, and
        // the retry control appears. Nothing here interrupts them.
        setSaveState("failed");
        return false;
      }
    },
    [mode, publicationId],
  );

  const scheduleSave = useCallback(
    (locator: ReaderLocator) => {
      pendingRef.current = locator;
      locatorRef.current = locator;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // A fresh engine every run, never a reused one. `mount()` on an engine that has been
    // destroyed throws "already mounted" (the adapter latches `released`), so the lifecycle is:
    // one engine per effect run, destroyed by this effect's cleanup, and never touched again.
    // The retry button re-runs the effect rather than remounting the existing engine, which is
    // what keeps that rule true.
    const engine = createReadiumEngine();
    let cancelled = false;
    setPhase("loading");

    void (async () => {
      let reachedManifest = false;
      try {
        if (skipNextInitialMintRef.current) skipNextInitialMintRef.current = false;
        else await mintSession();
        if (cancelled) return;

        reachedManifest = true;
        await engine.mount({ container, manifestUrl, initialLocator: locatorRef.current });
        if (cancelled) {
          // The effect was torn down while mount() was still in flight - React 19 Strict Mode does
          // exactly this on every mount. The cleanup below already ran, so nothing else will
          // release this navigator; destroying it here is what stops it leaking an iframe pool.
          void engine.destroy();
          return;
        }

        // Applied before `ready`, so the restored locator is resolved against the typography the
        // reader actually uses. Applying them after the first paint would render the opening page
        // at the defaults and then jump, which reads as a bug.
        await engine.setPreferences(preferencesRef.current);
        // Checked again after every await on the way to `ready`, not just after mount(). Strict
        // Mode tears down precisely here, and a stale continuation that reached the lines below
        // would publish a destroyed engine into engineRef - clobbering the engine the second run
        // is building - and then flip phase to "ready", after which move() and goToHref drive a
        // released navigator.
        if (cancelled) {
          void engine.destroy();
          return;
        }

        // The engine owns the Readium listeners; the controller turns their neutral events into
        // UI state. Selection is deliberately not persisted and is cleared only by an explicit
        // dismissal/navigation/blocking editor transition.
        engine.setSelectionListener((nextSelection) => {
          // Readium emits null for incidental iframe focus changes. A selection remains actionable
          // until the reader explicitly dismisses it, navigates, presses Escape, or opens a panel.
          if (!cancelled && !accessLostRef.current && nextSelection) setSelection(nextSelection);
        });
        engine.setAnnotationActivationListener((id) => {
          if (!cancelled && !accessLostRef.current) {
            const item = annotationItemsRef.current.find((candidate) => candidate.key === id || ("id" in candidate.annotation && candidate.annotation.id === id));
            if (!item) return;
            setSelection(null);
            setEditor({ mode: "note", key: item.key });
            setLocationMessage("");
          }
        });
        const initialPageCount = readerPageCount(window.innerWidth, desktopPageChoiceRef.current);
        await engine.setResponsiveLayout({ pageCount: initialPageCount });
        appliedPageCountRef.current = initialPageCount;
        // The hook began this request during loading. Awaiting its settled result keeps an
        // annotation outage scoped to the sidebar while still ensuring a successful opening
        // render has its real decorations before position/ready are published.
        const openingAnnotations = mode === "entitled" ? await reloadAnnotations() : [];
        if (cancelled) {
          void engine.destroy();
          return;
        }
        await applyAnnotations(engine, openingAnnotations, true);
        // A reader opened without stored progress still has a real engine position. Capture it
        // before publishing `ready` so "Add bookmark" works on the opening page, before the first
        // page turn has had a chance to seed locatorRef through scheduleSave().
        const [entries, state, positions, openingLocator] = await Promise.all([
          engine.getTableOfContents(),
          engine.getNavigationState(),
          engine.getPositionInfo(),
          engine.getLocator(),
        ]);
        // Published into engineRef only once nothing is left to await. The cleanup nulls that ref
        // as it runs, so an assignment after a teardown would resurrect a destroyed engine for
        // move() and goToHref to drive.
        if (cancelled) {
          void engine.destroy();
          return;
        }

        engineRef.current = engine;
        locatorRef.current = openingLocator;
        setToc(entries);
        setNavigation(state);
        setPositionInfo(positions);
        setProgressPercent(toPercent(openingLocator));
        setCurrentHref(openingLocator.href);
        setTotalProgression(openingLocator.totalProgression);
        setPhase("ready");
      } catch (error) {
        // Logged, not swallowed. The reader is shown a message with a way forward, which is right
        // for them - but a mount failure has several very different causes (an expired session, a
        // refused manifest, an engine that could not build its frame pool) and the rendered page
        // deliberately cannot tell a revoked entitlement from a book that never existed. This is
        // the browser console only; nothing about the failure reaches the rendered page.
        console.error("Reader engine failed to mount", error);
        if (cancelled || accessLostRef.current) {
          void engine.destroy();
          return;
        }

        const lost = lostAccessPhase(error);
        if (lost === "lost-signed-out") {
          onLostAccess(401);
          return;
        }
        if (lost === "lost-revoked") {
          // A 404 from the initial mint is already a definitive denial. A protected manifest or
          // resource can instead be carrying an expired cookie, so it gets one silent re-mint.
          if (mode === "entitled" && reachedManifest && !remintedRef.current) {
            remintedRef.current = true;
            try {
              await remintSession();
              if (cancelled) return;
              skipNextInitialMintRef.current = true;
              setAttempt((value) => value + 1);
            } catch (remintError) {
              if (cancelled) return;
              const remintLost = lostAccessPhase(remintError);
              if (remintLost === "lost-signed-out") onLostAccess(401);
              else if (remintError instanceof ReaderApiError && remintError.status === 502) setPhase("error");
              else onLostAccess(404);
            }
            return;
          }
          onLostAccess(404);
          return;
        }
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Best effort only, and never awaited - a cleanup function cannot be async. The reliable
      // path is the back-to-library control below, which awaits the save before navigating.
      if (pendingRef.current) void flush({ keepalive: true });
      // Safe whether or not mount() got as far as creating a navigator, and safe to call twice.
      void engine.destroy();
    };
  }, [manifestUrl, mode, publicationId, attempt, flush, mintSession, onLostAccess, remintSession, reloadAnnotations, applyAnnotations]);

  // Declared after the engine lifecycle effect so React starts its cleanup first. That cleanup
  // can then hand a final keepalive save to this client before the following cleanup releases it.
  // Lost-access teardown remains immediate because onLostAccess clears pendingRef before either
  // lifecycle cleanup can attempt a save.
  useEffect(() => {
    const client =
      mode === "sample"
        ? null
        : createReaderApiClient({ publicationId, remint: remintSession, onLostAccess });
    readerApiClientRef.current = client;
    return () => {
      if (readerApiClientRef.current === client) readerApiClientRef.current = null;
    };
  }, [mode, onLostAccess, publicationId, remintSession]);

  useEffect(() => {
    function onResize() { setViewportWidth(window.innerWidth); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Responsive columns are an adapter operation, never two shell iframes. Queue this beside page
  // turns so a reflow restores the same passage before a subsequent navigation can proceed.
  useEffect(() => {
    const engine = engineRef.current;
    if (phase !== "ready" || !engine) return;
    const pageCount = readerPageCount(viewportWidth, desktopPageChoice);
    if (appliedPageCountRef.current === pageCount) return;
    let cancelled = false;
    void serializeEngine(engine, async () => {
      if (cancelled || accessLostRef.current || engineRef.current !== engine) return;
      await engine.setResponsiveLayout({ pageCount });
      if (cancelled || engineRef.current !== engine) return;
      appliedPageCountRef.current = pageCount;
      // A layout changes the pagination map, so it must re-render decorations and derive the
      // visible position from the reflowed engine in one serialized transaction.
      await applyAnnotations(engine, annotationItems, true);
      if (cancelled || engineRef.current !== engine) return;
      setPositionInfo(await engine.getPositionInfo());
    });
    return () => { cancelled = true; };
  }, [annotationItems, applyAnnotations, desktopPageChoice, phase, serializeEngine, viewportWidth]);

  // Decoration updates are deliberately separate from responsive layout. An annotation load or
  // unresolved-status update must never reflow the book: doing so during a page turn can restore
  // a stale passage and make the reader skip ahead.
  useEffect(() => {
    const engine = engineRef.current;
    if (phase !== "ready" || !engine) return;
    let cancelled = false;
    void serializeEngine(engine, async () => {
      if (cancelled || accessLostRef.current || engineRef.current !== engine) return;
      await applyAnnotations(engine, annotationItems);
      if (cancelled || engineRef.current !== engine) return;
    });
    return () => { cancelled = true; };
  }, [annotationItems, applyAnnotations, phase, serializeEngine]);

  // A tab being hidden is the closest thing to "the reader is leaving" that the browser offers
  // without a real navigation. Attempted, not relied on.
  useEffect(() => {
    function onHidden() {
      if (document.visibilityState === "hidden" && pendingRef.current) {
        void flush({ keepalive: true });
      }
    }
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [flush]);

  const move = useCallback(
    async (direction: "next" | "previous"): Promise<boolean> => {
      const engine = engineRef.current;
      if (!engine || pageTurnPendingRef.current) return false;
      pageTurnPendingRef.current = true;
      try {
        const result = await serializeEngine(engine, () => direction === "next" ? engine.next() : engine.previous());

        // The engine may have been torn down while the move was settling; anything below would be
        // acting on a released navigator.
        if (engineRef.current !== engine) return false;

        setNavigation({ canGoForward: result.canGoForward, canGoBackward: result.canGoBackward });

        // A refused move (already at the last page) changed nothing, so there is nothing to save.
        // Being able to tell that apart from a successful move is exactly what ADR-005's gap (a)
        // cost, and why the interface now reports it.
        if (!result.moved) return false;

        const locator = await serializeEngine(engine, () => engine.getLocator());
        if (engineRef.current !== engine) return false;
        setProgressPercent(toPercent(locator));
        setCurrentHref(locator.href);
        setTotalProgression(locator.totalProgression);
        const positions = await serializeEngine(engine, () => engine.getPositionInfo());
        if (engineRef.current !== engine) return false;
        setPositionInfo(positions);
        setSelection(null);
        setLocationMessage("");
        scheduleSave(locator);
        return true;
      } finally {
        pageTurnPendingRef.current = false;
      }
    },
    [scheduleSave, serializeEngine],
  );

  const goToHref = useCallback(
    async (href: string): Promise<boolean> => {
      const engine = engineRef.current;
      if (!engine) return false;

      // A toc href carries the fragment the nav entry pointed at; the rest of the locator is what
      // the engine works out for itself once it lands.
      const result = await serializeEngine(engine, () => engine.goTo({ href, progression: 0, totalProgression: null, locations: {} }));
      if (engineRef.current !== engine) return false;

      setNavigation({ canGoForward: result.canGoForward, canGoBackward: result.canGoBackward });
      if (!result.moved) { setLocationMessage(copy.locationUnavailable); return false; }

      const locator = await serializeEngine(engine, () => engine.getLocator());
      if (engineRef.current !== engine) return false;
      setProgressPercent(toPercent(locator));
      setCurrentHref(locator.href);
      setTotalProgression(locator.totalProgression);
      const positions = await serializeEngine(engine, () => engine.getPositionInfo());
      if (engineRef.current !== engine) return false;
      setPositionInfo(positions);
      setSelection(null);
      setLocationMessage("");
      // Sample mode has nothing to save; flush is a no-op there.
      scheduleSave(locator);
      return true;
    },
    [copy.locationUnavailable, scheduleSave, serializeEngine],
  );

  const goToLocator = useCallback(async (locator: ReaderLocator): Promise<boolean> => {
    const engine = engineRef.current;
    if (!engine) return false;
    const result = await serializeEngine(engine, () => engine.goTo(locator));
    if (engineRef.current !== engine) return false;
    setNavigation({ canGoForward: result.canGoForward, canGoBackward: result.canGoBackward });
    if (!result.moved) { setLocationMessage(copy.locationUnavailable); return false; }
    const returned = await serializeEngine(engine, () => engine.getLocator());
    if (engineRef.current !== engine) return false;
    setProgressPercent(toPercent(returned)); setCurrentHref(returned.href); setTotalProgression(returned.totalProgression);
    const positions = await serializeEngine(engine, () => engine.getPositionInfo());
    if (engineRef.current !== engine) return false;
    setPositionInfo(positions);
    // The navigator reports the visible page after an exact text-anchor jump, but it does not
    // echo the verified textOffset/quote that disambiguated two identical occurrences. Preserve
    // that stable anchor while taking progression from the live engine. A bookmark created next
    // then reopens the same occurrence rather than merely the same page/chapter.
    const persisted = locator.locations.textOffset === undefined
      ? returned
      : {
          ...locator,
          progression: returned.progression,
          totalProgression: returned.totalProgression,
        };
    setSelection(null); setLocationMessage(""); scheduleSave(persisted);
    return true;
  }, [copy.locationUnavailable, scheduleSave, serializeEngine]);

  // One open event per reader page, sent the first time the book is actually on screen: a mount
  // that fails, or one Strict Mode tears down, never reaches `ready` and so records nothing. Kept
  // out of the mount effect so these props never join its dependency list and remount the engine.
  const openedRef = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || openedRef.current) return;
    openedRef.current = true;
    sendAnalyticsEvent(
      mode === "sample"
        ? { eventName: "open_sample", bookId, locale }
        : { eventName: "open_reader", bookId, publicationId, locale },
    );
  }, [phase, mode, bookId, publicationId, locale]);

  const changePreferences = useCallback(
    (next: ReaderPreferences) => {
      if (accessLostRef.current) return;
      setPreferences(next);
      saveReaderPreferences(next);
      // Not awaited and not guarded on the engine being present: a preference change while the
      // engine is still mounting is applied by the mount effect itself from preferencesRef.
      const engine = engineRef.current;
      if (engine) void serializeEngine(engine, async () => { if (!accessLostRef.current && engineRef.current === engine) await engine.setPreferences(next); });
      // That a setting changed, and nothing about which one or its new value. Entitled reading only:
      // the intake accepts this event from a signed-in session alone, and the sample reader needs none.
      if (mode !== "sample") {
        sendAnalyticsEvent({ eventName: "change_reader_setting", bookId, publicationId, locale });
      }
    },
    [mode, bookId, publicationId, locale, serializeEngine],
  );

  const exitToLibrary = useCallback(
    async (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle modified clicks (new tab, download) as it normally would.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      // Awaited, not a beacon: this is the one moment the reader has told us they are leaving,
      // so the save gets a normal request whose outcome we actually observe. A failure keeps them
      // here with the retry control rather than navigating away and losing the position.
      const saved = await flush();
      if (saved) router.push(backHref);
    },
    [backHref, flush, router],
  );

  const lostAccess = phase === "lost-signed-out" || phase === "lost-revoked";
  const chapterTitle = chapterTitleFor(toc, currentHref);
  // A sample has no entitlement and no stored progress, so "finished" is not a thing it can be;
  // reaching the end of a sample is the end slot's business, not the completion card's.
  //
  // Gated on `ready` for two reasons. `totalProgression` is seeded from `initialLocator` before the
  // engine has resolved anything, so without this the card flashes during `loading`; and a reader
  // at >= 0.99 whose entitlement was revoked would otherwise be told "You no longer have access to
  // this book" and "You finished this book" at once, under a Keep reading button that does nothing.
  const finished =
    mode === "entitled" &&
    phase === "ready" &&
    typeof totalProgression === "number" &&
    totalProgression === 1;

  // The same reconciliation lib/data/library.ts makes, for the same reason: the threshold is a raw
  // figure that need not land on a percent boundary, and a locator stored by an older client can
  // sit at 0.9917 - finished, but rounding to 99. "99% read" in the header directly above "You
  // finished this book." is the contradiction. The state leads and the number follows it.
  const displayedPercent = finished ? 100 : progressPercent;
  const readerSidebar = (afterNavigate?: () => void) => (
    <ReaderSidebar
      activeTab={sidebarTab}
      copy={copy}
      currentHref={currentHref}
      currentProgression={totalProgression}
      dark={preferences.theme === "dark"}
      entries={toc}
      items={annotations.items}
      loadState={annotations.loadState}
      onDelete={(key) => void annotations.remove(key)}
      onEditBookmark={(key) => { setSelection(null); setEditor({ mode: "bookmark", key }); }}
      onEditNote={(key) => { setSelection(null); setEditor({ mode: "note", key }); }}
      onNavigate={async (locator) => { if (await goToLocator(locator)) afterNavigate?.(); }}
      onNavigateToc={async (href) => { if (await goToHref(href)) afterNavigate?.(); }}
      onRecolor={(key, color) => void annotations.update(key, { kind: "highlight", color })}
      onRetry={(key) => void annotations.retry(key)}
      onRetryLoad={() => void annotations.reload()}
      onTabChange={setSidebarTab}
      reportHref={reportHref}
    />
  );
  const saveEditor = (value: string | null) => {
    if (!editor) return;
    if (editor.mode === "bookmark") {
      if (editor.key) void annotations.update(editor.key, { kind: "bookmark", label: value ?? copy.bookmarkFallback });
      else if (locatorRef.current) void annotations.create({ kind: "bookmark", label: value ?? copy.bookmarkFallback, locator: locatorRef.current });
    } else if (editor.key) {
      void annotations.update(editor.key, { kind: "highlight", noteText: value });
    } else if (editor.selection) {
      void annotations.create({ kind: "highlight", locator: editor.selection.locator, selectedText: editor.selection.annotationText ?? editor.selection.locator.text?.highlight ?? editor.selection.text, color: "yellow", noteText: value });
    }
    setEditor(null);
  };
  const editingItem = editor?.key ? annotations.items.find((item) => item.key === editor.key) : undefined;
  const editorInitialValue = editingItem
    ? editingItem.annotation.kind === "bookmark"
      ? editingItem.annotation.label
      : editingItem.annotation.noteText
    : undefined;

  const dismissSelection = useCallback(() => {
    setSelection(null);
    containerRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        dismissSelection();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target as HTMLElement | null;
      // Arrow keys inside controls belong to that control. In particular, the selection toolbar
      // uses them for roving focus; letting the event reach this shortcut turned the page and
      // dismissed the selection after focus moved (observable as a Firefox-only race).
      if (target?.closest("button, a, input, textarea, select, [role=dialog], [role=menu], [role=toolbar], [contenteditable]")) return;
      event.preventDefault();
      void move(event.key === "ArrowRight" ? "next" : "previous");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissSelection, move]);

  // Board 1k: a white reading surface with quiet chrome - a progress hairline, a top bar with the
  // way back, the book title and the two panels, the text column, and page controls at the foot.
  return (
    <div
      className={`flex min-h-dvh flex-col ${preferences.theme === "dark" ? "bg-ink text-ivory" : preferences.theme === "sepia" ? "bg-sand text-ink" : "bg-white text-ink"}`}
      style={preferences.theme === "dark" ? { "--ring": "var(--ivory)" } as CSSProperties : undefined}
    >
      <ProgressLine className="bg-transparent" percent={displayedPercent} />
      <header className="grid min-h-[3.75rem] grid-cols-[auto_1fr_auto] items-center gap-2 px-4 sm:px-8">
        {/* Rendered here rather than on the page so leaving can flush the position first. */}
        <a
          className="inline-flex min-h-11 items-center gap-1.5 text-[0.84375rem] font-medium text-current hover:text-forest"
          href={backHref}
          onClick={(event) => void exitToLibrary(event)}
        >
          <span aria-hidden="true">←</span>
          {mode === "sample" ? copy.backToBook : copy.backToLibrary}
        </a>

        <div className="min-w-0 text-center">
          <p className="truncate text-[0.84375rem] font-medium">{bookTitle}</p>
          {/* Truncates before the book title does at 390px: which book you are in matters more
              than which chapter when only one line fits. */}
          {chapterTitle ? <p className="truncate text-[0.75rem] text-sage-text">{chapterTitle}</p> : null}
        </div>

        <div className="flex items-center gap-1">
          <span className="hidden text-[0.8125rem] text-sage-text sm:inline">
            {displayedPercent}% {copy.progressLabel}
          </span>
          {depthEnabled ? <Dialog onOpenChange={(open) => { setSearchOpen(open); if (open) setSelection(null); }} open={searchOpen}>
            <DialogTrigger aria-label={copy.searchOpen} className="hidden size-11 items-center justify-center rounded-md text-sm outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current xl:inline-flex">⌕</DialogTrigger>
            <DialogPanel className={preferences.theme === "dark" ? "bg-ink text-ivory" : undefined} side="right"><div className="flex items-center justify-between gap-4"><DialogTitle>{copy.search}</DialogTitle><DialogClose>{copy.close}</DialogClose></div><ReaderSearchPanel copy={copy} onNavigate={async (locator) => { const moved = await goToLocator(locator); if (moved) setSearchOpen(false); return moved; }} publicationId={publicationId} request={request} /></DialogPanel>
          </Dialog> : null}
          {depthEnabled ? <ReaderTocDrawer
            copy={{
              contents: copy.contents,
              contentsTitle: copy.contentsTitle,
              contentsEmpty: copy.contentsEmpty,
              close: copy.close,
            }}
            currentHref={currentHref}
            entries={toc}
            onNavigate={goToHref}
            onOpenChange={(open) => { setDrawerOpen(open); if (open) setSelection(null); }}
            open={drawerOpen}
            finalFocus={() => menuTriggerRef.current}
            panelClassName={preferences.theme === "dark" ? "bg-ink text-ivory" : undefined}
            triggerClassName="hidden"
          >{(close) => readerSidebar(close)}</ReaderTocDrawer> : null}
          {depthEnabled ? <button aria-label={copy.addBookmark} className="hidden size-11 items-center justify-center rounded-md text-sm outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current xl:inline-flex" onClick={() => { setSelection(null); setEditor({ mode: "bookmark" }); }} type="button">⌑</button> : null}
          {depthEnabled ? <div className="hidden items-center gap-1 xl:flex" role="group" aria-label={copy.menu}>
            <button aria-pressed={desktopPageChoice === 1} className="min-h-11 rounded-md px-2 text-sm outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" onClick={() => setDesktopPageChoice(1)} type="button">{copy.onePage}</button>
            <button aria-pressed={desktopPageChoice === 2} className="min-h-11 rounded-md px-2 text-sm outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" onClick={() => setDesktopPageChoice(2)} type="button">{copy.twoPages}</button>
            <button aria-describedby="reader-ask-soon" disabled className="min-h-11 rounded-md px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" type="button">{copy.askInfinity}</button>
          </div> : null}
          <ReaderSettingsPanel copy={copy} onChange={changePreferences} onOpenChange={(open) => { setSettingsOpen(open); if (open) setSelection(null); }} open={settingsOpen} panelClassName={preferences.theme === "dark" ? "bg-ink text-ivory" : undefined} preferences={preferences} triggerClassName={mode === "sample" ? "inline-flex" : "hidden xl:inline-flex"} />
          {depthEnabled ? <Dialog onOpenChange={(open) => { setMenuOpen(open); if (open) setSelection(null); }} open={menuOpen}>
            <DialogTrigger aria-label={copy.menu} className="inline-flex size-11 items-center justify-center rounded-md text-current outline-none hover:bg-current/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current" ref={menuTriggerRef}>☰</DialogTrigger>
            <DialogPanel className={preferences.theme === "dark" ? "bg-ink text-ivory" : undefined} side="right"><div className="flex items-center justify-between gap-4"><DialogTitle>{copy.menu}</DialogTitle><DialogClose>{copy.close}</DialogClose></div><div className="grid gap-1" role="menu">
              <button className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setMenuOpen(false); setSearchOpen(true); }} role="menuitem" type="button">{copy.search}</button>
              <button className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setMenuOpen(false); setSidebarTab("contents"); if (viewportWidth < 1280) setDrawerOpen(true); }} role="menuitem" type="button">{copy.contents}</button>
              <button className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setMenuOpen(false); setEditor({ mode: "bookmark" }); }} role="menuitem" type="button">{copy.addBookmark}</button>
              <button className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }} role="menuitem" type="button">{copy.settings}</button>
              <button aria-checked={desktopPageChoice === 1} className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setDesktopPageChoice(1); setMenuOpen(false); }} role="menuitemradio" type="button">{copy.onePage}</button>
              <button aria-checked={desktopPageChoice === 2} className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => { setDesktopPageChoice(2); setMenuOpen(false); }} role="menuitemradio" type="button">{copy.twoPages}</button>
              {mode === "entitled" && reportHref ? <button className="min-h-11 rounded-md px-3 text-left text-sm hover:bg-current/5" onClick={() => {
                setMenuOpen(false);
                // The place being read travels with the report; leaving the page flushes the saved position.
                const place = locatorRef.current;
                window.location.assign(reportPlaceHref(reportHref, { href: place?.href ?? null, progression: place ? place.totalProgression ?? place.progression : null }));
              }} role="menuitem" type="button">{copy.reportError}</button> : null}
              <button aria-describedby="reader-ask-soon" className="min-h-11 rounded-md px-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60" disabled role="menuitem" type="button">{copy.askInfinity}</button>
            </div></DialogPanel>
          </Dialog> : null}
          <span className="sr-only" id="reader-ask-soon">{copy.comingSoon}</span>
        </div>
      </header>

      {lostAccess ? (
        <div className="mx-auto flex w-full max-w-[34rem] flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
          {/* Sample mode is anonymous and entitlement-free, so the entitled copy - "you no longer
              have access", "go to my library" - describes nothing the visitor has. One message and
              the way back to the book page they came from. */}
          <p className="text-sm text-current" role="alert">
            {mode === "sample"
              ? copy.sampleUnavailable
              : phase === "lost-signed-out"
                ? copy.lostAccessSignedOut
                : copy.lostAccessRevoked}
          </p>
          <Button
            render={
              <Link
                href={mode === "sample" ? backHref : phase === "lost-signed-out" ? signInHref : libraryHref}
              />
            }
          >
            {mode === "sample" ? copy.backToBook : phase === "lost-signed-out" ? copy.signIn : copy.goToLibrary}
          </Button>
        </div>
      ) : (
        <div className={`${styles.shell} ${mode === "entitled" ? styles.entitledShell : styles.sampleShell}`} data-reader-mode={mode} data-testid="reader-shell">
          {mode === "entitled" ? <aside className={styles.persistentSidebar}>{readerSidebar()}</aside> : null}
          <main className={`${styles.readerMain} ${mode === "sample" ? styles.sampleMain : ""} relative mx-auto flex w-full flex-1 flex-col px-2 sm:px-6 ${readerPageCount(viewportWidth, desktopPageChoice) === 2 ? "max-w-none" : READER_WIDTH_CLASS[preferences.width]}`}>
          {/* PR #16: Readium creates absolutely-positioned chapter iframes at runtime. Without
              `relative` here and these four arbitrary-variant rules they collapse to the 300x150
              replaced-element default and the book renders in a postage stamp. Pinned by a test. */}
          <div
            aria-busy={phase === "loading"}
            aria-label={copy.title}
            className="relative h-[calc(100dvh-10.5rem)] min-h-[24rem] w-full overflow-hidden [&>.readium-navigator-iframe]:inset-0 [&>.readium-navigator-iframe]:h-full [&>.readium-navigator-iframe]:w-full [&>.readium-navigator-iframe]:border-0"
            ref={containerRef}
            role="region"
            tabIndex={-1}
          />
          {readerPageCount(viewportWidth, desktopPageChoice) === 2 ? <span aria-hidden="true" className={styles.divider} data-testid="reader-spread-divider" /> : null}
          {positionInfo ? <p className="mt-2 text-center text-xs text-sage-text" role="status">{positionInfo.current === positionInfo.end ? `${copy.page} ${positionInfo.current} / ${positionInfo.total}` : `${copy.pages} ${positionInfo.current}–${positionInfo.end} / ${positionInfo.total}`}</p> : null}
          {locationMessage ? <p className="mt-2 text-center text-sm text-error" role="status">{locationMessage}</p> : null}
          </main>
        </div>
      )}

      {depthEnabled && selection && authorName && canonicalBookUrl ? <ReaderSelectionToolbar createShareUrl={createShareUrl} onBeforeAction={() => engineRef.current?.settleSelection()} book={{ title: bookTitle, author: authorName, canonicalBookUrl }} copy={copy} dark={preferences.theme === "dark"} onAddNote={() => { setEditor({ mode: "note", selection }); setSelection(null); }} onDismiss={dismissSelection} onHighlight={(color: HighlightColor) => { void annotations.create({ kind: "highlight", locator: selection.locator, selectedText: selection.annotationText ?? selection.locator.text?.highlight ?? selection.text, color, noteText: null }); setSelection(null); }} selection={selection} touch={viewportWidth < 640} viewport={{ width: viewportWidth, height: typeof window === "undefined" ? 0 : window.innerHeight }} /> : null}
      {depthEnabled && editor ? <ReaderAnnotationEditor chapterTitle={chapterTitle ?? ""} copy={copy} dark={preferences.theme === "dark"} finalFocus={() => menuTriggerRef.current ?? containerRef.current} initialValue={editorInitialValue} mode={editor.mode} onOpenChange={(open) => { if (!open) { setEditor(null); setSelection(null); } }} onSave={saveEditor} open trigger={<button className="sr-only" type="button">{copy.addBookmark}</button>} /> : null}

      {finished && !completionDismissed && mode === "entitled" ? <ReaderCompletionPanel askHref={askHref ?? null} copy={copy} dark={preferences.theme === "dark"} libraryHref={libraryHref} reviewHref={reviewHref ?? null} onOpenSaved={(tab) => { setSelection(null); setSidebarTab(tab); setCompletionDismissed(true); if (viewportWidth < 1280) setDrawerOpen(true); }} relatedBooks={relatedBooks} /> : null}

      {mode === "sample" && sampleFullNotice ? (
        <p className="mx-auto w-full max-w-[34rem] px-4 pb-3 text-center text-sm text-sage-text" data-testid="sample-full-notice">
          <a className="underline underline-offset-4" href={signInHref}>{sampleFullNotice}</a>
        </p>
      ) : null}

      {/* `phase === "ready"` is load-bearing, not belt-and-braces: `navigation` initialises to
          `canGoForward: false`, so without it "That is the end of the sample" is on screen from the
          first paint and disappears once the book opens. */}
      {mode === "sample" && phase === "ready" && !navigation.canGoForward && endSlot ? (
        <div className="mx-auto w-full max-w-[34rem] px-4 pb-4">
          <div className="rounded-md border border-hairline bg-surface p-4 text-center" role="status">
            <p className="font-serif text-lg">{copy.sampleEndTitle}</p>
            <p className="mt-1 text-sm text-sage-text">{copy.sampleEndBody}</p>
            <div className="mt-3 flex justify-center">{endSlot}</div>
          </div>
        </div>
      ) : null}

      <footer className="border-t border-hairline px-4 py-3 sm:px-8">
        <div className={`mx-auto flex min-h-11 w-full flex-wrap items-center justify-between gap-3 ${readerPageCount(viewportWidth, desktopPageChoice) === 2 ? "max-w-none" : "max-w-[50rem]"}`}>
          {phase === "loading" ? (
            <p className="text-sm text-sage-text" role="status">
              {copy.loading}
            </p>
          ) : null}

          {phase === "error" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-error" role="alert">
                {copy.failed}
              </p>
              <Button onClick={() => setAttempt((value) => value + 1)} size="sm" type="button" variant="outline">
                {copy.retry}
              </Button>
            </div>
          ) : null}

          {phase === "ready" ? (
            <div className="flex gap-2">
              <Button
                className={preferences.theme === "dark" ? "border-current text-current hover:bg-ink-soft disabled:opacity-60" : undefined}
                disabled={!navigation.canGoBackward}
                onClick={() => void move("previous")}
                type="button"
                variant="outline"
              >
                <span aria-hidden="true">←</span>
                {copy.previousPage}
              </Button>
              <Button
                className={preferences.theme === "dark" ? "border-current text-current hover:bg-ink-soft disabled:opacity-60" : undefined}
                disabled={!navigation.canGoForward}
                onClick={() => void move("next")}
                type="button"
                variant="outline"
              >
                {copy.nextPage}
                <span aria-hidden="true">→</span>
              </Button>
            </div>
          ) : null}

          {saveState === "failed" ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="reader-save-failed">
              {/* role="status", not "alert": losing a position save is recoverable and the reader can
                  keep reading, so this must not interrupt a screen reader mid-sentence. */}
              <p className="text-sm text-sage-text" role="status">
                {copy.saveFailed}
              </p>
              <Button onClick={() => void flush()} size="sm" type="button" variant="outline">
                {copy.saveRetry}
              </Button>
            </div>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
