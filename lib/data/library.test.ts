// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireUser } from "@/lib/auth/session";
import { getBookCards } from "@/lib/data/catalog";
import {
  deriveLibraryState,
  getLibrary,
  getOwnedEditionsOfBook,
  getReadableEdition,
  groupLibraryByWork,
  type LibraryItemDTO,
} from "@/lib/data/library";
import { getCurrentProfile } from "@/lib/data/profiles";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn(), getBookAcceptsQuestions: vi.fn(async () => true) }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: () => ({ siteUrl: "http://127.0.0.1:3000" }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const BOOK_ID = "30000000-0000-0000-0000-000000000001";
const EDITION_ID = "40000000-0000-0000-0000-000000000001";
const PUBLICATION_ID = "50000000-0000-0000-0000-000000000001";
const PROFILE_ID = "10000000-0000-0000-0000-000000000001";
// A second reader who also owns BOOK_ID. Present in every fixture below because an admin session
// can read their rows too (migration 20260913100000's "admin reads entitlements" / "admin reads
// library items" policies), which is exactly what these DALs must not be at the mercy of.
const OTHER_PROFILE_ID = "10000000-0000-0000-0000-000000000002";

type Row = Record<string, unknown>;

// PostgREST resolves an embedded filter ("entitlements.status") through the embedded object, so
// the fake below has to as well or every library row would be filtered out.
function valueAt(row: Row, column: string): unknown {
  return column.split(".").reduce<unknown>(
    (value, key) => (value && typeof value === "object" ? (value as Row)[key] : undefined),
    row,
  );
}

// `.maybeSingle()` and `.overrideTypes()` are both called on an already-narrowed query, and
// `.maybeSingle().overrideTypes()` chains the two - so the terminal value has to stay thenable
// after either one.
function thenable<T>(value: T) {
  return {
    overrideTypes: () => thenable(value),
    then: <R>(resolve: (value: T) => R, reject?: (reason: unknown) => R) =>
      Promise.resolve(value).then(resolve, reject),
  };
}

// A deliberately literal stand-in for PostgREST: it applies the query's own filters to the rows
// the session is allowed to see, and reproduces the one behaviour this file exists to pin -
// `maybeSingle()` on a result set of more than one row is an error, not a row.
function queryBuilder(rows: Row[]) {
  let current = rows;
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      current = current.filter((row) => valueAt(row, column) === value);
      return builder;
    },
    in: (column: string, values: unknown[]) => {
      current = current.filter((row) => values.includes(valueAt(row, column)));
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: () =>
      thenable(
        current.length > 1
          ? {
              data: null,
              error: {
                code: "PGRST116",
                message: "JSON object requested, multiple (or no) rows returned",
              },
            }
          : { data: current[0] ?? null, error: null },
      ),
    overrideTypes: () => thenable({ data: current, error: null }),
    then: <R>(resolve: (value: { data: Row[]; error: null }) => R, reject?: (reason: unknown) => R) =>
      Promise.resolve({ data: current, error: null }).then(resolve, reject),
  };
  return builder;
}

function fakeClient(tables: Record<string, Row[]>) {
  const from = vi.fn((table: string) => queryBuilder(tables[table] ?? []));
  return { from } as unknown as Awaited<ReturnType<typeof createClient>>;
}

// The stored `state` column matters in exactly one direction, which is what these fixtures set up.
// Ruling CQ found the column sitting at its 'unread' default forever while the live progress figure
// beside it moved, so the derived state leads - EXCEPT when the column says 'completed', which only
// save_reading_progress writes and which it refuses to downgrade. Passing 'unread' or 'reading'
// here therefore exercises the derivation; passing 'completed' exercises the database's promise.
function libraryRow(
  storedState: string,
  entitlementStatus: "active" | "revoked" = "active",
  profileId: string = PROFILE_ID,
) {
  return {
    profile_id: profileId,
    book_id: BOOK_ID,
    edition_id: EDITION_ID,
    state: storedState,
    added_at: "2026-09-01T00:00:00.000Z",
    entitlements: { status: entitlementStatus },
    editions: { id: EDITION_ID, language_code: "en", status: "published", active_publication_id: PUBLICATION_ID },
    books: {
      id: BOOK_ID,
      book_localizations: [{ locale: "en", slug: "a-book", title: "A Book" }],
    },
  };
}

