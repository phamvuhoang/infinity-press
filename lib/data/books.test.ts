// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  BookNotReadyError,
  BookNotFoundError,
  createBook,
  DuplicateCanonicalKeyError,
  DuplicateSlugError,
  getAdminBook,
  listAdminBooks,
  publishBook,
  saveBookLocalization,
  SeriesPositionTakenError,
  setBookRelations,
  setBookRetailLinks,
  setRelatedBooks,
  updateOffer,
  updateBookDetails,
  unpublishBook,
} from "@/lib/data/books";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const relatedA = "b1000000-0000-4000-8000-000000000001";
const relatedB = "b1000000-0000-4000-8000-000000000002";
const retailLink = { retailer: "tiki", label: null, url: "https://tiki.vn/x", priceMinor: null, currency: null, active: true } as const;

const createInput = {
  canonicalKey: "the-golden-book",
  authorId: null,
  authorName: "Jane Austen",
  locale: "vi" as const,
  language: "en" as const,
  title: "The Golden Book",
  slug: "cuon-sach-vang",
  market: "VN",
  currency: "VND",
  priceMinor: 0,
};

const localizationInput = {
  locale: "vi" as const,
  slug: "cuon-sach-vang",
  title: "The Golden Book",
  subtitle: null,
  shortDescription: null,
  description: "Mô tả",
  audience: null,
  keyIdeas: [{ title: "Quan sát", summary: "" }],
  faq: [],
  seoTitle: null,
  seoDescription: null,
};

const editorRow = {
  id: bookId,
  canonical_key: "the-golden-book",
  original_language: "en",
  status: "draft",
  primary_author_id: "4a1b2c3d-0000-4000-8000-000000000001",
  author: { display_name: "Jane Austen", localizations: [{ id: "5a1b2c3d-0000-4000-8000-000000000003" }] },
  localizations: [
    {
      id: "5a1b2c3d-0000-4000-8000-000000000002",
      locale: "en",
      slug: "golden",
      title: "Golden",
      subtitle: null,
      short_description: null,
      description: null,
      audience: null,
      key_ideas: [],
      faq: [],
      seo_title: null,
      seo_description: null,
    },
    {
      id: "5a1b2c3d-0000-4000-8000-000000000001",
      locale: "vi",
      slug: "cuon-sach-vang",
      title: "Cuốn sách vàng",
      subtitle: null,
      short_description: null,
      description: "Mô tả",
      audience: null,
      key_ideas: [{ title: "Quan sát", summary: "" }],
      faq: [],
      seo_title: null,
      seo_description: null,
    },
  ],
  editions: [
    {
      id: "6a1b2c3d-0000-4000-8000-000000000001",
      language_code: "en",
      edition_number: 1,
      status: "draft",
      active_publication_id: null,
      publication: null,
      skus: [
        {
          id: "7a1b2c3d-0000-4000-8000-000000000001",
          active: true,
          offers: [
            { id: "8a1b2c3d-0000-4000-8000-000000000001", market_code: "VN", currency: "VND", price_minor: 0, active: true, starts_at: null, ends_at: null, sale_kind: null, sale_percent_off: null, sale_amount_off_minor: null, sale_starts_at: null, sale_ends_at: null, offer_effective_price_minor: 0 },
          ],
        },
      ],
    },
  ],
  topics: [{ topic_id: "9a1b2c3d-0000-4000-8000-000000000001" }],
  // Deliberately not in position order: PostgREST does not promise one, so the DTO must sort.
  // 10 and 2 rather than 2 and 1, so a lexicographic sort would put these two the wrong way round.
  related: [
    { related_book_id: relatedA, position: 10 },
    { related_book_id: relatedB, position: 2 },
  ],
  // Out of position order and with a bigint-as-string price, like related: the DTO must sort and coerce.
  retail_links: [
    { id: "c1000000-0000-4000-8000-000000000002", retailer: "other", label: "ABC", url: "https://abc.example/x", price_minor: "129000" as unknown as number, currency: "VND", position: 10, active: false },
    { id: "c1000000-0000-4000-8000-000000000001", retailer: "shopee", label: null, url: "https://shopee.vn/x", price_minor: null, currency: null, position: 2, active: true },
  ],
  defaults: [{ language_code: "en", edition_id: "6a1b2c3d-0000-4000-8000-000000000001" }],
  series: { series_id: "aa1b2c3d-0000-4000-8000-000000000001", position: 2 },
};

