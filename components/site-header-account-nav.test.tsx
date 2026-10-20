import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SiteHeaderAccountNav } from "@/components/site-header-account-nav";
import { createClient } from "@/lib/supabase/client";

vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
vi.mock("@/components/auth/sign-out-button", () => ({
  SignOutButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));

const copy = { account: "Account", library: "Library", signIn: "Sign in", signOut: "Sign out" };

function mockSession(user: { id: string } | null) {
  vi.mocked(createClient).mockReturnValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user } }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    },
  } as unknown as ReturnType<typeof createClient>);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("SiteHeaderAccountNav", () => {
  it("shows nothing before the session resolves, so it never shows the wrong state", () => {
    mockSession(null);
    const { container } = render(<SiteHeaderAccountNav copy={copy} locale="en" navLinkClassName="nav" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers sign in when there is no session", async () => {
    mockSession(null);
    render(<SiteHeaderAccountNav copy={copy} locale="en" navLinkClassName="nav" />);

    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/en/sign-in");
    expect(screen.queryByRole("link", { name: "Library" })).toBeNull();
  });

  it("offers the library, the account and sign out when there is a session", async () => {
    mockSession({ id: "user-1" });
    render(<SiteHeaderAccountNav copy={copy} locale="vi" navLinkClassName="nav" />);

    expect(await screen.findByRole("link", { name: "Library" })).toHaveAttribute("href", "/vi/library");
    expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/vi/account");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("marks the current section", async () => {
    mockSession({ id: "user-1" });
    render(<SiteHeaderAccountNav copy={copy} current="library" locale="en" navLinkClassName="nav" />);

    await waitFor(() => expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("aria-current", "page"));
  });
});