function libraryClient(options: {
  items: Row[];
  progress: { publication_id: string; progression: number; total_progression?: number | null }[];
  profileId?: string;
}) {
  return fakeClient({
    library_items: options.items,
    reading_progress: options.progress.map((row) => ({
      profile_id: options.profileId ?? PROFILE_ID,
      ...row,
    })),
    media_assets: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue(
    {} as unknown as Awaited<ReturnType<typeof requireUser>>,
  );
  vi.mocked(getCurrentProfile).mockResolvedValue({
    id: PROFILE_ID,
    auth_user_id: "auth-user-id",
    display_name: null,
    locale: "en",
  });
  vi.mocked(getBookCards).mockResolvedValue([]);
});

function readableBookClient(options: { entitlements?: Row[]; progress?: Row[]; edition?: Row } = {}) {
  return fakeClient({
    entitlements: options.entitlements ?? [
      { id: "entitlement-id", profile_id: PROFILE_ID, book_id: BOOK_ID, edition_id: EDITION_ID, status: "active" },
    ],
    editions: [
      {
        id: EDITION_ID,
        book_id: BOOK_ID,
        language_code: "en",
        status: "published",
        active_publication_id: PUBLICATION_ID,
        books: {
          id: BOOK_ID,
          status: "published",
          author: { display_name: "Author display name", author_localizations: [{ locale: "en", name: "Localized author" }] },
          book_localizations: [{ locale: "en", slug: "source-book", title: "Source title" }],
        },
        ...options.edition,
      },
    ],
    reading_progress: options.progress ?? [],
  });
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    bookId: "related-book-id",
    slug: "related-book",
    title: "Related book",
    subtitle: null,
    shortDescription: null,
    author: { name: "Author display name", slug: "author" },
    cover: { url: "https://cdn.example/cover.jpg", alt: "Related book" },
    offer: null,
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getReadableEdition attribution", () => {
  it("returns localized attribution, canonical URL, and at most three deterministic published relations", async () => {
    vi.mocked(createClient).mockResolvedValue(readableBookClient());
    vi.mocked(getBookCards).mockResolvedValue([
      card({
        bookId: BOOK_ID,
        slug: "source-book",
        title: "Source title",
        author: { name: "Localized author", slug: "author" },
        series: { slug: "series", name: "Series", position: 2 },
        topics: [{ slug: "topic", name: "Topic" }],
      }),
      card({ bookId: "series-second", slug: "series-second", title: "Series second", series: { slug: "series", name: "Series", position: 3 } }),
      card({ bookId: "author-second", slug: "author-second", title: "Author second" }),
      card({ bookId: "topic-second", slug: "topic-second", title: "Topic second", author: { name: "Other", slug: "other" }, topics: [{ slug: "topic", name: "Topic" }] }),
      card({ bookId: "topic-third", slug: "topic-third", title: "Topic third", author: { name: "Other", slug: "other" }, topics: [{ slug: "topic", name: "Topic" }] }),
      card({ bookId: "unpublished", slug: "unpublished", title: "Must not recommend", hasActivePublication: false }),
    ] as never);

    const book = await getReadableEdition("en", EDITION_ID);

    expect(book).toMatchObject({
      bookId: BOOK_ID,
      title: "Source title",
      authorName: "Localized author",
      acceptsQuestions: true,
      canonicalBookUrl: "http://127.0.0.1:3000/en/books/source-book",
      relatedBooks: [
        { title: "Series second", authorName: "Author display name", href: "/en/books/series-second", coverUrl: "https://cdn.example/cover.jpg" },
        { title: "Author second", authorName: "Author display name", href: "/en/books/author-second", coverUrl: "https://cdn.example/cover.jpg" },
        { title: "Topic second", authorName: "Other", href: "/en/books/topic-second", coverUrl: "https://cdn.example/cover.jpg" },
      ],
    });
    expect(getBookCards).toHaveBeenCalledWith("en");
  });

  it("falls back to the author's display name, and returns no relations when this locale has no related cards", async () => {
    vi.mocked(createClient).mockResolvedValue(
      readableBookClient({
        edition: {
          books: {
            id: BOOK_ID,
            status: "published",
            author: { display_name: "Display-name fallback", author_localizations: [] },
            book_localizations: [{ locale: "en", slug: "source-book", title: "Source title" }],
          },
        },
      }),
    );
    vi.mocked(getBookCards).mockResolvedValue([card({ bookId: BOOK_ID, slug: "source-book" })] as never);

    await expect(getReadableEdition("en", EDITION_ID)).resolves.toMatchObject({
      authorName: "Display-name fallback",
      relatedBooks: [],
    });
  });

  it("opens an owned edition even when the work has no catalog card in the interface locale", async () => {
    vi.mocked(createClient).mockResolvedValue(readableBookClient());
    vi.mocked(getBookCards).mockResolvedValue([]);

    await expect(getReadableEdition("ja", EDITION_ID)).resolves.toMatchObject({
      editionId: EDITION_ID,
      languageCode: "en",
      title: "Source title",
      publicationId: PUBLICATION_ID,
      relatedBooks: [],
    });
  });

  it("excludes a related book that is localized only outside the current catalog locale", async () => {
    vi.mocked(createClient).mockResolvedValue(readableBookClient());
    const source = card({
      bookId: BOOK_ID,
      slug: "source-book",
      author: { name: "English author", slug: "author" },
    });
    const englishRelated = card({ bookId: "english-related", slug: "english-related", title: "English related" });
    const vietnameseOnlyRelated = card({ bookId: "vietnamese-only", slug: "sach-tieng-viet", title: "Sách tiếng Việt" });
    vi.mocked(getBookCards).mockImplementation(async (locale) =>
      locale === "en" ? [source, englishRelated] : [source, vietnameseOnlyRelated],
    );

    await expect(getReadableEdition("en", EDITION_ID)).resolves.toMatchObject({
      relatedBooks: [{ title: "English related", href: "/en/books/english-related" }],
    });
    expect(getBookCards).toHaveBeenCalledWith("en");
  });
});

