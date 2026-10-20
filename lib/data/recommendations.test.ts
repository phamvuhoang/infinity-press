// @vitest-environment node
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBookCards } from "@/lib/data/catalog";
import { getRecommendedBooks, getShelfRecommendations } from "@/lib/data/recommendations";
import { createPublicClient } from "@/lib/supabase/public";
import type { CatalogBookCard } from "@/lib/catalog/public-types";

vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const SEED = "30000000-0000-4000-8000-000000000001";
const OWNED_B = "30000000-0000-4000-8000-000000000002";
const BOOK_A = "30000000-0000-4000-8000-000000000003";
const BOOK_C = "30000000-0000-4000-8000-000000000004";

function makeCard(overrides: Partial<CatalogBookCard> & { bookId: string; slug: string }): CatalogBookCard {
  return {
    subtitle: null,
    shortDescription: null,
    title: overrides.slug,
    author: { name: "An Author", slug: "an-author" },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: false, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
    ...overrides,
  };
}

// Catalog order deliberately differs from RPC order below, so a test that only checks set
// membership (rather than sequence) would still pass on a bug that re-sorted by catalog order.
const cardA = makeCard({ bookId: BOOK_A, slug: "book-a", title: "Book A" });
const cardC = makeCard({ bookId: BOOK_C, slug: "book-c", title: "Book C" });

