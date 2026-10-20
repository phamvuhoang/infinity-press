import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useViewerAction } from "@/components/catalog/use-viewer-action";
import { createClient } from "@/lib/supabase/client";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

// Every caller passes a fresh session subscription; `trigger` fires the callback the hook
// registered, standing in for a real sign-in/sign-out/token-refresh event.
function mockAuthClient() {
  let onChange: (() => void) | undefined;
  vi.mocked(createClient).mockReturnValue({
    auth: {
      onAuthStateChange: vi.fn((callback: () => void) => {
        onChange = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
    },
  } as unknown as ReturnType<typeof createClient>);
  return { trigger: () => act(() => onChange?.()) };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthClient();
});
afterEach(() => vi.unstubAllGlobals());

describe("useViewerAction", () => {
  it("returns the fallback immediately, before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { result } = renderHook(() => useViewerAction("/api/x", { action: "buy", signedIn: false }));

    expect(result.current).toEqual({ action: "buy", signedIn: false });
  });

  it("swaps in the fetched state once it arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ action: "read", signedIn: true })));
    const { result } = renderHook(() => useViewerAction("/api/x", { action: "buy", signedIn: false }));

    await waitFor(() => expect(result.current).toEqual({ action: "read", signedIn: true }));
  });

  // The exact scenario the reviewer reproduced against this hook: a second render with the same
  // url but a different fallback used to keep returning the first fetch's answer, with only one
  // fetch ever made. It must reset to the new fallback and fetch again.
  it("resets to a new fallback and refetches when the fallback changes, even with the same url", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ action: "buy", signedIn: true }))
      .mockResolvedValueOnce(new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ fallback }) => useViewerAction("/api/x", fallback), {
      initialProps: { fallback: { action: "buy", signedIn: false } },
    });

    await waitFor(() => expect(result.current).toEqual({ action: "buy", signedIn: true }));

    rerender({ fallback: { action: "unavailable", signedIn: false } });

    expect(result.current).toEqual({ action: "unavailable", signedIn: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // SiteHeaderAccountNav subscribes to the same onAuthStateChange to flip the header immediately on
  // sign-out; without this, the header and this hook disagree about who the viewer is.
  it("refetches when the session changes, instead of keeping the previous viewer's answer", async () => {
    const auth = mockAuthClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ action: "read", signedIn: true }))
      .mockResolvedValueOnce(jsonResponse({ action: "buy", signedIn: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useViewerAction("/api/x", { action: "buy", signedIn: false }));

    await waitFor(() => expect(result.current).toEqual({ action: "read", signedIn: true }));

    auth.trigger();

    await waitFor(() => expect(result.current).toEqual({ action: "buy", signedIn: false }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the fallback when the fetch fails, rather than blanking the state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    const { result } = renderHook(() => useViewerAction("/api/x", { action: "buy", signedIn: false }));

    await waitFor(() => expect(result.current).toEqual({ action: "buy", signedIn: false }));
  });

  it("refetches when the url changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ action: "read", signedIn: true }))
      .mockResolvedValueOnce(jsonResponse({ action: "buy", signedIn: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ url }) => useViewerAction(url, { action: "buy", signedIn: false }), {
      initialProps: { url: "/api/book-1" },
    });

    await waitFor(() => expect(result.current).toEqual({ action: "read", signedIn: true }));

    rerender({ url: "/api/book-2" });

    await waitFor(() => expect(result.current).toEqual({ action: "buy", signedIn: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