describe("getLibrary state (Ruling CQ)", () => {
  it("omits a persisted library row when its referenced entitlement is revoked", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("reading", "revoked")], progress: [] }),
    );

    expect(await getLibrary("en")).toEqual([]);
  });

  // THE REGRESSION. Before this fix the card rendered the stored column verbatim beside a live
  // progress figure, so a reader 95% through a book saw "Not started - 95% read", in both
  // languages, and no test noticed.
  it("reports a part-read book as reading even though the stored column still says unread", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("unread")],
        progress: [{ publication_id: PUBLICATION_ID, progression: 0.95 }],
      }),
    );

    const [item] = await getLibrary("en");

    expect(item.progressPercent).toBe(95);
    expect(item.state).toBe("reading");
  });

  // A stored 'completed' with NO progress row is reachable, and not only through a stale column:
  // progress is keyed on books.active_publication_id, so a rollback or a republish moves that key
  // and leaves a reader who finished the old publication with no row against the new one. Spec §4.4
  // decides the answer - a completed book stays completed - so the card reads "Finished, 100%"
  // rather than resetting to "Not started". Pinned here because the behaviour is one a later reader
  // of getLibrary could plausibly "fix" by accident.
  it("keeps a completed book completed after the publication is republished", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("completed")], progress: [] }),
    );

    const [item] = await getLibrary("en");

    expect(item.state).toBe("completed");
    expect(item.progressPercent).toBe(100);
  });

  // The same contradiction in the other direction: a stored 'reading' with nothing behind it.
  // Only 'completed' is trusted out of the column, so this stays derived.
  it("reports a book with no progress row as unread even though the stored column says reading", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("reading")], progress: [] }),
    );

    const [item] = await getLibrary("en");

    expect(item.progressPercent).toBe(0);
    expect(item.state).toBe("unread");
  });

  // THE CROSS-TASK REGRESSION. save_reading_progress refuses to downgrade library_items.state from
  // 'completed' (migration 20260916100000) and pgTAP proves it, but getLibrary never read the
  // column, so the guarantee reached no reader: finish a book, reopen it, page back to chapter 2,
  // and the next save writes total_progression 0.2. The column stays 'completed' - correctly - and
  // the card used to flip to "In progress, 20%". Spec §4.4: a completed book stays completed if
  // the reader pages backwards.
  it("keeps a completed book completed after the reader pages backwards", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("completed")],
        progress: [{ publication_id: PUBLICATION_ID, progression: 0.2, total_progression: 0.2 }],
      }),
    );

    const [item] = await getLibrary("en");

    expect(item.state).toBe("completed");
    // And the percentage follows the state, never the raw figure - the invariant Ruling CQ
    // restored. "Finished - 20% read" is the same broken sentence in the other direction.
    expect(item.progressPercent).toBe(100);
  });

  // The pre-migration row the derivation still exists for: nothing wrote this column before
  // 20260916100000, so real progress sits beside a stored 'unread'. Trusting the column in that
  // direction would reset the card to "Not started".
  it("still derives the state for a pre-migration row whose column was never written", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("unread")],
        progress: [{ publication_id: PUBLICATION_ID, progression: 0.4, total_progression: null }],
      }),
    );

    const [item] = await getLibrary("en");

    expect(item.state).toBe("reading");
    expect(item.progressPercent).toBe(40);
  });

  it("reports a fully read book as completed", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("unread")],
        progress: [{ publication_id: PUBLICATION_ID, progression: 1 }],
      }),
    );

    const [item] = await getLibrary("en");

    expect(item.progressPercent).toBe(100);
    expect(item.state).toBe("completed");
  });

  // state tracks the RAW total_progression at the 0.99 threshold (it must match
  // save_reading_progress's SQL exactly), which does not fall on a percent boundary - so
  // progressPercent is reconciled to the state, rather than the other way around, whenever the two
  // would otherwise disagree. 0.992 is the load-bearing case: it is 'completed' by the raw
  // threshold but would round to "99%" undoctored, which is the exact "99% - Finished"
  // contradiction Ruling CQ exists to prevent.
  it.each([
    // total_progression 0 WITH a progress row is "opened but unmoved", which is 'reading' rather
    // than 'unread' - the unread case is the absence of a row, covered above.
    [0, 0, "reading"],
    [0.004, 0, "reading"],
    [0.5, 50, "reading"],
    // Just below the threshold - proves the reconciliation does not fire early.
    [0.98, 98, "reading"],
    // Crosses the SQL's own threshold while still rounding down to 99% undoctored - the band this
    // fix closes.
    [0.992, 100, "completed"],
    [0.99, 100, "completed"],
    [1, 100, "completed"],
  ] as const)(
    "total_progression %s renders %i%% and never contradicts its state",
    async (totalProgression, expectedPercent, expectedState) => {
      vi.mocked(createClient).mockResolvedValue(
        libraryClient({
          items: [libraryRow("unread")],
          progress: [
            {
              publication_id: PUBLICATION_ID,
              progression: totalProgression,
              total_progression: totalProgression,
            },
          ],
        }),
      );

      const [item] = await getLibrary("en");

      expect(item.progressPercent).toBe(expectedPercent);
      expect(item.state).toBe(expectedState);
      // The sentence-level invariant, independent of the table above: a card can never read
      // "completed" without also reading 100%, or vice versa.
      expect(item.state === "completed").toBe(item.progressPercent === 100);
    },
  );
});

