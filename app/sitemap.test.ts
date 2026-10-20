// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import sitemap, { revalidate } from "./sitemap";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards, listEntitySlugs } from "@/lib/data/catalog";
import { getKnowledgeSitemapEntries } from "@/lib/data/knowledge";
import { listPublicBundleSlugs } from "@/lib/data/public-bundles";
import type { Locale } from "@/lib/i18n/config";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn(), listEntitySlugs: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({
  getKnowledgeSitemapEntries: vi.fn(),
}));
vi.mock("@/lib/data/public-bundles", () => ({
  listPublicBundleSlugs: vi.fn(),
}));
vi.mock("@/lib/config/build-environment", () => ({
  deferPrerenderWithoutServerEnv: vi.fn(async () => undefined),
}));

const SITE = "https://books.example";

function card(
  overrides: Partial<CatalogBookCard> & { slug: string },
): CatalogBookCard {
  return {
    bookId: `book-${overrides.slug}`,
    title: overrides.slug,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: null },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: true, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const cards: Record<Exclude<Locale, "ja">, CatalogBookCard[]> = {
  vi: [
    card({
      slug: "song-dai",
      author: { name: "Tác giả", slug: "tac-gia" },
      series: { slug: "bo-song", name: "Bộ sông", position: 1 },
      topics: [
        { slug: "tho", name: "Thơ" },
        { slug: "que-huong", name: "Quê hương" },
      ],
    }),
    card({
      slug: "song-ngan",
      author: { name: "Tác giả", slug: "tac-gia" },
      series: { slug: "bo-song", name: "Bộ sông", position: 2 },
      topics: [{ slug: "tho", name: "Thơ" }],
    }),
  ],
  // An English book whose author has no English page: no author URL, but the book is listed.
  en: [
    card({
      slug: "long-river",
      author: { name: "An Author", slug: null },
      topics: [{ slug: "poetry", name: "Poetry" }],
    }),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: SITE } as ReturnType<
    typeof getServerEnv
  >);
  vi.mocked(getBookCards).mockImplementation(
    async (locale: Locale) => (cards[locale as keyof typeof cards] ?? []).map((entry) => ({ ...entry, metadataLocale: locale })),
  );
  // The entity pages a locale owns: here, those its cards reach, as catalog_entity_slugs would list them.
  vi.mocked(listEntitySlugs).mockImplementation(async (locale: Locale) => {
    const rows = cards[locale as keyof typeof cards] ?? [];
    const unique = (slugs: string[]) => [...new Set(slugs)];
    return {
      author: unique(rows.flatMap((card) => (card.author.slug ? [card.author.slug] : []))),
      series: unique(rows.flatMap((card) => (card.series ? [card.series.slug] : []))),
      topic: unique(rows.flatMap((card) => card.topics.map((topic) => topic.slug))),
    };
  });
  vi.mocked(listPublicBundleSlugs).mockResolvedValue([]);
  vi.mocked(getKnowledgeSitemapEntries).mockResolvedValue([]);
});

async function urls() {
  return (await sitemap()).map((entry) => entry.url);
}

it("is stale-while-revalidate on request, at most 5 minutes behind", () => {
  expect(revalidate).toBe(300);
});

it("lists both home and unfiltered catalog pages, visible books, and entities with a visible book", async () => {
  expect(await urls()).toEqual([
    `${SITE}/vi`,
    `${SITE}/vi/books`,
    `${SITE}/vi/books/song-dai`,
    `${SITE}/vi/books/song-ngan`,
    `${SITE}/vi/authors/tac-gia`,
    `${SITE}/vi/series/bo-song`,
    `${SITE}/vi/topics/tho`,
    `${SITE}/vi/topics/que-huong`,
    `${SITE}/vi/ideas`,
    `${SITE}/vi/articles`,
    `${SITE}/en`,
    `${SITE}/en/books`,
    `${SITE}/en/books/long-river`,
    `${SITE}/en/topics/poetry`,
    `${SITE}/en/ideas`,
    `${SITE}/en/articles`,
    `${SITE}/ja`,
    `${SITE}/ja/books`,
    `${SITE}/ja/ideas`,
    `${SITE}/ja/articles`,
  ]);
  expect(getBookCards).toHaveBeenCalledWith("vi");
  expect(getBookCards).toHaveBeenCalledWith("en");
  expect(getBookCards).toHaveBeenCalledWith("ja");
});

it("lists each URL once even when several books share an entity", async () => {
  const listed = await urls();
  expect(new Set(listed).size).toBe(listed.length);
});

it("never lists search, samples, private, application, or API routes", async () => {
  for (const url of await urls()) {
    expect(url).not.toMatch(
      /\/(search|read-sample|read|account|checkout|library|sign-in|admin|api|auth|internal)(\/|$)/,
    );
    expect(url).not.toContain("?");
  }
});

it("lists only home, catalog, and knowledge index pages when nothing is published", async () => {
  vi.mocked(getBookCards).mockResolvedValue([]);
  vi.mocked(listEntitySlugs).mockResolvedValue({ author: [], series: [], topic: [] });
  expect(await urls()).toEqual([
    `${SITE}/vi`,
    `${SITE}/vi/books`,
    `${SITE}/vi/ideas`,
    `${SITE}/vi/articles`,
    `${SITE}/en`,
    `${SITE}/en/books`,
    `${SITE}/en/ideas`,
    `${SITE}/en/articles`,
    `${SITE}/ja`,
    `${SITE}/ja/books`,
    `${SITE}/ja/ideas`,
    `${SITE}/ja/articles`,
  ]);
});

