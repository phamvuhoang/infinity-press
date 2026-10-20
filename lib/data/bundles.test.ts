// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { readBundleCover } from "@/lib/data/bundle-covers";
import {
  BundleNotFoundError,
  BundleNotReadyError,
  createBundle,
  DuplicateBundleSlugError,
  getAdminBundle,
  listAdminBundles,
  publishBundle,
  saveBundleLocalization,
  setBundleMembers,
  setBundleOffer,
  unpublishBundle,
} from "@/lib/data/bundles";
import { recordingChain } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/data/bundle-covers", () => ({ readBundleCover: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";
const bookA = "8a1b2c3d-0000-4000-8000-00000000000a";
const bookB = "8a1b2c3d-0000-4000-8000-00000000000b";

// A recording client: every builder call is kept per table, so a test can assert on the columns a
// query actually asked for - which is how "storage_key is never selected through a browser-role
// query" is checked rather than assumed.
function fakeClient(options: {
  tables?: Record<string, { data: unknown; error: unknown }>;
  rpc?: { data: unknown; error: unknown };
}): { client: SessionClient; calls: Record<string, [string, unknown[]][]>; rpc: Mock } {
  const calls: Record<string, [string, unknown[]][]> = {};
  const from = vi.fn((table: string) => {
    // Accumulate into the table's existing record rather than replacing it: a second query to the
    // same table must extend what the storage_key sweep below examines, not hide the first one.
    const recorded = recordingChain(options.tables?.[table] ?? { data: null, error: null }, (calls[table] ??= []));
    return recorded.chain;
  });
  const rpc = vi.fn(() => Promise.resolve(options.rpc ?? { data: null, error: null }));
  return { client: { from, rpc } as unknown as SessionClient, calls, rpc };
}

function bundleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: bundleId,
    status: "draft",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    localizations: [
      { id: "loc-en", locale: "en", slug: "starter-set", title: "Starter set", subtitle: null, description: "Two books." },
      { id: "loc-vi", locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu", subtitle: null, description: "Hai cuốn sách." },
    ],
    // Deliberately out of position order: the DTO must sort, not echo the database's row order.
    members: [
      { position: 2, book: { id: bookB, canonical_key: "second", status: "draft", localizations: [{ locale: "vi", title: "Cuốn hai" }] } },
      { position: 1, book: { id: bookA, canonical_key: "first", status: "published", localizations: [{ locale: "vi", title: "Cuốn một" }] } },
    ],
    offers: [
      { id: "offer-vn", market_code: "VN", currency: "VND", price_minor: 150000, active: true, starts_at: null, ends_at: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(readBundleCover).mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("authorization precedes client creation", () => {
  const denied = new Error("NEXT_FORBIDDEN");
  const calls: [string, () => Promise<unknown>][] = [
    ["getAdminBundle", () => getAdminBundle(bundleId)],
    ["listAdminBundles", () => listAdminBundles()],
    ["createBundle", () => createBundle({ locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu" })],
    [
      "saveBundleLocalization",
      () => saveBundleLocalization(bundleId, { locale: "vi", slug: "bo", title: "Bộ", subtitle: null, description: null }),
    ],
    ["setBundleMembers", () => setBundleMembers(bundleId, { bookIds: [bookA, bookB] })],
    ["setBundleOffer", () => setBundleOffer(bundleId, { marketCode: "VN", currency: "VND", priceMinor: 1, active: true })],
    ["publishBundle", () => publishBundle(bundleId)],
    ["unpublishBundle", () => unpublishBundle(bundleId)],
  ];

  it.each(calls)("%s never builds a client for a denied caller", async (_name, call) => {
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(calls)("%s authorizes before it builds a client", async (name, call) => {
    const rows = name === "listAdminBundles" ? [bundleRow()] : bundleRow();
    const fake = fakeClient({ tables: { bundles: { data: rows, error: null } }, rpc: { data: bundleId, error: null } });
    vi.mocked(createClient).mockImplementation(async () => {
      expect(requireAdmin).toHaveBeenCalled();
      return fake.client;
    });
    await call();
    expect(createClient).toHaveBeenCalled();
  });
});

describe("getAdminBundle", () => {
  it("orders members by position and carries each member's publication state", async () => {
    const fake = fakeClient({ tables: { bundles: { data: bundleRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.members.map((member) => member.bookId)).toEqual([bookA, bookB]);
    expect(bundle.members.map((member) => member.published)).toEqual([true, false]);
    expect(bundle.members[0].title).toBe("Cuốn một");
  });

  it("orders the localizations vi then en", async () => {
    const fake = fakeClient({ tables: { bundles: { data: bundleRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
  });

  it("reports readiness as blocking issues and warnings", async () => {
    const fake = fakeClient({ tables: { bundles: { data: bundleRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    // One published member and no cover block publication; the draft member is only a warning,
    // because unpublishing a member must never unpublish the bundle.
    expect(bundle.readiness.blocking).toEqual(["too_few_published_members", "missing_cover"]);
    expect(bundle.readiness.warnings).toEqual(["unpublished_member"]);
  });

  it("decides every offer's active window against one instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const fake = fakeClient({
      tables: {
        bundles: {
          data: bundleRow({
            offers: [
              // Ends exactly now: the window is half-open, so this one is over.
              { id: "expired", market_code: "US", currency: "USD", price_minor: 900, active: true, starts_at: null, ends_at: "2026-09-22T00:00:00Z" },
              // Starts exactly now: already open.
              { id: "live", market_code: "VN", currency: "VND", price_minor: 150000, active: true, starts_at: "2026-09-22T00:00:00Z", ends_at: null },
            ],
          }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.readiness.blocking).not.toContain("missing_offer");
  });

  // A book may be free; a bundle may not. create_bundle_order sells only a price above 0, so a
  // free active offer used to pass the publish gate and then produce a bundle page that answered
  // `unavailable`. The editor's readiness now means what publish_bundle and the storefront mean.
  it("treats a free active offer as no offer", async () => {
    const fake = fakeClient({
      tables: {
        bundles: {
          data: bundleRow({
            offers: [
              { id: "offer-free", market_code: "VN", currency: "VND", price_minor: 0, active: true, starts_at: null, ends_at: null },
            ],
          }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.readiness.blocking).toContain("missing_offer");
  });

  it("treats an offer whose window has closed as no offer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    const fake = fakeClient({
      tables: {
        bundles: {
          data: bundleRow({
            offers: [
              { id: "expired", market_code: "VN", currency: "VND", price_minor: 1, active: true, starts_at: null, ends_at: "2026-09-21T00:00:00Z" },
            ],
          }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.readiness.blocking).toContain("missing_offer");
  });

  it("reads the cover through the service-role module and never selects its storage key", async () => {
    vi.mocked(readBundleCover).mockResolvedValue({ storageKey: `bundles/${bundleId}/k.webp`, altText: "Bìa bộ sách" });
    const fake = fakeClient({ tables: { bundles: { data: bundleRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(readBundleCover).toHaveBeenCalledWith(bundleId);
    expect(bundle.cover).toEqual({ altText: "Bìa bộ sách", publicUrl: expect.stringContaining(`covers/bundles/${bundleId}/k.webp`) });
    expect(bundle.readiness.blocking).not.toContain("missing_cover");
    // The DTO carries no storage key, and no browser-role select asked for one.
    expect(JSON.stringify(bundle)).not.toContain("storage_key");
    for (const calls of Object.values(fake.calls)) {
      for (const [method, args] of calls) {
        if (method === "select") expect(String(args[0])).not.toContain("storage_key");
      }
    }
  });

  // The editor prices per (market, currency) because admin_set_bundle_offer upserts on that key.
  // A DTO carrying one offer would hide every other row - including an active one - from the form
  // that is supposed to be able to edit it.
  it("carries every offer, ordered by market then currency", async () => {
    const fake = fakeClient({
      tables: {
        bundles: {
          data: bundleRow({
            offers: [
              { id: "vn", market_code: "VN", currency: "VND", price_minor: 150000, active: true, starts_at: null, ends_at: null },
              { id: "us-eur", market_code: "US", currency: "EUR", price_minor: 800, active: false, starts_at: null, ends_at: null },
              { id: "us-usd", market_code: "US", currency: "USD", price_minor: 900, active: false, starts_at: null, ends_at: null },
            ],
          }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.offers.map((offer) => `${offer.marketCode}/${offer.currency}`)).toEqual(["US/EUR", "US/USD", "VN/VND"]);
    expect(bundle.offers.map((offer) => offer.active)).toEqual([false, false, true]);
    // An inactive row never stands in for the bundle's live price: readiness is decided over all
    // three, and the live VN row is the one that satisfies it.
    expect(bundle.readiness.blocking).not.toContain("missing_offer");
  });

  it("carries no offer at all for an unpriced bundle", async () => {
    const fake = fakeClient({ tables: { bundles: { data: bundleRow({ offers: [] }), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.offers).toEqual([]);
    expect(bundle.readiness.blocking).toContain("missing_offer");
  });

  it("accepts a to-one member embed returned as a single object", async () => {
    const row = bundleRow({
      members: [{ position: 1, book: { id: bookA, canonical_key: "first", status: "published", localizations: [] } }],
    });
    const fake = fakeClient({ tables: { bundles: { data: row, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundle = await getAdminBundle(bundleId);

    expect(bundle.members[0].title).toBe("first");
  });

  // A stale admin link is a 404 page, not a 500 - the same treatment getAdminBook gives a book.
  it("rejects a bundle id that is not a uuid without querying", async () => {
    const fake = fakeClient({});
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(getAdminBundle("not-a-uuid")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("renders a missing bundle as not found", async () => {
    const fake = fakeClient({ tables: { bundles: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(getAdminBundle(bundleId)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("listAdminBundles", () => {
  it("summarises each bundle and never selects a cover storage key", async () => {
    const fake = fakeClient({
      tables: {
        bundles: { data: [bundleRow()], error: null },
        media_assets: { data: [{ owner_id: bundleId }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const bundles = await listAdminBundles();

    expect(bundles).toEqual([
      {
        id: bundleId,
        title: "Bộ khởi đầu",
        status: "draft",
        memberCount: 2,
        publishedMemberCount: 1,
        readiness: { blocking: ["too_few_published_members"], warnings: ["unpublished_member"] },
      },
    ]);
    const mediaSelects = fake.calls.media_assets.filter(([method]) => method === "select");
    expect(mediaSelects.length).toBeGreaterThan(0);
    for (const [, args] of mediaSelects) expect(String(args[0])).not.toContain("storage_key");
    // A bundle's cover presence comes from this list query, not from the service-role reader.
    expect(readBundleCover).not.toHaveBeenCalled();
  });

  it("falls back to the bundle id when no localization has a title", async () => {
    const fake = fakeClient({
      tables: { bundles: { data: [bundleRow({ localizations: [] })], error: null }, media_assets: { data: [], error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const [bundle] = await listAdminBundles();

    expect(bundle.title).toBe(bundleId);
  });
});

describe("mutations", () => {
  it("creates a bundle and returns its id", async () => {
    const fake = fakeClient({ rpc: { data: bundleId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(createBundle({ locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu" })).resolves.toEqual({ bundleId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_bundle", {
      p_locale: "vi",
      p_slug: "bo-khoi-dau",
      p_title: "Bộ khởi đầu",
    });
  });

  it("maps a duplicate locale/slug to DuplicateBundleSlugError", async () => {
    const fake = fakeClient({
      rpc: { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "bundle_localizations_locale_slug_key"' } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(createBundle({ locale: "vi", slug: "bo-khoi-dau", title: "Bộ" })).rejects.toBeInstanceOf(DuplicateBundleSlugError);
  });

  it("saves a localization through the audited RPC", async () => {
    const fake = fakeClient({ rpc: { data: "loc-id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await saveBundleLocalization(bundleId, { locale: "en", slug: "starter-set", title: "Starter set", subtitle: null, description: "Two books." });

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_bundle_localization", {
      p_bundle_id: bundleId,
      p_locale: "en",
      p_slug: "starter-set",
      p_title: "Starter set",
      p_subtitle: null,
      p_description: "Two books.",
    });
  });

  it("submits the complete ordered member list", async () => {
    const fake = fakeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await setBundleMembers(bundleId, { bookIds: [bookB, bookA] });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_bundle_members", { p_bundle_id: bundleId, p_book_ids: [bookB, bookA] });
  });

  it("sets the offer through the audited RPC", async () => {
    const fake = fakeClient({ rpc: { data: "offer-id", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await setBundleOffer(bundleId, { marketCode: "VN", currency: "VND", priceMinor: 150000, active: false });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_bundle_offer", {
      p_bundle_id: bundleId,
      p_market_code: "VN",
      p_currency: "VND",
      p_price_minor: 150000,
      p_active: false,
    });
  });

  it("maps a missing bundle to BundleNotFoundError", async () => {
    const fake = fakeClient({ rpc: { data: null, error: { code: "P0002", message: "admin_set_bundle_members: bundle x does not exist" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(setBundleMembers(bundleId, { bookIds: [bookA] })).rejects.toBeInstanceOf(BundleNotFoundError);
  });

  it("never leaks raw database text from an unexpected failure", async () => {
    const fake = fakeClient({ rpc: { data: null, error: { code: "42P01", message: "relation bundle_books does not exist" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(setBundleMembers(bundleId, { bookIds: [bookA] })).rejects.toThrow("setBundleMembers failed.");
  });

  it("maps EB026 to BundleNotReadyError carrying the issue codes", async () => {
    const fake = fakeClient({
      rpc: { data: null, error: { code: "EB026", message: "publish_bundle: bundle is not ready: too_few_published_members,missing_cover" } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(publishBundle(bundleId)).rejects.toMatchObject({
      name: "BundleNotReadyError",
      issues: ["too_few_published_members", "missing_cover"],
    });
  });

  it("publishes and unpublishes through the audited RPCs", async () => {
    const fake = fakeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await publishBundle(bundleId);
    await unpublishBundle(bundleId);

    expect(fake.rpc).toHaveBeenCalledWith("publish_bundle", { p_bundle_id: bundleId });
    expect(fake.rpc).toHaveBeenCalledWith("unpublish_bundle", { p_bundle_id: bundleId });
  });

  it("exposes a BundleNotReadyError the operator can read", () => {
    expect(new BundleNotReadyError(["missing_offer"]).message).toBe("This bundle is not ready to publish.");
  });
});
