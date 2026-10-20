import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ReaderSearchPanel,
  type ReaderSearchPanelCopy,
} from "@/components/reader/reader-search-panel";
import type { ReaderLocator } from "@/lib/reader/types";

const publicationId = "c0000000-0000-4000-8000-000000000001";
const copy: ReaderSearchPanelCopy = {
  search: "Search this book",
  searchPlaceholder: "Search words or phrases",
  searchPrompt: "Type at least 2 characters.",
  searching: "Searching…",
  searchEmpty: "No matches found.",
  searchFailed: "Search is unavailable right now.",
  retry: "Try again",
  untitledChapter: "Untitled chapter",
};
const firstLocator: ReaderLocator = {
  href: `/api/reader/publications/${publicationId}/resources/OEBPS/chapter-1.xhtml`,
  progression: 0.25,
  totalProgression: 0.1,
  locations: { cssSelector: "p:nth-child(2)", textOffset: 3 },
  text: { highlight: "first match" },
};
const secondLocator: ReaderLocator = {
  ...firstLocator,
  href: `/api/reader/publications/${publicationId}/resources/OEBPS/chapter-2.xhtml`,
  progression: 0.5,
  text: { highlight: "second match" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function result(chapterTitle: string | null, excerpt: string, locator = firstLocator) {
  return { chapterTitle, excerpt, locator };
}

describe("ReaderSearchPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  function setup(request = vi.fn().mockResolvedValue({ results: [] })) {
    const onNavigate = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ReaderSearchPanel
        copy={copy}
        onNavigate={onNavigate}
        publicationId={publicationId}
        request={request}
      />,
    );
    return { ...view, input: screen.getByRole("searchbox", { name: copy.search }), onNavigate, request };
  }

  async function advance(milliseconds: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(milliseconds);
    });
  }

  it("waits 250ms and sends a trimmed, encoded query", async () => {
    const { input, request } = setup();
    fireEvent.change(input, { target: { value: "  tiếng Việt & sách  " } });

    await advance(249);
    expect(request).not.toHaveBeenCalled();
    await advance(1);

    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/api/reader/publications/${publicationId}/search?q=ti%E1%BA%BFng%20Vi%E1%BB%87t%20%26%20s%C3%A1ch`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("never requests a query outside the 2–100 trimmed Unicode-code-point range", async () => {
    const { input, request } = setup();
    for (const query of [" x ", ` ${"😀".repeat(101)} `]) {
      fireEvent.change(input, { target: { value: query } });
      await advance(300);
    }

    expect(request).not.toHaveBeenCalled();
    expect(screen.getByText(copy.searchPrompt)).toBeInTheDocument();
  });

  it("aborts the old request and ignores its late result when the query changes", async () => {
    const old = deferred<unknown>();
    const current = deferred<unknown>();
    const request = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { input } = setup(request);
    fireEvent.change(input, { target: { value: "first" } });
    await advance(250);
    const oldSignal = request.mock.calls[0][1].signal as AbortSignal;

    fireEvent.change(input, { target: { value: "second" } });
    expect(oldSignal.aborted).toBe(true);
    await advance(250);
    await act(async () => {
      current.resolve({ results: [result("Current chapter", "current result", secondLocator)] });
      await current.promise;
    });
    expect(screen.getByRole("button", { name: "current result" })).toBeInTheDocument();

    await act(async () => {
      old.resolve({ results: [result("Old chapter", "stale result")] });
      await old.promise;
    });
    expect(screen.queryByText("stale result")).toBeNull();
  });

  it("aborts an in-flight search on unmount and does not show AbortError as a failure", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn((_path: string, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => pending.reject(new DOMException("Aborted", "AbortError")));
      return pending.promise;
    });
    const { input, unmount } = setup(request);
    fireEvent.change(input, { target: { value: "query" } });
    await advance(250);
    const signal = request.mock.calls[0][1]?.signal as AbortSignal;

    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      await pending.promise.catch(() => undefined);
    });
    expect(screen.queryByText(copy.searchFailed)).toBeNull();
  });

  it("groups results by chapter, labels untitled chapters, and navigates with the selected locator", async () => {
    const request = vi.fn().mockResolvedValue({
      results: [
        result("Chapter one", "first excerpt"),
        result("Chapter one", "second excerpt", secondLocator),
        result(null, "untitled excerpt", { ...secondLocator, progression: 0.75 }),
      ],
    });
    const { input, onNavigate } = setup(request);
    fireEvent.change(input, { target: { value: "excerpt" } });
    await advance(250);
    await act(async () => Promise.resolve());

    const chapter = screen.getByRole("group", { name: "Chapter one" });
    expect(within(chapter).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("group", { name: copy.untitledChapter })).toBeInTheDocument();
    fireEvent.click(within(chapter).getByRole("button", { name: "second excerpt" }));
    await act(async () => Promise.resolve());
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(secondLocator);
  });

  it("renders an empty state and retries only the current failed query", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce({ results: [result("Chapter one", "recovered")] });
    const { input } = setup(request);
    fireEvent.change(input, { target: { value: "empty" } });
    await advance(250);
    expect(screen.getByText(copy.searchEmpty)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "failed" } });
    await advance(250);
    expect(screen.getByText(copy.searchFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: copy.retry }));
    await act(async () => Promise.resolve());

    expect(screen.getByRole("button", { name: "recovered" })).toBeInTheDocument();
    expect(request.mock.calls[1][0]).toContain("q=failed");
    expect(request.mock.calls[2][0]).toContain("q=failed");
  });

  it("clears old result actions as soon as the query changes", async () => {
    const request = vi.fn().mockResolvedValue({ results: [result("Chapter one", "old result")] });
    const { input } = setup(request);
    fireEvent.change(input, { target: { value: "old" } });
    await advance(250);
    expect(screen.getByRole("button", { name: "old result" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "new" } });
    expect(screen.queryByRole("button", { name: "old result" })).toBeNull();
  });

  it("preserves settled results when an edit keeps the same trimmed query", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const { input } = setup(request);
    fireEvent.change(input, { target: { value: "foo" } });
    await advance(250);
    await act(async () => {
      pending.resolve({ results: [result("Chapter one", "stable result")] });
      await pending.promise;
    });
    expect(screen.getByRole("button", { name: "stable result" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: " foo " } });
    expect(screen.getByRole("button", { name: "stable result" })).toBeInTheDocument();
    expect(screen.queryByText(copy.searching)).toBeNull();
    await advance(300);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps the query in memory rather than browser storage", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const { input } = setup();
    fireEvent.change(input, { target: { value: "private search words" } });
    await advance(250);
    expect(screen.getByText(copy.searchEmpty)).toBeInTheDocument();

    expect(localWrite).not.toHaveBeenCalled();
  });
});
