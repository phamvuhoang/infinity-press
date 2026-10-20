import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerBookAction } from "@/components/catalog/viewer-book-action";
import { createClient } from "@/lib/supabase/client";

vi.mock("@/components/catalog/book-action-control", () => ({
  BookActionControl: ({ action, signedIn }: { action: string; signedIn: boolean }) => (
    <span data-signed-in={String(signedIn)}>{action}</span>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));

// useViewerAction (through this component) subscribes to onAuthStateChange so it can refetch on
// sign-in/sign-out, matching SiteHeaderAccountNav. `trigger` fires the same callback every mocked
// client gets, standing in for a real auth event.
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
  return { trigger: () => onChange?.() };
}

const props = {
  bookId: "book-1",
  bookPath: "/en/books/a-book",
  locale: "en" as const,
  copy: {} as never,
  publicAction: "buy" as const,
  getFreeAction: async () => {},
  buyAction: async () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthClient();
});
afterEach(cleanup);

describe("ViewerBookAction", () => {
  it("renders the anonymous action first, so the prerendered HTML is what a crawler sees", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ViewerBookAction {...props} />);

    expect(screen.getByText("buy")).toHaveAttribute("data-signed-in", "false");
  });

  it("swaps in the viewer's own action once it arrives, sending the locale it rendered in", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ action: "read", signedIn: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ViewerBookAction {...props} />);

    await waitFor(() => expect(screen.getByText("read")).toHaveAttribute("data-signed-in", "true"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalog/books/book-1/action-state?locale=en",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("keeps the anonymous action when the fetch fails, rather than blanking the control", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    render(<ViewerBookAction {...props} />);

    await waitFor(() => expect(screen.getByText("buy")).toBeVisible());
  });

  // The reviewer's exact reproduction: once a real answer has arrived, a sign-out must not leave it
  // showing - the header (SiteHeaderAccountNav) flips on the same onAuthStateChange event, and this
  // control disagreeing with it is the bug.
  it("refetches when the session changes, instead of keeping the previous viewer's answer", async () => {
    const auth = mockAuthClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: "read", signedIn: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: "buy", signedIn: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ViewerBookAction {...props} />);

    await waitFor(() => expect(screen.getByText("read")).toHaveAttribute("data-signed-in", "true"));

    auth.trigger();

    await waitFor(() => expect(screen.getByText("buy")).toHaveAttribute("data-signed-in", "false"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
