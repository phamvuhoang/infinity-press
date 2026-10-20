import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerBundleAction } from "@/components/catalog/viewer-bundle-action";
import { createClient } from "@/lib/supabase/client";

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
  bundleId: "bundle-1",
  buyAction: async () => {},
  buyLabel: "Buy bundle",
  copy: { signInHint: "Sign in first.", pending: "Working…", comingSoon: "Coming soon", unavailable: "Not available yet" } as never,
  libraryLabel: "Go to your library",
  libraryPath: "/en/library",
  locale: "en" as const,
  memberCount: 3,
  ownedCopy: { ownedAll: "You own every book.", ownedSome: "You own {owned} of {total} books." },
  publicAction: "buy" as const,
  signInPath: "/en/sign-in",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthClient();
});
afterEach(cleanup);

describe("ViewerBundleAction", () => {
  it("renders the anonymous action first, so the prerendered HTML is what a crawler sees", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<ViewerBundleAction {...props} />);

    expect(screen.getByText("Buy bundle")).toBeVisible();
  });

  it("swaps in the viewer's own action once it arrives, sending the locale it rendered in", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ action: "owned_bundle", signedIn: true, ownedMemberCount: 3 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("Go to your library")).toBeVisible());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalog/bundles/bundle-1/action-state?locale=en",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  // The ownedAll line and the owned_bundle swap are two separate things the fetch can deliver
  // together; this pins the copy specifically, since a previous version of this file asserted only
  // the library link and let the "You own every book" text go untested.
  it("renders the ownedAll copy once the viewer owns every member", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ action: "owned_bundle", signedIn: true, ownedMemberCount: 3 }), { status: 200 })),
    );
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("You own every book.")).toBeVisible());
  });

  it("keeps the anonymous action when the fetch fails, rather than blanking the control", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("Buy bundle")).toBeVisible());
  });

  // Ownership never blocks buying the rest of the bundle - the price is unchanged - so this pins
  // both facts together: the owned-some line AND a still-offered Buy control at partial ownership.
  it("renders the owned-some line and still offers Buy when the viewer owns part of the bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ action: "buy", signedIn: true, ownedMemberCount: 2 }), { status: 200 })),
    );
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("You own 2 of 3 books.")).toBeVisible());
    expect(screen.getByRole("button", { name: "Buy bundle" })).toBeEnabled();
  });

  it("renders nothing about ownership when the viewer owns none of the bundle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ action: "buy", signedIn: true, ownedMemberCount: 0 }), { status: 200 })),
    );
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("Buy bundle")).toBeVisible());
    expect(screen.queryByText(/You own/)).not.toBeInTheDocument();
  });

  // The reviewer's exact reproduction, applied to the bundle control: once a real answer has
  // arrived, a sign-out must not leave it showing - the header (SiteHeaderAccountNav) flips on the
  // same onAuthStateChange event, and this control disagreeing with it is the bug.
  it("refetches when the session changes, instead of keeping the previous viewer's answer", async () => {
    const auth = mockAuthClient();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: "owned_bundle", signedIn: true, ownedMemberCount: 3 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: "buy", signedIn: true, ownedMemberCount: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ViewerBundleAction {...props} />);

    await waitFor(() => expect(screen.getByText("You own every book.")).toBeVisible());

    auth.trigger();

    await waitFor(() => expect(screen.getByRole("button", { name: "Buy bundle" })).toBeEnabled());
    expect(screen.queryByText("You own every book.")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
