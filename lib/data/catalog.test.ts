// @vitest-environment node
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerEnv } from "@/lib/config/server-env";
import {
  getActiveEntitlementBookIds,
  getBookActionState,
  getBookCardById,
  getBookCards,
  getBookPage,
  getEntityPage,
  getSampleReaderBook,
  publicBookAction,
  searchCatalog,
} from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { resolveSamplePublicationId } from "@/lib/reader/session";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
// A genuine cross-module dependency, unlike getBookPage: getSampleReaderBook calls it from a
// different file (lib/reader/session.ts), so mocking it here actually reaches the call site -
// which self-mocking getBookPage would not, since getSampleReaderBook's internal call to getBookPage
// is a same-module reference that vi.mock cannot intercept. The getSampleReaderBook tests below
// exercise getBookPage for real, through mockRpc, matching this file's existing convention instead.
vi.mock("@/lib/reader/session", () => ({
  resolveSamplePublicationId: vi.fn(),
}));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_ID = "30000000-0000-4000-8000-000000000002";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    book_id: BOOK_ID,
    slug: "a-book",
    title: "A Book",
    subtitle: null,
    short_description: "Short",
    author_name: "An Author",
    author_slug: "an-author",
    cover_path: `books/${BOOK_ID}/cover.png`,
    cover_alt: "Cover of A Book",
    price_minor: 0,
    currency: "VND",
    has_active_publication: true,
    has_sample: true,
    series_slug: "harbour",
    series_name: "Harbour",
    series_position: 2,
    topics: [{ slug: "habits", name: "Habits" }],
    featured: false,
    shelf_position: null,
    created_at: "2026-09-01T00:00:00+00:00",
    list_price_minor: null,
    sale_ends_at: null,
    ...overrides,
  };
}

function mockRpc(results: Record<string, { data: unknown; error: unknown }>) {
  const rpc = vi.fn((name: string) =>
    Promise.resolve(results[name] ?? { data: null, error: null }),
  );
  vi.mocked(createPublicClient).mockReturnValue({
    rpc,
  } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

function mockEntitlements(
  rows: { book_id: string }[] | null,
  error: unknown = null,
) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error }).then(resolve);
  const from = vi.fn(() => builder);
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<
    ReturnType<typeof createClient>
  >);
  return { from, builder };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(
    new Headers({ "x-request-id": "req_catalog123" }) as never,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.mocked(getServerEnv).mockReturnValue({
    paymentProvider: "simulator",
  } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCurrentProfile).mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getBookCards", () => {
  it("maps a row to a public card", async () => {
    const rpc = mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
    });
    const [book] = await getBookCards("en");
    expect(rpc).toHaveBeenCalledWith("catalog_book_cards", { p_locale: "en" });
    expect(book).toEqual({
      bookId: BOOK_ID,
      slug: "a-book",
      title: "A Book",
      subtitle: null,
      shortDescription: "Short",
      author: { name: "An Author", slug: "an-author" },
      cover: {
        url: `http://127.0.0.1:54321/storage/v1/object/public/covers/books/${BOOK_ID}/cover.png`,
        alt: "Cover of A Book",
      },
      offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
      hasActivePublication: true,
      hasSample: true,
      series: { slug: "harbour", name: "Harbour", position: 2 },
      topics: [{ slug: "habits", name: "Habits" }],
      featured: false,
      shelfPosition: null,
      createdAt: "2026-09-01T00:00:00+00:00",
    });
  });

  it("carries the list price and sale end while a sale runs", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow({ price_minor: 90300, list_price_minor: 129000, sale_ends_at: "2026-11-01T00:00:00+00:00" })],
        error: null,
      },
    });
    const [book] = await getBookCards("en");
    expect(book.offer).toEqual({ priceMinor: 90300, currency: "VND", listPriceMinor: 129000, saleEndsAt: "2026-11-01T00:00:00+00:00" });
  });

  it("drops a missing offer, cover, series, and malformed topics", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [
          cardRow({
            price_minor: null,
            currency: null,
            cover_path: null,
            series_slug: null,
            topics: "oops",
          }),
        ],
        error: null,
      },
    });
    const [book] = await getBookCards("en");
    expect(book.offer).toBeNull();
    expect(book.cover).toBeNull();
    expect(book.series).toBeNull();
    expect(book.topics).toEqual([]);
  });
});