// THE PRODUCTION 500 (/vi/read/[bookId], 2026-09-17 and 2026-09-20). Both DALs below read
// owner-scoped tables through the session client and left the scoping entirely to RLS - but an
// admin's session can read EVERY row of entitlements and library_items, so the moment a second
// reader owned the same book, an admin opening it selected two active entitlement rows and
// `maybeSingle()` answered PGRST116 ("JSON object requested, multiple (or no) rows returned"),
// which getReadableBook rethrows and the page turns into a 500. lib/data/orders.ts already states
// the rule this file was missing: RLS is the floor, not the filter - every read of an owner-scoped
// table also filters on the caller's own profile ID.
// The shelf used to render a hashed brand colour for every book because the DTO carried only the
// cover's alt text and no URL. Covers live in the public `covers` bucket and the catalog's card
// projection already turns them into a URL, so the library reads them from there.
describe("getLibrary cover art", () => {
  it("projects the public cover URL and alt text from the catalog card", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("unread")], progress: [] }),
    );
    vi.mocked(getBookCards).mockResolvedValue([
      card({ bookId: BOOK_ID, cover: { url: "https://cdn.example/a-book.jpg", alt: "A Book cover" } }),
    ] as never);

    const [item] = await getLibrary("en");

    expect(item.coverUrl).toBe("https://cdn.example/a-book.jpg");
    expect(item.coverAltText).toBe("A Book cover");
  });

  it("leaves the cover null when the book has no cover, so the typographic fallback renders", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("unread")], progress: [] }),
    );
    vi.mocked(getBookCards).mockResolvedValue([card({ bookId: BOOK_ID, cover: null })] as never);

    const [item] = await getLibrary("en");

    expect(item.coverUrl).toBeNull();
    expect(item.coverAltText).toBeNull();
  });

  it("never exposes a storage key", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("unread")], progress: [] }),
    );
    vi.mocked(getBookCards).mockResolvedValue([card({ bookId: BOOK_ID })] as never);

    const [item] = await getLibrary("en");

    expect(item).not.toHaveProperty("storageKey");
    expect(Object.keys(item).sort()).toEqual(
      [
        "bookId",
        "continueReadingUrl",
        "coverAltText",
        "coverUrl",
        "editionId",
        "languageCode",
        "progressPercent",
        "slug",
        "state",
        "title",
      ],
    );
  });
});

