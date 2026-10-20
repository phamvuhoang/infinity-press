import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import LibraryPage from "@/app/[lang]/(account)/library/page";
import { requireUser } from "@/lib/auth/session";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { type LibraryItemDTO, getLibrary } from "@/lib/data/library";
import { getShelfRecommendations } from "@/lib/data/recommendations";
import { listMySharedQuotes, type MySharedQuote } from "@/lib/data/shared-quotes";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(() => Promise.resolve(new Headers({ "x-request-id": "req_library123" }))),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/library", () => ({ getLibrary: vi.fn() }));
vi.mock("@/lib/data/recommendations", () => ({ getShelfRecommendations: vi.fn() }));
vi.mock("@/lib/data/shared-quotes", () => ({ listMySharedQuotes: vi.fn() }));

const OWNED_A = "30000000-0000-4000-8000-000000000001";
const OWNED_B = "30000000-0000-4000-8000-000000000002";
const CANDIDATE_ID = "30000000-0000-4000-8000-000000000003";
// A third owned id, used only in the seeding-order test below. With just two books whose ids and
// titles both happen to sort the same way as they were inserted, "preserves insertion order"
// cannot be told apart from "sorts by book_id" or "sorts alphabetically by title". These three
// ids/titles instead give three different sequences: first-occurrence [C, A, B], ascending
// book_id [A, B, C], and alphabetical title [C, B, A].
const OWNED_C = "30000000-0000-4000-8000-000000000004";

function libraryItem(bookId: string, title: string): LibraryItemDTO {
  return {
    bookId,
    title,
    slug: bookId,
    coverAltText: null,
    coverUrl: null,
    state: "unread",
    progressPercent: 0,
    continueReadingUrl: `/en/read/${bookId}`,
  };
}

function candidateCard(bookId: string, title: string): CatalogBookCard {
  return {
    bookId,
    slug: bookId,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: "an-author" },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
  };
}

const params = Promise.resolve({ lang: "en" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(listMySharedQuotes).mockResolvedValue([]);
});

afterEach(cleanup);

describe("LibraryPage authorization", () => {
  // A version of the page that checks requireUser() but reads getLibrary/getShelfRecommendations
  // before awaiting it (or not at all) would still pass a test that only checks call order via
  // mock.invocationCallOrder without ever running - this rejection instead makes the whole
  // async page function throw before either DTO read, which only holds if the gate genuinely
  // runs first.
  it("never calls getLibrary or getShelfRecommendations when the session gate rejects", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT /en/sign-in"));

    await expect(LibraryPage({ params })).rejects.toThrow("NEXT_REDIRECT /en/sign-in");

    expect(getLibrary).not.toHaveBeenCalled();
    expect(getShelfRecommendations).not.toHaveBeenCalled();
  });
});

describe("LibraryPage review link", () => {
  it("links each shelf item to its review page", async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryItem(OWNED_A, "Book Zulu")]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await LibraryPage({ params }));

    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", `/en/library/reviews/${OWNED_A}`);
  });
});

describe("LibraryPage shared quotes link", () => {
  it("links to the shared quotes page only when the reader has an active shared quote", async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryItem(OWNED_A, "Book Zulu")]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await LibraryPage({ params }));
    expect(screen.queryByRole("link", { name: "Shared quotes" })).not.toBeInTheDocument();
    cleanup();

    vi.mocked(listMySharedQuotes).mockResolvedValue([{ id: "q1" } as MySharedQuote]);
    render(await LibraryPage({ params }));
    expect(screen.getByRole("link", { name: "Shared quotes" })).toHaveAttribute("href", "/en/library/quotes");
  });

  it("still renders the library when the shared quotes read fails", async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryItem(OWNED_A, "Book Zulu")]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);
    vi.mocked(listMySharedQuotes).mockRejectedValue(new Error("boom"));

    render(await LibraryPage({ params }));
    expect(screen.getAllByText("Book Zulu").length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Shared quotes" })).not.toBeInTheDocument();
  });
});

describe("LibraryPage recommendations", () => {
  it("seeds and excludes recommendations with the reader's full owned ID set", async () => {
    // Insertion order [C, A, B] disagrees with both ascending book_id order [A, B, C] and
    // alphabetical title order [C, B, A] - see the OWNED_C comment above.
    vi.mocked(getLibrary).mockResolvedValue([
      libraryItem(OWNED_C, "Book Alpha"),
      libraryItem(OWNED_A, "Book Zulu"),
      libraryItem(OWNED_B, "Book Mike"),
    ]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([candidateCard(CANDIDATE_ID, "Candidate Book")]);

    render(await LibraryPage({ params }));

    expect(getShelfRecommendations).toHaveBeenCalledWith({
      seedBookIds: [OWNED_C, OWNED_A, OWNED_B],
      excludeBookIds: [OWNED_C, OWNED_A, OWNED_B],
      locale: "en",
      limit: 6,
      requestId: "req_library123",
    });

    // Owned titles really do render elsewhere on the page (the owned shelf), so the negative
    // assertion on the recommendation region below is scoped, not vacuous.
    expect(screen.getAllByText("Book Alpha").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Book Zulu").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Book Mike").length).toBeGreaterThan(0);

    const region = screen.getByRole("region", { name: "You might like" });
    expect(within(region).getByRole("link", { name: "Candidate Book" })).toBeVisible();
    expect(within(region).queryByText("Book Alpha")).not.toBeInTheDocument();
    expect(within(region).queryByText("Book Zulu")).not.toBeInTheDocument();
    expect(within(region).queryByText("Book Mike")).not.toBeInTheDocument();
  });

  it("renders no recommendation region when there are no candidates", async () => {
    vi.mocked(getLibrary).mockResolvedValue([libraryItem(OWNED_A, "Owned A")]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await LibraryPage({ params }));

    expect(screen.queryByRole("heading", { name: "You might like" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "You might like" })).not.toBeInTheDocument();
  });

  it("keeps the empty-library state unchanged and calls getShelfRecommendations with empty seed and exclude lists", async () => {
    vi.mocked(getLibrary).mockResolvedValue([]);
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await LibraryPage({ params }));

    expect(getShelfRecommendations).toHaveBeenCalledWith({
      seedBookIds: [],
      excludeBookIds: [],
      locale: "en",
      limit: 6,
      requestId: "req_library123",
    });
    expect(screen.getByText("No books yet")).toBeVisible();
    expect(screen.queryByRole("region", { name: "You might like" })).not.toBeInTheDocument();
  });
});