function mockRpc(data: unknown, error: unknown = null) {
  const rpc = vi.fn(() => Promise.resolve({ data, error }));
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(new Headers({ "x-request-id": "req_reco123" }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Catalog order is A, C - the reverse of the RPC row order (C, A) used below, so output that
  // matches catalog order instead of RPC order is caught.
  vi.mocked(getBookCards).mockResolvedValue([cardA, cardC]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getRecommendedBooks", () => {
  it("returns [] without calling the RPC or the card catalog for no seeds", async () => {
    const rpc = mockRpc([]);
    expect(await getRecommendedBooks({ seedBookIds: [], locale: "en" })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(getBookCards).not.toHaveBeenCalled();
  });

  it("returns [] without calling the RPC or the card catalog for a zero limit", async () => {
    const rpc = mockRpc([]);
    expect(await getRecommendedBooks({ seedBookIds: [SEED], locale: "en", limit: 0 })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(getBookCards).not.toHaveBeenCalled();
  });

  it("sends exact RPC arguments with the default limit of six and preserves RPC row order", async () => {
    const rpc = mockRpc([{ book_id: BOOK_C, score: 10, pinned: true }, { book_id: BOOK_A, score: 5, pinned: false }]);

    const result = await getRecommendedBooks({
      seedBookIds: [SEED],
      excludeBookIds: [SEED, OWNED_B],
      locale: "en",
    });

    expect(rpc).toHaveBeenCalledWith("recommend_books", {
      p_seed_book_ids: [SEED],
      p_exclude_book_ids: [SEED, OWNED_B],
      p_locale: "en",
      p_limit: 6,
    });
    // RPC order is [C, A]; catalog order (mocked above) is [A, C]. Only order preservation from
    // the RPC produces this exact sequence.
    expect(result).toEqual([cardC, cardA]);
    // score/pinned must never leak onto the returned cards.
    expect(result[0]).not.toHaveProperty("score");
    expect(result[0]).not.toHaveProperty("pinned");
  });

  it("de-duplicates seed and exclusion ids without reordering them", async () => {
    // First-occurrence order here (BOOK_A, SEED / BOOK_C, OWNED_B) is the reverse of ascending id
    // order (SEED < OWNED_B < BOOK_A < BOOK_C), so a dedupe that sorted instead of preserving
    // first-occurrence order - e.g. `[...new Set(ids)].sort()` - would fail this assertion.
    const rpc = mockRpc([]);
    await getRecommendedBooks({
      seedBookIds: [BOOK_A, SEED, BOOK_A],
      excludeBookIds: [BOOK_C, OWNED_B, BOOK_C],
      locale: "en",
    });
    expect(rpc).toHaveBeenCalledWith("recommend_books", {
      p_seed_book_ids: [BOOK_A, SEED],
      p_exclude_book_ids: [BOOK_C, OWNED_B],
      p_locale: "en",
      p_limit: 6,
    });
  });

  it("passes the requested locale through to both the card catalog and the RPC", async () => {
    const rpc = mockRpc([]);
    await getRecommendedBooks({ seedBookIds: [SEED], locale: "vi" });
    expect(getBookCards).toHaveBeenCalledWith("vi");
    expect(rpc).toHaveBeenCalledWith("recommend_books", expect.objectContaining({ p_locale: "vi" }));
  });

  it.each([
    { requested: 3, expected: 3 },
    { requested: 6, expected: 6 },
    // A limit above the shelf cap must be clamped to 6, not passed through or left at some other
    // value - this case only passes when the clamp's upper bound is enforced.
    { requested: 20, expected: 6 },
  ])("clamps the requested limit $requested to $expected", async ({ requested, expected }) => {
    const rpc = mockRpc([]);
    await getRecommendedBooks({ seedBookIds: [SEED], locale: "en", limit: requested });
    expect(rpc).toHaveBeenCalledWith("recommend_books", expect.objectContaining({ p_limit: expected }));
  });

  it("clamps a negative limit to zero and returns [] without calling the RPC", async () => {
    const rpc = mockRpc([]);
    expect(await getRecommendedBooks({ seedBookIds: [SEED], locale: "en", limit: -5 })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("drops RPC rows whose book id has no matching card", async () => {
    const missingId = "30000000-0000-4000-8000-000000000099";
    mockRpc([{ book_id: BOOK_C, score: 10, pinned: false }, { book_id: missingId, score: 9, pinned: false }]);
    const result = await getRecommendedBooks({ seedBookIds: [SEED], locale: "en" });
    expect(result).toEqual([cardC]);
  });

  it("hides the database error, keeps it on cause, and logs it with the request ID", async () => {
    const dbError = { code: "42P01", message: "relation secret_table does not exist" };
    mockRpc(null, dbError);

    const rejection = await getRecommendedBooks({ seedBookIds: [SEED], locale: "en", requestId: "req_reco123" }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (error: unknown) => error as Error,
    );

    expect(rejection.message).toBe("getRecommendedBooks failed.");
    expect(rejection.message).not.toContain("secret_table");
    expect(rejection.cause).toBe(dbError);
    expect(console.error).toHaveBeenCalledWith("Recommendation read failed.", {
      operation: "getRecommendedBooks",
      code: "42P01",
      message: "relation secret_table does not exist",
      requestId: "req_reco123",
    });
  });

  // Regression: a failed shelf read used to reach the page and take it down with it. The library
  // page and the prerendered topic/author pages render the shelf as decoration below their real
  // content, so the read must degrade to an empty shelf instead.
  it("returns an empty shelf instead of throwing when the RPC fails", async () => {
    mockRpc(null, { code: "42883", message: "function public.recommend_books does not exist" });

    await expect(
      getShelfRecommendations({ seedBookIds: [SEED], locale: "en", requestId: "req_reco123" }),
    ).resolves.toEqual([]);
    // The DAL still logged the cause once, with the request ID, before swallowing it.
    expect(console.error).toHaveBeenCalledWith("Recommendation read failed.", {
      operation: "getRecommendedBooks",
      code: "42883",
      message: "function public.recommend_books does not exist",
      requestId: "req_reco123",
    });
  });

  // Regression: failure() used to read headers() itself. On the static topic and author pages that
  // marks the route dynamic even inside a try/catch - at build time it silently dropped the
  // prerender, and a NEXT_PHASE guard only covered the build, not a runtime regeneration after
  // revalidatePath. The DAL now never reads headers(); a static caller simply supplies no ID.
  it.each([undefined, "phase-production-build", "phase-production-server"])(
    "reads no headers and logs a null request ID for a static caller (NEXT_PHASE=%s)",
    async (phase) => {
      const previousPhase = process.env.NEXT_PHASE;
      if (phase === undefined) delete process.env.NEXT_PHASE;
      else process.env.NEXT_PHASE = phase;
      mockRpc(null, { code: "42883", message: "function public.recommend_books does not exist" });

      try {
        await expect(getShelfRecommendations({ seedBookIds: [SEED], locale: "en" })).resolves.toEqual([]);
        expect(headers).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith("Recommendation read failed.", {
          operation: "getRecommendedBooks",
          code: "42883",
          message: "function public.recommend_books does not exist",
          requestId: null,
        });
      } finally {
        if (previousPhase === undefined) delete process.env.NEXT_PHASE;
        else process.env.NEXT_PHASE = previousPhase;
      }
    },
  );

  // Degrading to an empty shelf must not swallow Next.js control flow thrown through this stack.
  it("rethrows a Next.js control-flow error instead of degrading it to an empty shelf", async () => {
    let control: unknown;
    try {
      notFound();
    } catch (error) {
      control = error;
    }
    vi.mocked(getBookCards).mockRejectedValue(control);
    mockRpc([]);

    await expect(getShelfRecommendations({ seedBookIds: [SEED], locale: "en" })).rejects.toBe(control);
  });

  it("passes rows through unchanged when the shelf read succeeds", async () => {
    mockRpc([{ book_id: BOOK_C, score: 10, pinned: false }]);
    await expect(getShelfRecommendations({ seedBookIds: [SEED], locale: "en" })).resolves.toEqual([cardC]);
  });
});