describe("owner scoping under an admin session", () => {
  it("opens a book for an admin while another reader holds an active entitlement to it", async () => {
    vi.mocked(createClient).mockResolvedValue(
      readableBookClient({
        entitlements: [
          { id: "mine", profile_id: PROFILE_ID, book_id: BOOK_ID, edition_id: EDITION_ID, status: "active" },
          { id: "theirs", profile_id: OTHER_PROFILE_ID, book_id: BOOK_ID, edition_id: EDITION_ID, status: "active" },
        ],
      }),
    );
    vi.mocked(getBookCards).mockResolvedValue([
      card({ bookId: BOOK_ID, slug: "source-book", title: "Source title" }),
    ] as never);

    await expect(getReadableEdition("en", EDITION_ID)).resolves.toMatchObject({
      bookId: BOOK_ID,
      publicationId: PUBLICATION_ID,
    });
  });

  it("refuses to open a book the caller does not own, even when another reader does", async () => {
    vi.mocked(createClient).mockResolvedValue(
      readableBookClient({
        entitlements: [{ id: "theirs", profile_id: OTHER_PROFILE_ID, book_id: BOOK_ID, edition_id: EDITION_ID, status: "active" }],
      }),
    );
    vi.mocked(getBookCards).mockResolvedValue([
      card({ bookId: BOOK_ID, slug: "source-book", title: "Source title" }),
    ] as never);

    await expect(getReadableEdition("en", EDITION_ID)).resolves.toBeNull();
  });

  it("opens a book at the caller's own saved position, not another reader's", async () => {
    vi.mocked(createClient).mockResolvedValue(
      readableBookClient({
        progress: [
          {
            profile_id: OTHER_PROFILE_ID,
            publication_id: PUBLICATION_ID,
            locator_json: { href: "/theirs.xhtml", progression: 0.9, totalProgression: 0.9, locations: {} },
          },
          {
            profile_id: PROFILE_ID,
            publication_id: PUBLICATION_ID,
            locator_json: { href: "/mine.xhtml", progression: 0.1, totalProgression: 0.1, locations: {} },
          },
        ],
      }),
    );
    vi.mocked(getBookCards).mockResolvedValue([
      card({ bookId: BOOK_ID, slug: "source-book", title: "Source title" }),
    ] as never);

    await expect(getReadableEdition("en", EDITION_ID)).resolves.toMatchObject({
      initialLocator: { href: "/mine.xhtml" },
    });
  });

  it("lists only the caller's own library items", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("unread"), libraryRow("completed", "active", OTHER_PROFILE_ID)],
        progress: [],
      }),
    );

    const items = await getLibrary("en");

    expect(items).toHaveLength(1);
    expect(items[0].state).toBe("unread");
  });
});

