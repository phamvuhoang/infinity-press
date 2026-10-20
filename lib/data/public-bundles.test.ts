// @vitest-environment node
import { headers } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServerEnv } from "@/lib/config/server-env";
import { getActiveEntitlementBookIds, getBookCards } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import {
  getBundleActionState,
  getBundleOwnership,
  getPublicBundle,
  getPublicBundleById,
  listPublicBundleSlugs,
  publicBundleAction,
} from "@/lib/data/public-bundles";
import { createPublicClient } from "@/lib/supabase/public";

vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn(), getActiveEntitlementBookIds: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";
const BOOK_ONE = "30000000-0000-4000-8000-000000000001";
const BOOK_TWO = "30000000-0000-4000-8000-000000000002";
const HIDDEN_BOOK = "30000000-0000-4000-8000-000000000009";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

function card(bookId: string, slug: string, title: string) {
  return {
    bookId,
    slug,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: "an-author" },
    cover: null,
    offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
  };
}

type BundleRow = {
  id: string;
  localizations: { locale: string; slug: string; title: string; subtitle: string | null; description: string | null }[];
  members: { book_id: string; position: number }[];
};

function bundleRow(overrides: Partial<BundleRow> = {}): BundleRow {
  return {
    id: BUNDLE_ID,
    localizations: [
      { locale: "en", slug: "starter-bundle", title: "Starter Bundle", subtitle: "Two books", description: "A set." },
      { locale: "vi", slug: "goi-khoi-dau", title: "Gói khởi đầu", subtitle: null, description: null },
    ],
    // Deliberately out of position order, so a passing ordering assertion cannot be the row order.
    members: [
      { book_id: BOOK_TWO, position: 2 },
      { book_id: HIDDEN_BOOK, position: 3 },
      { book_id: BOOK_ONE, position: 1 },
    ],
    ...overrides,
  };
}

