import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { listPublicBundleSlugs } from "@/lib/data/public-bundles";

vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("@/lib/data/public-bundles", () => ({ listPublicBundleSlugs: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

function card(overrides: Partial<CatalogBookCard>): CatalogBookCard {
  return {
    bookId: "book-1",
    slug: "a-book",
    title: "A Book",
    subtitle: null,
    shortDescription: null,
    author: { name: "Mai Tran", slug: "mai-tran" },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: false, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // getServerEnv() succeeds by default - most tests are not exercising the build-phase branch.
  vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);
});
afterEach(() => vi.unstubAllEnvs());

describe("catalogStaticParams", () => {
  it("lists every slug the locale's visible books reach", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      card({ slug: "one", series: { slug: "a-series", name: "S", position: 1 }, topics: [{ slug: "calm", name: "Calm" }] }),
      card({ slug: "two", author: { name: "Mai Tran", slug: "mai-tran" }, topics: [{ slug: "calm", name: "Calm" }] }),
    ]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([
      { locale: "vi", slug: "goi-khoi-dau" },
      { locale: "en", slug: "starter-bundle" },
    ]);

    expect(await catalogStaticParams("vi")).toEqual({
      books: ["one", "two"],
      authors: ["mai-tran"],
      series: ["a-series"],
      topics: ["calm"],
      bundles: ["goi-khoi-dau"],
    });
  });

  it("drops a book with no author slug and never repeats a slug", async () => {
    vi.mocked(getBookCards).mockResolvedValue([
      card({ slug: "one", author: { name: "Anon", slug: null } }),
      card({ slug: "one", author: { name: "Mai Tran", slug: "mai-tran" } }),
    ]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);

    const params = await catalogStaticParams("en");
    expect(params.books).toEqual(["one"]);
    expect(params.authors).toEqual(["mai-tran"]);
    expect(params.bundles).toEqual([]);
  });

  // Mirrors lib/config/build-environment.test.ts's coverage of deferPrerenderWithoutServerEnv():
  // generateStaticParams cannot call connection(), so this is the sibling treatment for a build
  // with no server environment (CI, a local check) - return no slugs instead of failing the build.
  it("returns no slugs during a production build with no server environment, without querying", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.mocked(getServerEnv).mockImplementation(() => {
      throw new Error("invalid environment");
    });

    expect(await catalogStaticParams("vi")).toEqual({ books: [], authors: [], series: [], topics: [], bundles: [] });
    expect(getBookCards).not.toHaveBeenCalled();
    expect(listPublicBundleSlugs).not.toHaveBeenCalled();
  });

  it("queries for real during a production build that has the server environment", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);
    vi.mocked(getBookCards).mockResolvedValue([card({ slug: "one" })]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);

    expect((await catalogStaticParams("vi")).books).toEqual(["one"]);
  });

  // A build WITH the environment but a query that still fails - bad credentials, a database outage,
  // a broken RPC - must keep failing loudly. Swallowing that would turn a broken deployment into a
  // silently unprerendered one.
  it("does not swallow a real query error when the server environment is present", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.mocked(getServerEnv).mockReturnValue({} as ReturnType<typeof getServerEnv>);
    vi.mocked(getBookCards).mockRejectedValue(new Error("query failed"));
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);

    await expect(catalogStaticParams("vi")).rejects.toThrow("query failed");
  });

  it("does not check the environment outside a production build, so a bad runtime environment still queries", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    vi.mocked(getServerEnv).mockImplementation(() => {
      throw new Error("invalid environment");
    });
    vi.mocked(getBookCards).mockResolvedValue([card({ slug: "one" })]);
    vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);

    expect((await catalogStaticParams("vi")).books).toEqual(["one"]);
    expect(getServerEnv).not.toHaveBeenCalled();
  });
});