describe("deriveLibraryState", () => {
  it("reads a book with no progress row as unread", () => {
    expect(deriveLibraryState(null)).toBe("unread");
    expect(deriveLibraryState(undefined)).toBe("unread");
  });

  it("reads partial whole-book progress as reading", () => {
    expect(deriveLibraryState(0)).toBe("reading");
    expect(deriveLibraryState(0.5)).toBe("reading");
  });

  // The threshold matches save_reading_progress exactly. If the two ever disagree, a reader sees
  // "Finished" on one surface and "In progress" on the other for the same book.
  it("reads 0.99 and above as completed", () => {
    expect(deriveLibraryState(0.99)).toBe("completed");
    expect(deriveLibraryState(1)).toBe("completed");
  });

  it("stops just short of completing at 0.98", () => {
    expect(deriveLibraryState(0.98)).toBe("reading");
  });

  it("ignores a value that is not a finite number", () => {
    expect(deriveLibraryState(Number.NaN)).toBe("unread");
  });
});

const JA_EDITION_ID = "40000000-0000-0000-0000-000000000002";
const JA_PUBLICATION_ID = "50000000-0000-0000-0000-000000000002";

function japaneseRow(overrides: Row = {}) {
  return {
    ...libraryRow("unread"),
    edition_id: JA_EDITION_ID,
    added_at: "2026-09-02T00:00:00.000Z",
    editions: { id: JA_EDITION_ID, language_code: "ja", status: "published", active_publication_id: JA_PUBLICATION_ID },
    ...overrides,
  };
}