// One recorded chain per table, so each assertion can check both the answer and the filter that
// produced it.
function mockClient({
  localization = { bundle_id: BUNDLE_ID },
  bundle = bundleRow() as BundleRow | null,
  localizations = null as { locale: string; slug: string }[] | null,
  cover = [] as { storage_key: string; alt_text: string }[],
  // The price is now resolved by catalog_bundle_live_offer, the rule this page shares with
  // create_bundle_order, so it arrives as an RPC row rather than as an embed on the bundle.
  offer = [{ offer_id: "offer-vn", market_code: "VN", currency: "VND", price_minor: 199000 }] as
    | { offer_id: string; market_code: string; currency: string; price_minor: number }[]
    | null,
  offerError = null as unknown,
  error = null as unknown,
}) {
  const calls: Record<string, Record<string, unknown>[]> = {};
  const from = vi.fn((table: string) => {
    calls[table] ??= [];
    const filters: Record<string, unknown> = {};
    calls[table].push(filters);
    const answer =
      table === "bundles" ? { data: bundle, error } : localizations ? { data: localizations, error } : { data: localization, error };
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn((columns: string) => {
      filters.select = columns;
      return builder;
    });
    builder.eq = vi.fn((column: string, value: unknown) => {
      filters[column] = value;
      return builder;
    });
    builder.maybeSingle = vi.fn(() => Promise.resolve(answer));
    builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(answer).then(resolve);
    return builder;
  });
  const rpc = vi.fn((name: string) =>
    name === "catalog_bundle_live_offer"
      ? Promise.resolve({ data: offer, error: offerError })
      : Promise.resolve({ data: cover, error: null }),
  );
  vi.mocked(createPublicClient).mockReturnValue({ from, rpc } as unknown as ReturnType<typeof createPublicClient>);
  return { from, rpc, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(new Headers({ "x-request-id": "req_bundle123" }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "simulator" } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCurrentProfile).mockResolvedValue(null);
  vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set<string>());
  vi.mocked(getBookCards).mockResolvedValue([card(BOOK_ONE, "book-one", "Book One"), card(BOOK_TWO, "book-two", "Book Two")]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPublicBundle", () => {
  it("builds the page DTO from the localized slug", async () => {
    mockClient({});

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle).toEqual({
      bundleId: BUNDLE_ID,
      slug: "starter-bundle",
      alternateSlugs: { vi: "goi-khoi-dau" },
      title: "Starter Bundle",
      subtitle: "Two books",
      description: "A set.",
      cover: null,
      offer: { priceMinor: 199000, currency: "VND" },
      members: [card(BOOK_ONE, "book-one", "Book One"), card(BOOK_TWO, "book-two", "Book Two")],
    });
  });

  // getCurrentProfile is mocked to throw: if the read reaches for a session at all, this fails.
  it("reads a bundle without touching the session, so the page can be prerendered", async () => {
    vi.mocked(getCurrentProfile).mockRejectedValue(new Error("getPublicBundle must not read the session"));
    mockClient({});

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle).not.toBeNull();
    expect(bundle).not.toHaveProperty("ownedMemberCount");
  });

  it("orders the members by bundle_books.position, not by the row order", async () => {
    mockClient({ bundle: bundleRow({ members: [{ book_id: BOOK_ONE, position: 9 }, { book_id: BOOK_TWO, position: 1 }] }) });

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle?.members.map((member) => member.bookId)).toEqual([BOOK_TWO, BOOK_ONE]);
  });

  // The DTO is what the page renders, and a member the storefront will not show on its own book
  // page must not appear on a bundle page either. getBookCards is that boundary: it holds only
  // published books localized in this locale.
  it("drops a member that is not a visible book in this locale", async () => {
    mockClient({});

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle?.members.map((member) => member.bookId)).toEqual([BOOK_ONE, BOOK_TWO]);
  });

  // A published bundle can fall below its publish-time readiness bar afterwards. It still has to
  // render, so this pins that the DTO resolves rather than throwing.
  it("returns an empty member list for a published bundle with nothing visible left", async () => {
    vi.mocked(getBookCards).mockResolvedValue([]);
    mockClient({});

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle?.members).toEqual([]);
  });

  it("reports no offer when the bundle has no live one", async () => {
    mockClient({ offer: [] });

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(bundle?.offer).toBeNull();
  });

  // Per-market pricing is a supported shape (AdminBundleDTO carries offers, plural), so ONE of
  // them has to be resolved server-side. The rule lives in bundle_live_offer, which
  // create_bundle_order reads directly and this page reads through catalog_bundle_live_offer - the page and the checkout used to resolve it differently, and
  // a reader could be quoted one price and charged another. This asserts the page asks that
  // function for this bundle and shows what it answers, rather than ranking offers itself.
  it("takes its price from the shared live-offer rule", async () => {
    const fake = mockClient({
      offer: [{ offer_id: "offer-us", market_code: "US", currency: "USD", price_minor: 900 }],
    });

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(fake.rpc).toHaveBeenCalledWith("catalog_bundle_live_offer", { p_bundle_id: BUNDLE_ID });
    expect(bundle?.offer).toEqual({ priceMinor: 900, currency: "USD" });
  });

  it("fails loudly when the price cannot be read, rather than showing the bundle as unpriced", async () => {
    mockClient({ offer: null, offerError: { code: "57014", message: "canceling statement" } });

    await expect(getPublicBundle("en", "starter-bundle")).rejects.toThrow("getPublicBundle failed.");
  });

  it("builds the cover URL from the definer cover read", async () => {
    const { rpc } = mockClient({ cover: [{ storage_key: `bundles/${BUNDLE_ID}/cover.png`, alt_text: "A bundle cover" }] });

    const bundle = await getPublicBundle("en", "starter-bundle");

    expect(rpc).toHaveBeenCalledWith("catalog_bundle_cover", { p_bundle_id: BUNDLE_ID });
    expect(bundle?.cover).toEqual({
      url: `http://127.0.0.1:54321/storage/v1/object/public/covers/bundles/${BUNDLE_ID}/cover.png`,
      alt: "A bundle cover",
    });
  });

  it("returns null for an unknown slug", async () => {
    mockClient({ localization: null as unknown as { bundle_id: string } });
    await expect(getPublicBundle("en", "no-such-bundle")).resolves.toBeNull();
  });

  it("returns null without querying for a slug that is not a slug", async () => {
    const { from } = mockClient({});
    await expect(getPublicBundle("en", "Not A Slug")).resolves.toBeNull();
    expect(from).not.toHaveBeenCalled();
  });

  it("returns null when the bundle row is gone between the two reads", async () => {
    mockClient({ bundle: null });
    await expect(getPublicBundle("en", "starter-bundle")).resolves.toBeNull();
  });

  it("throws a generic failure on a database error", async () => {
    mockClient({ error: { code: "42501", message: "denied" } });
    await expect(getPublicBundle("en", "starter-bundle")).rejects.toThrow("getPublicBundle failed.");
  });

  it("asks for this locale's localization only", async () => {
    const { calls } = mockClient({});
    await getPublicBundle("vi", "goi-khoi-dau");
    expect(calls.bundle_localizations?.[0]).toMatchObject({ locale: "vi", slug: "goi-khoi-dau" });
  });
});