function queryResult(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn(() => query),
    order: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: (value: typeof result) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const detailsInput = { canonicalKey: "updated", originalLanguage: "vi" as const, primaryAuthorId: editorRow.primary_author_id };
const offerInput = { marketCode: "VN", currency: "VND", priceMinor: 0, active: true, sale: null };
const relationInput = { topicIds: ["9a1b2c3d-0000-4000-8000-000000000001"], seriesId: null, seriesPosition: null };

describe("admin gate ordering", () => {
  it.each([
    ["createBook", () => createBook(createInput)],
    ["getAdminBook", () => getAdminBook(bookId)],
    ["updateOffer", () => updateOffer("8a1b2c3d-0000-4000-8000-000000000001", offerInput)],
    ["publishBook", () => publishBook(bookId)],
    ["listAdminBooks", () => listAdminBooks()],
    ["updateBookDetails", () => updateBookDetails(bookId, detailsInput)],
    ["saveBookLocalization", () => saveBookLocalization(bookId, localizationInput)],
    ["setBookRelations", () => setBookRelations(bookId, relationInput)],
    ["setRelatedBooks", () => setRelatedBooks(bookId, [relatedA])],
    ["unpublishBook", () => unpublishBook(bookId)],
  ])("%s never builds a client when the admin gate denies", async (_name, call) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(call()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("createBook", () => {
  it("calls admin_create_book with the validated fields", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: bookId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createBook(createInput)).resolves.toEqual({ bookId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_book", {
      p_canonical_key: "the-golden-book",
      p_author_id: null,
      p_author_name: "Jane Austen",
      p_locale: "vi",
      p_language: "en",
      p_title: "The Golden Book",
      p_slug: "cuon-sach-vang",
      p_market: "VN",
      p_currency: "VND",
      p_price_minor: 0,
    });
  });

  it("passes an existing author ID without relying on its display name", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: bookId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await createBook({ ...createInput, authorId: editorRow.primary_author_id, authorName: "" });

    expect(fake.rpc).toHaveBeenCalledWith(
      "admin_create_book",
      expect.objectContaining({ p_author_id: editorRow.primary_author_id, p_author_name: "" }),
    );
  });

  it.each([
    ["books_canonical_key_key", DuplicateCanonicalKeyError],
    ["book_localizations_locale_slug_key", DuplicateSlugError],
  ] as const)("maps a %s violation to its typed error", async (constraint, ErrorClass) => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createBook(createInput)).rejects.toBeInstanceOf(ErrorClass);
  });
});

