import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GiftClaimPage, { metadata } from "@/app/[lang]/(account)/gifts/claim/[token]/page";
import { requireUser } from "@/lib/auth/session";
import { GiftClaimRejectedError, claimGift } from "@/lib/commerce/gifts";
import en from "@/lib/i18n/dictionaries/en.json";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/commerce/gifts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/commerce/gifts")>("@/lib/commerce/gifts");
  return { ...actual, claimGift: vi.fn() };
});

afterEach(cleanup);

const TOKEN = "Zm9vLWJhcl9iYXo";
const RECIPIENT = "friend@example.com";
const copy = en.gifts.claim;

const params = Promise.resolve({ lang: "en", token: TOKEN });

const added = {
  bookId: "30000000-0000-4000-8000-000000000001",
  title: "Deep Work",
  entitlementId: "40000000-0000-4000-8000-000000000001",
  alreadyOwned: false,
};
const owned = {
  bookId: "30000000-0000-4000-8000-000000000002",
  title: "The Alchemist",
  entitlementId: "40000000-0000-4000-8000-000000000002",
  alreadyOwned: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  // requireUser resolves: the signed-out behaviour is requireUser's own redirect, asserted below
  // by making the mock do what the real one does.
  vi.mocked(requireUser).mockResolvedValue({ email: RECIPIENT } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(claimGift).mockResolvedValue([added, owned]);
});

describe("GiftClaimPage", () => {
  it("is noindex and nofollow", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("gates on its own signed-in reader, carrying the exact claim path back", async () => {
    await GiftClaimPage({ params });

    expect(requireUser).toHaveBeenCalledExactlyOnceWith("en", `/en/gifts/claim/${TOKEN}`);
    // The gate runs before the claim, not alongside it.
    expect(vi.mocked(requireUser).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(claimGift).mock.invocationCallOrder[0],
    );
  });

  it("sends a signed-out visitor to sign-in with the token only inside next", async () => {
    // What the real requireUser does for a visitor with no session.
    vi.mocked(requireUser).mockImplementation((async (locale: string, next: string) => {
      throw new Error(`NEXT_REDIRECT /${locale}/sign-in?${new URLSearchParams({ next })}`);
    }) as unknown as typeof requireUser);

    await expect(GiftClaimPage({ params })).rejects.toThrow(
      `NEXT_REDIRECT /en/sign-in?next=%2Fen%2Fgifts%2Fclaim%2F${TOKEN}`,
    );
    expect(claimGift).not.toHaveBeenCalled();

    const thrown = await GiftClaimPage({ params }).then(
      () => "",
      (error: Error) => error.message,
    );
    const destination = new URL(thrown.replace("NEXT_REDIRECT ", ""), "https://books.example.com");
    expect([...destination.searchParams.keys()]).toEqual(["next"]);
    expect(destination.searchParams.get("next")).toBe(`/en/gifts/claim/${TOKEN}`);
    // The token is in `next` and nowhere else - not in the path, not in a second parameter.
    expect(destination.pathname).toBe("/en/sign-in");
  });

  it("404s an unknown locale without attempting the claim", async () => {
    await expect(GiftClaimPage({ params: Promise.resolve({ lang: "de", token: TOKEN }) })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(requireUser).not.toHaveBeenCalled();
    expect(claimGift).not.toHaveBeenCalled();
  });

  it("passes the token straight to the claim RPC", async () => {
    await GiftClaimPage({ params });

    expect(claimGift).toHaveBeenCalledExactlyOnceWith("en", TOKEN);
  });

  it("groups what was added apart from what the reader already had, and links each one", async () => {
    render(await GiftClaimPage({ params }));

    expect(screen.getByRole("heading", { name: copy.addedTitle })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: copy.ownedTitle })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deep Work" })).toHaveAttribute("href", `/en/read/${added.bookId}`);
    expect(screen.getByRole("link", { name: "The Alchemist" })).toHaveAttribute("href", `/en/read/${owned.bookId}`);
    expect(screen.getByRole("link", { name: copy.library })).toHaveAttribute("href", "/en/library");
  });

  // Item 2 of the review's carried-forward list. claim_gift's same-reader replay inner-joins active
  // entitlements, so a book revoked after the claim silently drops out of the list with no marker.
  // The page therefore never claims the list is "what this claim granted": it says what the gift
  // holds in the library NOW, which is true on the first call and on every refresh after it.
  it("describes the list as the gift's current state rather than as the moment of the claim", async () => {
    render(await GiftClaimPage({ params }));

    expect(screen.getByText(copy.currentNote)).toBeInTheDocument();
  });

  it("omits a group that has no books in it", async () => {
    vi.mocked(claimGift).mockResolvedValue([added]);

    render(await GiftClaimPage({ params }));

    expect(screen.getByRole("heading", { name: copy.addedTitle })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: copy.ownedTitle })).not.toBeInTheDocument();
  });

  // The honest end of the replay problem: every book of the gift revoked leaves an empty result,
  // and an empty result must say so rather than render a page of headings with nothing under them.
  it("says so when the gift holds nothing in the library right now", async () => {
    vi.mocked(claimGift).mockResolvedValue([]);

    render(await GiftClaimPage({ params }));

    expect(screen.getByText(copy.empty)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: copy.addedTitle })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.library })).toBeInTheDocument();
  });

  it("gives one refusal message for every reason the token cannot be used", async () => {
    vi.mocked(claimGift).mockRejectedValue(new GiftClaimRejectedError());

    render(await GiftClaimPage({ params }));

    expect(screen.getByText(copy.refusedTitle)).toBeInTheDocument();
    expect(screen.getByText(copy.refusedBody)).toBeInTheDocument();
    // Nothing that would tell a guesser which of unknown / claimed / revoked applied.
    const html = document.body.innerHTML;
    for (const word of ["revoked", "already claimed", "expired", "unknown"]) {
      expect(html.toLowerCase()).not.toContain(word);
    }
  });

  it("lets an unexpected failure through rather than rendering a refusal", async () => {
    vi.mocked(claimGift).mockRejectedValue(new Error("claimGift: claim_gift failed: boom"));

    await expect(GiftClaimPage({ params })).rejects.toThrow("boom");
  });

  it("never puts the recipient address or the token in the page", async () => {
    const { container } = render(await GiftClaimPage({ params }));

    expect(container.innerHTML).not.toContain(RECIPIENT);
    expect(container.innerHTML).not.toContain(TOKEN);
  });

  it("renders the Vietnamese copy", async () => {
    render(await GiftClaimPage({ params: Promise.resolve({ lang: "vi", token: TOKEN }) }));

    expect(screen.getByRole("link", { name: "Đến thư viện của bạn" })).toHaveAttribute("href", "/vi/library");
  });
});