describe("getBookCardById", () => {
  // The targeted route-handler read: a single row by id instead of the full catalog_book_cards
  // scan, mirroring getPublicBundleById in lib/data/public-bundles.ts.
  it("resolves the book by id in the requested locale", async () => {
    const rpc = mockRpc({
      catalog_book_card_by_id: { data: [cardRow()], error: null },
    });
    const book = await getBookCardById("en", BOOK_ID);
    expect(rpc).toHaveBeenCalledWith("catalog_book_card_by_id", {
      p_locale: "en",
      p_book_id: BOOK_ID,
    });
    expect(book?.bookId).toBe(BOOK_ID);
    expect(book?.slug).toBe("a-book");
  });

  // Covers both an id that does not exist at all and one that exists but is not published/localized
  // in the requested locale - the route handler treats them the same 404.
  it("returns null when the id has no visible card in the requested locale", async () => {
    mockRpc({ catalog_book_card_by_id: { data: [], error: null } });
    await expect(getBookCardById("en", BOOK_ID)).resolves.toBeNull();
  });
});

describe("read failures", () => {
  const dbError = {
    code: "42P01",
    message: "relation secret_table does not exist",
  };
  const cards = { data: [cardRow()], error: null };

  const cases: { operation: string; run: () => Promise<unknown> }[] = [
    {
      operation: "getBookCards",
      run: () => {
        mockRpc({ catalog_book_cards: { data: null, error: dbError } });
        return getBookCards("en");
      },
    },
    {
      operation: "getBookCardById",
      run: () => {
        mockRpc({ catalog_book_card_by_id: { data: null, error: dbError } });
        return getBookCardById("en", BOOK_ID);
      },
    },
    {
      operation: "getBookPage",
      run: () => {
        mockRpc({
          catalog_book_cards: cards,
          catalog_book_page: { data: null, error: dbError },
        });
        return getBookPage("en", "a-book");
      },
    },
    {
      operation: "getEntityPage",
      run: () => {
        mockRpc({
          catalog_book_cards: cards,
          catalog_entity_page: { data: null, error: dbError },
        });
        return getEntityPage("series", "en", "harbour");
      },
    },
    {
      operation: "getActiveEntitlementBookIds",
      run: () => {
        mockEntitlements(null, dbError);
        return getActiveEntitlementBookIds(PROFILE_ID);
      },
    },
    {
      operation: "searchCatalog",
      run: () => {
        mockRpc({
          catalog_book_cards: cards,
          search_catalog: { data: null, error: dbError },
        });
        return searchCatalog("en", "exact");
      },
    },
  ];

  it.each(cases)(
    "$operation hides database error text and logs it with the request ID",
    async ({ operation, run }) => {
      const rejection = await run().then(
        () => {
          throw new Error("expected a rejection");
        },
        (error: unknown) => error as Error,
      );

      expect(rejection.message).toBe(`${operation} failed.`);
      expect(rejection.message).not.toContain("secret_table");
      expect(rejection.cause).toBe(dbError);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("Catalog read failed.", {
        operation,
        code: "42P01",
        message: "relation secret_table does not exist",
        requestId: "req_catalog123",
      });
    },
  );

  it("logs an unexpected response shape without a request scope", async () => {
    vi.mocked(headers).mockRejectedValue(
      new Error("headers was called outside a request scope"),
    );
    mockRpc({
      catalog_book_cards: cards,
      search_catalog: { data: [{ kind: "nope" }], error: null },
    });

    await expect(searchCatalog("en", "exact")).rejects.toThrow(
      "searchCatalog failed.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "Catalog read failed.",
      expect.objectContaining({
        operation: "searchCatalog",
        code: "invalid_response",
        requestId: null,
      }),
    );
  });
});