describe("getAdminBook", () => {
  it("builds the editor DTO, orders vi first, and computes readiness", async () => {
    const fake = fakeSupabaseClient({
      tables: { books: { data: editorRow, error: null }, media_assets: { data: null, error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const book = await getAdminBook(bookId);

    expect(book.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
    expect(book.localization).toEqual({ locale: "vi", slug: "cuon-sach-vang", title: "Cuốn sách vàng" });
    expect(book.editions).toEqual([
      { id: "6a1b2c3d-0000-4000-8000-000000000001", languageCode: "en", editionNumber: 1, status: "draft", isDefault: true, activePublicationId: null, offerCount: 1, hasLiveOffer: true },
    ]);
    expect(book.topicIds).toEqual(["9a1b2c3d-0000-4000-8000-000000000001"]);
    expect(book.relatedBookIds).toEqual([relatedB, relatedA]);
    expect(book.retailLinks.map((link) => [link.retailer, link.priceMinor, link.active])).toEqual([
      ["shopee", null, true],
      ["other", 129000, false],
    ]);
    expect(book.series).toEqual({ seriesId: "aa1b2c3d-0000-4000-8000-000000000001", position: 2 });
    expect(book.cover).toBeNull();
    expect(book.readinessIssues).toEqual(["missing_cover", "missing_publication"]);
    expect(book).not.toHaveProperty("offer");
    expect(book).not.toHaveProperty("edition");
  });

  it("treats an author without localized copy as missing", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        books: { data: { ...editorRow, author: { display_name: "Jane Austen", localizations: [] } }, error: null },
        media_assets: { data: null, error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const book = await getAdminBook(bookId);

    expect(book.readinessIssues).toContain("missing_author");
  });
});

describe("listAdminBooks", () => {
  it("reads cover presence without requesting the private storage key", async () => {
    const booksQuery = queryResult({ data: [editorRow], error: null });
    const coversQuery = queryResult({ data: [], error: null });
    const from = vi.fn((table: string) => (table === "books" ? booksQuery : coversQuery));
    vi.mocked(createClient).mockResolvedValue({ from, rpc: vi.fn() } as unknown as SessionClient);

    await listAdminBooks();

    expect(coversQuery.select).toHaveBeenCalledWith("owner_id, alt_text");
    expect(coversQuery.select).not.toHaveBeenCalledWith(expect.stringContaining("storage_key"));
  });

  it("filters by title or canonical key and reports readiness", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        books: { data: [editorRow, { ...editorRow, id: "3a1b2c3d-0000-4000-8000-000000000002", canonical_key: "other", localizations: [] }], error: null },
        media_assets: { data: [{ owner_id: bookId }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const books = await listAdminBooks("vàng");

    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ id: bookId, title: "Cuốn sách vàng", readinessIssues: ["missing_publication"] });
  });
});

describe("saveBookLocalization", () => {
  it("sends key ideas and FAQ as JSON arrays", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: "5a1b2c3d-0000-4000-8000-000000000001", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await saveBookLocalization(bookId, localizationInput);

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_book_localization", expect.objectContaining({
      p_book_id: bookId,
      p_key_ideas: [{ title: "Quan sát", summary: "" }],
      p_faq: [],
    }));
  });

  it("maps a slug collision to DuplicateSlugError", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "book_localizations_locale_slug_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(saveBookLocalization(bookId, localizationInput)).rejects.toBeInstanceOf(DuplicateSlugError);
  });
});

describe("setBookRelations", () => {
  it("maps a taken series position to SeriesPositionTakenError", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "23505", message: 'violates unique constraint "book_series_series_id_position_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(
      setBookRelations(bookId, { topicIds: [], seriesId: "aa1b2c3d-0000-4000-8000-000000000001", seriesPosition: 1 }),
    ).rejects.toBeInstanceOf(SeriesPositionTakenError);
  });
});