it("fails rather than publishing a partial sitemap when the catalog read fails", async () => {
  vi.mocked(getBookCards).mockRejectedValueOnce(
    new Error("getBookCards failed."),
  );
  await expect(sitemap()).rejects.toThrow("getBookCards failed.");
});

it("lists every published localized bundle URL", async () => {
  vi.mocked(listPublicBundleSlugs).mockResolvedValue([
    { locale: "vi", slug: "goi-khoi-dau" },
    { locale: "en", slug: "starter-bundle" },
  ]);

  const listed = await urls();
  expect(listed).toContain(`${SITE}/vi/bundles/goi-khoi-dau`);
  expect(listed).toContain(`${SITE}/en/bundles/starter-bundle`);
});

// The read policy hides a draft bundle, so a draft never reaches this list; a bundle localized in
// one locale only gets one URL, not a second one under a slug that route cannot answer.
it("never invents a bundle URL for a locale the bundle is not localized in", async () => {
  vi.mocked(listPublicBundleSlugs).mockResolvedValue([
    { locale: "vi", slug: "goi-khoi-dau" },
  ]);

  const listed = await urls();
  expect(listed).toContain(`${SITE}/vi/bundles/goi-khoi-dau`);
  expect(listed).not.toContain(`${SITE}/en/bundles/goi-khoi-dau`);
});

it("lists a bundle URL once even when the read returns it twice", async () => {
  vi.mocked(listPublicBundleSlugs).mockResolvedValue([
    { locale: "vi", slug: "goi-khoi-dau" },
    { locale: "vi", slug: "goi-khoi-dau" },
  ]);

  const listed = await urls();
  expect(
    listed.filter((url) => url === `${SITE}/vi/bundles/goi-khoi-dau`),
  ).toHaveLength(1);
  expect(new Set(listed).size).toBe(listed.length);
});

it("fails rather than publishing a partial sitemap when the bundle read fails", async () => {
  vi.mocked(listPublicBundleSlugs).mockRejectedValueOnce(
    new Error("listPublicBundleSlugs failed."),
  );
  await expect(sitemap()).rejects.toThrow("listPublicBundleSlugs failed.");
});

describe("knowledge hub", () => {
  const knowledge: Record<Exclude<Locale, "ja">, { path: string; lastModified: string }[]> = {
    vi: [
      {
        path: "/vi/ideas/vi-sao-doc-cham",
        lastModified: "2026-09-03T00:00:00+00:00",
      },
      {
        path: "/vi/articles/doc-mua-thu",
        lastModified: "2026-09-21T03:00:00+00:00",
      },
    ],
    // A draft or an idea localized only in Vietnamese is invisible to the English read.
    en: [
      {
        path: "/en/ideas/why-read-slowly",
        lastModified: "2026-09-04T00:00:00+00:00",
      },
    ],
  };

  beforeEach(() => {
    vi.mocked(getKnowledgeSitemapEntries).mockImplementation(
      async (locale: Locale) => knowledge[locale as keyof typeof knowledge] ?? [],
    );
  });

  it("lists the localized indexes and each published detail once, with its last edit", async () => {
    const entries = await sitemap();
    const listed = entries.map((entry) => entry.url);

    expect(getKnowledgeSitemapEntries).toHaveBeenCalledWith("vi");
    expect(getKnowledgeSitemapEntries).toHaveBeenCalledWith("en");
    for (const url of [
      `${SITE}/vi/ideas`,
      `${SITE}/vi/articles`,
      `${SITE}/en/ideas`,
      `${SITE}/en/articles`,
    ]) {
      expect(listed.filter((entry) => entry === url)).toHaveLength(1);
    }
    expect(
      entries.find((entry) => entry.url === `${SITE}/vi/ideas/vi-sao-doc-cham`),
    ).toEqual({
      url: `${SITE}/vi/ideas/vi-sao-doc-cham`,
      lastModified: "2026-09-03T00:00:00+00:00",
    });
    expect(listed).toContain(`${SITE}/vi/articles/doc-mua-thu`);
    expect(listed).toContain(`${SITE}/en/ideas/why-read-slowly`);
    expect(listed).not.toContain(`${SITE}/en/ideas/vi-sao-doc-cham`);
    expect(listed).not.toContain(`${SITE}/en/articles/doc-mua-thu`);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("lists a detail URL once even when the read returns it twice", async () => {
    vi.mocked(getKnowledgeSitemapEntries).mockImplementation(
      async (locale: Locale) =>
        locale === "vi" ? [...knowledge.vi, knowledge.vi[0]] : knowledge.en,
    );
    const listed = await urls();
    expect(
      listed.filter((url) => url === `${SITE}/vi/ideas/vi-sao-doc-cham`),
    ).toHaveLength(1);
  });

  it("fails rather than publishing a partial sitemap when the knowledge read fails", async () => {
    vi.mocked(getKnowledgeSitemapEntries).mockRejectedValueOnce(
      new Error("getArticleIndex failed."),
    );
    await expect(sitemap()).rejects.toThrow("getArticleIndex failed.");
  });
});

it("leaves out a work that is only shown under another locale's copy", async () => {
  vi.mocked(getBookCards).mockImplementation(async (locale: Locale) =>
    locale === "ja" ? [card({ slug: "english-only", metadataLocale: "en" })] : [],
  );
  expect((await urls()).filter((url) => url.includes("english-only"))).toEqual([]);
});