describe("getBookPage", () => {
  it("returns null for a malformed slug without a query", async () => {
    const rpc = mockRpc({});
    expect(await getBookPage("en", "Not A Slug")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null when the book is not visible", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      catalog_book_page: { data: null, error: null },
    });
    expect(await getBookPage("en", "a-book")).toBeNull();
  });

  it("merges the card with the page content and drops invalid key ideas", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      catalog_book_page: {
        data: {
          bookId: BOOK_ID,
          description: "Long",
          audience: null,
          keyIdeas: [{ nope: true }],
          faq: [{ question: "Why?", answer: "Because." }],
          seoTitle: null,
          seoDescription: null,
          alternateSlug: "mot-cuon-sach",
        },
        error: null,
      },
    });
    const page = await getBookPage("en", "a-book");
    expect(page?.title).toBe("A Book");
    expect(page?.description).toBe("Long");
    expect(page?.keyIdeas).toEqual([]);
    expect(page?.faq).toEqual([{ question: "Why?", answer: "Because." }]);
    expect(page?.alternateSlug).toBe("mot-cuon-sach");
  });

  it("keeps https retail links and drops the whole list when one url is not https", async () => {
    const link = {
      id: "70000000-0000-4000-8000-000000000001",
      retailer: "shopee",
      label: null,
      url: "https://shopee.vn/x",
      priceMinor: null,
      currency: null,
    };
    const read = async (retailLinks: unknown[]) => {
      mockRpc({
        catalog_book_cards: { data: [cardRow()], error: null },
        catalog_book_page: { data: bookPageData({ retailLinks }), error: null },
      });
      return (await getBookPage("en", "a-book"))?.retailLinks;
    };
    expect(await read([link])).toEqual([link]);
    expect(await read([link, { ...link, url: "javascript:alert(1)" }])).toEqual([link]);
    expect(await read([{ ...link, retailer: "amazon" }, link])).toEqual([link]);
    expect(await read([{ ...link, url: "http://shopee.vn/x" }])).toEqual([]);
  });

  it("parses the review summary and falls back to null when absent or malformed", async () => {
    const read = async (reviewSummary?: unknown) => {
      mockRpc({
        catalog_book_cards: { data: [cardRow()], error: null },
        catalog_book_page: { data: bookPageData(reviewSummary === undefined ? {} : { reviewSummary }), error: null },
      });
      return (await getBookPage("en", "a-book"))?.reviewSummary;
    };
    expect(await read({ count: 3, average: 4.3333 })).toEqual({ count: 3, average: 4.3333 });
    expect(await read({ count: 3, average: "4.5" })).toEqual({ count: 3, average: 4.5 });
    expect(await read(null)).toBeNull();
    expect(await read()).toBeNull();
    expect(await read({ count: "x" })).toBeNull();
  });
});

describe("getEntityPage", () => {
  const entity = {
    id: "40000000-0000-4000-8000-000000000001",
    name: "Harbour",
    description: null,
    alternateSlug: null,
  };

  it("returns the series with its books in order", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [
          cardRow(),
          cardRow({ book_id: OTHER_ID, slug: "first", series_position: 1 }),
        ],
        error: null,
      },
      catalog_entity_page: { data: entity, error: null },
    });
    const page = await getEntityPage("series", "en", "harbour");
    expect(page?.name).toBe("Harbour");
    expect(page?.books.map((book) => book.slug)).toEqual(["first", "a-book"]);
  });

  it("returns null when the entity has no visible books", async () => {
    mockRpc({
      catalog_book_cards: { data: [], error: null },
      catalog_entity_page: { data: entity, error: null },
    });
    expect(await getEntityPage("series", "en", "harbour")).toBeNull();
  });
});

function bookPageData(overrides: Record<string, unknown> = {}) {
  return {
    bookId: BOOK_ID,
    description: null,
    audience: null,
    keyIdeas: [],
    faq: [],
    seoTitle: null,
    seoDescription: null,
    alternateSlug: null,
    ...overrides,
  };
}

describe("getSampleReaderBook", () => {
  it("returns null for a slug with no book page", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      catalog_book_page: { data: null, error: null },
    });

    await expect(getSampleReaderBook("en", "a-book")).resolves.toBeNull();
    expect(resolveSamplePublicationId).not.toHaveBeenCalled();
  });

  it("returns null when the book has no sample", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow({ has_sample: false })],
        error: null,
      },
      catalog_book_page: { data: bookPageData(), error: null },
    });

    await expect(getSampleReaderBook("en", "a-book")).resolves.toBeNull();
    expect(resolveSamplePublicationId).not.toHaveBeenCalled();
  });

  it("returns null when no publication can be resolved", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow({ has_sample: true })],
        error: null,
      },
      catalog_book_page: { data: bookPageData(), error: null },
    });
    vi.mocked(resolveSamplePublicationId).mockResolvedValue(null);

    await expect(getSampleReaderBook("en", "a-book")).resolves.toBeNull();
  });

  it("returns the publication and the book's action", async () => {
    mockRpc({
      catalog_book_cards: {
        data: [cardRow({ has_sample: true })],
        error: null,
      },
      catalog_book_page: { data: bookPageData(), error: null },
    });
    vi.mocked(resolveSamplePublicationId).mockResolvedValue("pub-1");

    await expect(getSampleReaderBook("en", "a-book")).resolves.toMatchObject({
      publicationId: "pub-1",
      slug: "a-book",
    });
    expect(resolveSamplePublicationId).toHaveBeenCalledWith(BOOK_ID);
  });
});