describe("publishBook", () => {
  it("turns EB010 into BookNotReadyError with the issue codes", async () => {
    const fake = fakeSupabaseClient({
      rpc: { data: null, error: { code: "EB010", message: "publish_book: book is not ready: missing_cover,missing_publication" } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const error = await publishBook(bookId).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BookNotReadyError);
    expect((error as BookNotReadyError).issues).toEqual(["missing_cover", "missing_publication"]);
  });
});

describe("read boundaries", () => {
  it("returns a 404 for a malformed id before building a client", async () => {
    await expect(getAdminBook("bad-id")).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns a 404 for a missing book", async () => {
    const fake = fakeSupabaseClient({});
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(getAdminBook(bookId)).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("preserves all localization fields and builds the public cover URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co/");
    const fake = fakeSupabaseClient({ tables: {
      books: { data: { ...editorRow, series: [editorRow.series], editions: [{ ...editorRow.editions[0], status: "published", active_publication_id: bookId, publication: [{ status: "published" }] }] }, error: null },
      media_assets: { data: null, error: { code: "42501", message: "permission denied" } },
    }, rpc: { data: [{ storage_key: "books/abc/cover.png", alt_text: "Golden cover" }], error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const book = await getAdminBook(bookId);
    expect(book.localizations[0]).toEqual({
      id: "5a1b2c3d-0000-4000-8000-000000000001", locale: "vi", slug: "cuon-sach-vang", title: "Cuốn sách vàng",
      subtitle: null, shortDescription: null, description: "Mô tả", audience: null,
      keyIdeas: [{ title: "Quan sát", summary: "" }], faq: [], seoTitle: null, seoDescription: null,
    });
    expect(book.cover).toEqual({ storageKey: "books/abc/cover.png", altText: "Golden cover", publicUrl: "https://example.supabase.co/storage/v1/object/public/covers/books/abc/cover.png" });
    expect(fake.rpc).toHaveBeenCalledWith("admin_get_book_cover", { p_book_id: bookId });
    expect(fake.from).not.toHaveBeenCalledWith("media_assets");
    expect(book.series).toEqual({ seriesId: editorRow.series.series_id, position: 2 });
    expect(book.readinessIssues).toEqual([]);
  });

  it.each([
    [true, true, null, null, true],
    [false, true, null, null, false],
    [true, false, null, null, false],
    [true, true, "2026-09-14T00:00:00Z", null, false],
    [true, true, "2026-09-13T00:00:00Z", null, true],
    [true, true, null, "2026-09-13T00:00:00Z", false],
    [true, true, null, "2026-09-14T00:00:00Z", true],
  ])("summarizes an edition's live offer for SKU=%s offer=%s start=%s end=%s", async (skuActive, active, starts_at, ends_at, live) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    const row = structuredClone(editorRow);
    row.editions[0].skus[0].active = skuActive;
    Object.assign(row.editions[0].skus[0].offers[0], { active, starts_at, ends_at });
    const fake = fakeSupabaseClient({ tables: { books: { data: row, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    const edition = (await getAdminBook(bookId)).editions[0];
    expect(edition.hasLiveOffer).toBe(live);
    expect(edition.offerCount).toBe(skuActive ? 1 : 0);
  });

  it("never requires an offer to publish: a work with no live offer lists no offer issue", async () => {
    const row = structuredClone(editorRow);
    row.editions[0].skus[0].offers = [];
    const fake = fakeSupabaseClient({ tables: { books: { data: row, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    expect((await getAdminBook(bookId)).readinessIssues).not.toContain("missing_offer");
  });

  it("counts a work as published only when an edition is published with a live publication", async () => {
    const row = structuredClone(editorRow);
    Object.assign(row.editions[0], { status: "published", active_publication_id: "p1", publication: { status: "published" } });
    const fake = fakeSupabaseClient({ tables: { books: { data: row, error: null }, media_assets: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    expect((await getAdminBook(bookId)).readinessIssues).not.toContain("missing_publication");
    expect((await getAdminBook(bookId)).editions[0].activePublicationId).toBe("p1");
  });

  it("handles missing nested records and falls back to the canonical key", async () => {
    const row = { ...editorRow, localizations: [], author: null, editions: [], topics: [], series: null };
    const fake = fakeSupabaseClient({ tables: { books: { data: [row], error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    expect(await listAdminBooks("  GOLDEN  ")).toEqual([{
      id: bookId, canonicalKey: "the-golden-book", title: "the-golden-book", authorName: "", status: "draft", hasActivePublication: false,
      readinessIssues: ["missing_localization", "missing_author", "missing_cover", "missing_publication"],
    }]);
    expect(await listAdminBooks("no match")).toEqual([]);
  });
});

describe("write boundaries", () => {
  const writes = [
    ["details", (id: string) => updateBookDetails(id, detailsInput)],
    ["offer", (id: string) => updateOffer(id, offerInput)],
    ["localization", (id: string) => saveBookLocalization(id, localizationInput)],
    ["relations", (id: string) => setBookRelations(id, relationInput)],
    ["related books", (id: string) => setRelatedBooks(id, [relatedA])],
    ["retail links", (id: string) => setBookRetailLinks(id, [])],
    ["publish", (id: string) => publishBook(id)],
    ["unpublish", (id: string) => unpublishBook(id)],
  ] as const;

  it.each(writes)("rejects invalid %s target before building a client", async (_name, write) => {
    await expect(write("invalid")).rejects.toBeInstanceOf(BookNotFoundError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(writes)("maps a missing %s target to BookNotFoundError", async (_name, write) => {
    const result = { data: null, error: { code: "P0002", message: "private missing record" } };
    const fake = fakeSupabaseClient({ tables: { books: result, editions: result, offers: result }, rpc: result });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(write(bookId)).rejects.toBeInstanceOf(BookNotFoundError);
  });

  it.each([
    ["books", () => updateBookDetails(bookId, detailsInput), { canonical_key: "updated", original_language: "vi", primary_author_id: editorRow.primary_author_id }],
    ["offers", () => updateOffer(bookId, offerInput), { market_code: "VN", currency: "VND", price_minor: 0, active: true, sale_kind: null, sale_percent_off: null, sale_amount_off_minor: null, sale_starts_at: null, sale_ends_at: null }],
  ] as const)("writes validated columns to the exact %s target", async (table, write, payload) => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: bookId }], error: null });
    const eq = vi.fn(() => ({ select }));
    const update = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ update }));
    vi.mocked(createClient).mockResolvedValue({ from } as unknown as SessionClient);
    await expect(write()).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith(table);
    expect(update).toHaveBeenCalledWith(payload);
    expect(eq).toHaveBeenCalledWith("id", bookId);
  });

  it.each(writes.slice(0, 2))("rejects a %s update that affected no row", async (_name, write) => {
    const result = { data: [], error: null };
    const fake = fakeSupabaseClient({ tables: { books: result, editions: result, offers: result } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(write(bookId)).rejects.toBeInstanceOf(BookNotFoundError);
  });

  it.each([
    ["admin_set_book_relations", () => setBookRelations(bookId, relationInput), { p_book_id: bookId, p_topic_ids: relationInput.topicIds, p_series_id: null, p_series_position: null }],
    ["admin_set_related_books", () => setRelatedBooks(bookId, [relatedB, relatedA]), { p_book_id: bookId, p_related_book_ids: [relatedB, relatedA] }],
    ["admin_set_book_retail_links", () => setBookRetailLinks(bookId, [retailLink]), { p_book_id: bookId, p_links: [retailLink] }],
    ["publish_book", () => publishBook(bookId), { p_book_id: bookId }],
    ["unpublish_book", () => unpublishBook(bookId), { p_book_id: bookId }],
  ] as const)("calls %s with its validated arguments", async (rpc, write, args) => {
    const fake = fakeSupabaseClient({});
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(write()).resolves.toBeUndefined();
    expect(fake.rpc).toHaveBeenCalledWith(rpc, args);
  });

  it.each(["23505", "42501", "XX000"])("keeps unknown %s error details out of thrown messages", async (code) => {
    const result = { data: null, error: { code, message: "SECRET database detail" } };
    const fake = fakeSupabaseClient({ tables: { books: result, editions: result, offers: result }, rpc: result });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    for (const call of [() => createBook(createInput), () => getAdminBook(bookId), () => listAdminBooks(), ...writes.map(([, write]) => () => write(bookId))]) {
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("SECRET");
    }
  });
});