describe("getBundleOwnership", () => {
  const members = [card(BOOK_ONE, "book-one", "Book One"), card(BOOK_TWO, "book-two", "Book Two")];

  it("is zero for a signed-out visitor, without reading entitlements", async () => {
    await expect(getBundleOwnership(members)).resolves.toBe(0);
    expect(getActiveEntitlementBookIds).not.toHaveBeenCalled();
  });

  it("counts only the visible members the signed-in reader owns", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID } as Awaited<ReturnType<typeof getCurrentProfile>>);
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([BOOK_ONE, HIDDEN_BOOK]));

    await expect(getBundleOwnership(members)).resolves.toBe(1);
  });
});

describe("getBundleActionState", () => {
  const base = {
    publishedMemberCount: 2,
    ownedMemberCount: 0,
    offer: { priceMinor: 199000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  };

  it("is buy for a signed-out visitor while payments are on", async () => {
    await expect(getBundleActionState(base)).resolves.toEqual({ action: "buy", signedIn: false });
  });

  it("reports a signed-in reader", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID } as Awaited<ReturnType<typeof getCurrentProfile>>);
    await expect(getBundleActionState(base)).resolves.toEqual({ action: "buy", signedIn: true });
  });

  it("is owned_bundle once every visible member is owned", async () => {
    await expect(getBundleActionState({ ...base, ownedMemberCount: 2 })).resolves.toMatchObject({ action: "owned_bundle" });
  });

  it("is coming_soon while payments are disabled", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "disabled" } as ReturnType<typeof getServerEnv>);
    await expect(getBundleActionState(base)).resolves.toMatchObject({ action: "coming_soon" });
  });

  it("is unavailable with no visible member", async () => {
    await expect(getBundleActionState({ ...base, publishedMemberCount: 0 })).resolves.toMatchObject({ action: "unavailable" });
  });
});

describe("getPublicBundleById", () => {
  // Route handler support: the island sends the locale it rendered in, so this stays a single-locale
  // lookup - the earlier version searched every locale for whichever answered first, which could
  // resolve a bundle whose `members` (and so the owned-of-total denominator) belonged to a different
  // locale than the one the caller actually asked for (Ruling 4).
  it("resolves the bundle by id in the requested locale", async () => {
    mockClient({});

    const bundle = await getPublicBundleById("en", BUNDLE_ID);

    expect(bundle?.bundleId).toBe(BUNDLE_ID);
    expect(bundle?.slug).toBe("starter-bundle");
  });

  // Covers both a bundle that does not exist at all and one that exists but is not localized in the
  // requested locale - getPublicBundleById treats them the same, which is correct: the island only
  // ever asks in the locale the page rendered, so "not found there" is the whole answer either way.
  it("returns null when the id has no localization in the requested locale", async () => {
    mockClient({ localization: null as unknown as { bundle_id: string } });

    await expect(getPublicBundleById("en", BUNDLE_ID)).resolves.toBeNull();
  });
});

describe("publicBundleAction", () => {
  it("answers for an anonymous visitor without reading a session", () => {
    const action = publicBundleAction({
      members: [card(BOOK_ONE, "book-one", "Book One"), card(BOOK_TWO, "book-two", "Book Two")],
      offer: { priceMinor: 199000, currency: "VND" },
    });

    expect(action).toBe("buy");
    expect(getCurrentProfile).not.toHaveBeenCalled();
  });

  it("never answers `owned_bundle`, because an anonymous visitor owns nothing", () => {
    const action = publicBundleAction({
      members: [card(BOOK_ONE, "book-one", "Book One")],
      offer: { priceMinor: 199000, currency: "VND" },
    });

    expect(action).not.toBe("owned_bundle");
  });

  it("is unavailable with no visible member", () => {
    expect(publicBundleAction({ members: [], offer: { priceMinor: 199000, currency: "VND" } })).toBe("unavailable");
  });
});

describe("listPublicBundleSlugs", () => {
  it("returns the published localized slugs", async () => {
    const { calls } = mockClient({
      localizations: [
        { locale: "vi", slug: "goi-khoi-dau" },
        { locale: "en", slug: "starter-bundle" },
      ],
    });

    await expect(listPublicBundleSlugs()).resolves.toEqual([
      { locale: "vi", slug: "goi-khoi-dau" },
      { locale: "en", slug: "starter-bundle" },
    ]);
    expect(calls.bundle_localizations?.[0]?.select).toBe("locale, slug");
  });

  it("drops a row whose locale is not a supported one", async () => {
    mockClient({ localizations: [{ locale: "fr", slug: "pack-decouverte" }, { locale: "en", slug: "starter-bundle" }] });

    await expect(listPublicBundleSlugs()).resolves.toEqual([{ locale: "en", slug: "starter-bundle" }]);
  });

  it("throws a generic failure on a database error", async () => {
    mockClient({ localizations: [], error: { code: "42501", message: "denied" } });
    await expect(listPublicBundleSlugs()).rejects.toThrow("listPublicBundleSlugs failed.");
  });
});