describe("book actions", () => {
  it("reads only the caller's own entitlements", async () => {
    const { from, builder } = mockEntitlements([{ book_id: BOOK_ID }]);
    expect(await getActiveEntitlementBookIds(PROFILE_ID)).toEqual(
      new Set([BOOK_ID]),
    );
    expect(from).toHaveBeenCalledWith("entitlements");
    expect(builder.eq).toHaveBeenCalledWith("profile_id", PROFILE_ID);
    expect(builder.eq).toHaveBeenCalledWith("status", "active");
  });

  const free = {
    bookId: BOOK_ID,
    offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
  };

  it("offers a signed-out reader get_free without reading entitlements", async () => {
    expect(await getBookActionState(free)).toEqual({
      action: "get_free",
      signedIn: false,
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("lets an entitled reader read", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue({
      id: PROFILE_ID,
    } as Awaited<ReturnType<typeof getCurrentProfile>>);
    mockEntitlements([{ book_id: BOOK_ID }]);
    expect(await getBookActionState(free)).toEqual({
      action: "read",
      signedIn: true,
    });
  });

  it("shows coming_soon for a paid book when payments are disabled", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      paymentProvider: "disabled",
    } as ReturnType<typeof getServerEnv>);
    expect(
      await getBookActionState({
        ...free,
        offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
      }),
    ).toEqual({
      action: "coming_soon",
      signedIn: false,
    });
  });
});

describe("publicBookAction", () => {
  it("answers for an anonymous visitor without reading a session", () => {
    expect(
      publicBookAction({
        bookId: "book-1",
        offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
        hasActivePublication: true,
      }),
    ).toBe("buy");
    expect(getCurrentProfile).not.toHaveBeenCalled();
  });

  it("never answers `read`, because an anonymous visitor owns nothing", () => {
    expect(
      publicBookAction({
        bookId: "book-1",
        offer: null,
        hasActivePublication: true,
      }),
    ).toBe("unavailable");
  });
});

describe("searchCatalog", () => {
  it("maps book hits to cards in rank order and keeps grouped hits", async () => {
    const rpc = mockRpc({
      catalog_book_cards: {
        data: [cardRow(), cardRow({ book_id: OTHER_ID, slug: "exact" })],
        error: null,
      },
      search_catalog: {
        data: [
          { kind: "book", slug: "a-book", name: "A Book", score: 1 },
          { kind: "book", slug: "exact", name: "Exact", score: 3 },
          { kind: "author", slug: "an-author", name: "An Author", score: 2 },
          { kind: "book", slug: "gone", name: "Gone", score: 3 },
        ],
        error: null,
      },
    });
    const results = await searchCatalog("en", "exact");
    expect(rpc).toHaveBeenCalledWith("search_catalog", {
      p_locale: "en",
      p_query: "exact",
    });
    expect(results.books.map((book) => book.slug)).toEqual(["exact", "a-book"]);
    expect(results.authors.map((hit) => hit.slug)).toEqual(["an-author"]);
  });

  it("returns idea and article hits unchanged in their own groups", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      search_catalog: {
        data: [
          { kind: "idea", slug: "idea-low", name: "Beta?", score: 1 },
          { kind: "idea", slug: "an-idea", name: "An idea?", score: 3 },
          { kind: "article", slug: "an-article", name: "An article", score: 2 },
          { kind: "book", slug: "a-book", name: "A Book", score: 1 },
          { kind: "topic", slug: "habits", name: "Habits", score: 1 },
        ],
        error: null,
      },
    });
    const results = await searchCatalog("en", "exact");
    expect(results.books.map((book) => book.slug)).toEqual(["a-book"]);
    expect(results.ideas).toEqual([
      { kind: "idea", slug: "an-idea", name: "An idea?", score: 3 },
      { kind: "idea", slug: "idea-low", name: "Beta?", score: 1 },
    ]);
    expect(results.articles).toEqual([
      { kind: "article", slug: "an-article", name: "An article", score: 2 },
    ]);
    expect(results.topics.map((hit) => hit.slug)).toEqual(["habits"]);
    expect(results.authors).toEqual([]);
    expect(results.series).toEqual([]);
  });

  it("rejects a hit kind the search does not know rather than guessing a route for it", async () => {
    mockRpc({
      catalog_book_cards: { data: [cardRow()], error: null },
      search_catalog: {
        data: [
          { kind: "bundle", slug: "a-bundle", name: "A bundle", score: 1 },
        ],
        error: null,
      },
    });
    await expect(searchCatalog("en", "exact")).rejects.toThrow(
      "searchCatalog failed.",
    );
  });
});