describe("getLibrary holds every owned edition", () => {
  it("lists English and Japanese of one work as two items that keep their own progress", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [libraryRow("unread"), japaneseRow()],
        progress: [
          { publication_id: PUBLICATION_ID, progression: 0.2, total_progression: 0.2 },
          { publication_id: JA_PUBLICATION_ID, progression: 0.6, total_progression: 0.6 },
        ],
      }),
    );

    const items = await getLibrary("en");

    expect(items.map((item) => [item.languageCode, item.progressPercent])).toEqual([
      ["en", 20],
      ["ja", 60],
    ]);
    expect(items.map((item) => item.continueReadingUrl)).toEqual([
      `/en/read/editions/${EDITION_ID}`,
      `/en/read/editions/${JA_EDITION_ID}`,
    ]);
    expect(new Set(items.map((item) => item.bookId)).size).toBe(1);
  });

  it("keeps showing both after the interface language changes", async () => {
    vi.mocked(createClient).mockResolvedValue(libraryClient({ items: [libraryRow("unread"), japaneseRow()], progress: [] }));
    expect(await getLibrary("ja")).toHaveLength(2);
    expect(await getLibrary("vi")).toHaveLength(2);
  });

  it("hides an edition that is a draft, but keeps an archived one its owner already has", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({
        items: [
          libraryRow("unread"),
          japaneseRow({ editions: { id: JA_EDITION_ID, language_code: "ja", status: "archived", active_publication_id: JA_PUBLICATION_ID } }),
          japaneseRow({ edition_id: "40000000-0000-0000-0000-000000000003", editions: { id: "x", language_code: "vi", status: "draft", active_publication_id: null } }),
        ],
        progress: [],
      }),
    );
    expect((await getLibrary("en")).map((item) => item.languageCode)).toEqual(["en", "ja"]);
  });

  it("drops a revoked edition without touching the other", async () => {
    vi.mocked(createClient).mockResolvedValue(
      libraryClient({ items: [libraryRow("unread"), japaneseRow({ entitlements: { status: "revoked" } })], progress: [] }),
    );
    expect((await getLibrary("en")).map((item) => item.languageCode)).toEqual(["en"]);
  });
});

describe("groupLibraryByWork", () => {
  const item = (bookId: string, languageCode: string, title: string) =>
    ({ bookId, editionId: `${bookId}-${languageCode}`, languageCode, title }) as LibraryItemDTO;

  it("keeps a work's editions together, works in first-seen order, languages in registry order", () => {
    const grouped = groupLibraryByWork([
      item("a", "ja", "A"),
      item("b", "en", "B"),
      item("a", "en", "A"),
      item("b", "vi", "B"),
    ]);
    expect(grouped.map((entry) => `${entry.bookId}:${entry.languageCode}`)).toEqual(["a:en", "a:ja", "b:vi", "b:en"]);
  });
});

describe("getOwnedEditionsOfBook", () => {
  function ownedClient(rows: Row[]) {
    return fakeClient({ entitlements: rows });
  }
  const owned = (editionId: string, language: string, overrides: Row = {}) => ({
    profile_id: PROFILE_ID,
    book_id: BOOK_ID,
    status: "active",
    edition_id: editionId,
    editions: {
      language_code: language,
      status: "published",
      active_publication_id: "pub",
      books: { status: "published", book_localizations: [{ locale: "en", slug: "a-book", title: "A Book" }] },
    },
    ...overrides,
  });

  it("returns only the caller's own editions of the work, whatever the interface language", async () => {
    vi.mocked(createClient).mockResolvedValue(
      ownedClient([owned("ed-ja", "ja"), owned("ed-en", "en"), owned("ed-other", "vi", { profile_id: OTHER_PROFILE_ID })]),
    );
    const editions = await getOwnedEditionsOfBook("vi", BOOK_ID);
    expect(editions.map((edition) => edition.editionId)).toEqual(["ed-en", "ed-ja"]);
  });

  it("is empty for a reader who owns nothing of the work", async () => {
    vi.mocked(createClient).mockResolvedValue(ownedClient([owned("ed-x", "en", { profile_id: OTHER_PROFILE_ID })]));
    expect(await getOwnedEditionsOfBook("en", BOOK_ID)).toEqual([]);
  });

  it("skips an edition that is not live", async () => {
    vi.mocked(createClient).mockResolvedValue(
      ownedClient([owned("ed-draft", "ja", { editions: { language_code: "ja", status: "draft", active_publication_id: null, books: { status: "published", book_localizations: [{ locale: "en", slug: "a", title: "A" }] } } })]),
    );
    expect(await getOwnedEditionsOfBook("en", BOOK_ID)).toEqual([]);
  });
});
