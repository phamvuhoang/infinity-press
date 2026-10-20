// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET, revalidate } from "./route";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getArticleIndex, getPublishedIdeas } from "@/lib/data/knowledge";
import type { Locale } from "@/lib/i18n/config";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/config/build-environment", () => ({
  deferPrerenderWithoutServerEnv: vi.fn(async () => undefined),
}));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({
  getPublishedIdeas: vi.fn(),
  getArticleIndex: vi.fn(),
}));

const SITE = "https://books.example";

function card(overrides: Partial<CatalogBookCard> & { slug: string }): CatalogBookCard {
  return {
    bookId: `book-${overrides.slug}`,
    title: overrides.slug,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: null },
    cover: null,
    offer: null,
    hasActivePublication: true,
    hasSample: true,
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
      slug: "sach-mot",
      title: "Sách một",
      shortDescription: "Mô tả\nhai dòng",
      author: { name: "Mai Tran", slug: "mai-tran" },
      series: { slug: "bo-song", name: "Bộ sông", position: 1 },
      topics: [{ slug: "tho", name: "Thơ" }],
    }),
    card({
      slug: "sach-hai",
      title: "Sách hai",
      author: { name: "Mai Tran", slug: "mai-tran" },
      series: { slug: "bo-song", name: "Bộ sông", position: 2 },
      topics: [{ slug: "tho", name: "Thơ" }],
      offer: { priceMinor: 90300, currency: "VND", listPriceMinor: 129000, saleEndsAt: "2026-11-01T00:00:00Z" },
    }),
  ],
  // An author without an English page is not listed, as in the sitemap; the book is.
  en: [card({ slug: "book-one", title: "Book one", topics: [{ slug: "poetry", name: "Poetry" }] })],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: SITE } as ReturnType<typeof getServerEnv>);
  vi.mocked(getBookCards).mockImplementation(async (locale: Locale) => cards[locale as keyof typeof cards] ?? []);
  vi.mocked(getPublishedIdeas).mockImplementation(async (locale: Locale) => [
    {
      ideaId: `idea-${locale}`,
      slug: locale === "vi" ? "vi-sao-doc-cham" : "why-read-slowly",
      question: locale === "vi" ? "Vì sao đọc chậm?" : "Why read slowly?",
      shortAnswer: "Because\nattention.",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      alternateSlugs: {},
      topics: [],
    },
  ]);
  vi.mocked(getArticleIndex).mockImplementation(async (locale: Locale) => [
    {
      articleId: `article-${locale}`,
      slug: locale === "vi" ? "doc-mua-thu" : "autumn-reading",
      title: locale === "vi" ? "Đọc mùa thu" : "Autumn reading",
      excerpt: "An excerpt.",
      publishedAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      alternateSlugs: {},
      author: { name: "Mai Tran", slug: "mai-tran" },
    } as Awaited<ReturnType<typeof getArticleIndex>>[number],
  ]);
});

describe("GET /llms.txt", () => {
  it("is stale-while-revalidate like the sitemap", () => {
    expect(revalidate).toBe(300);
  });

  it("lists the published book, author, series, topic, idea, and article for both locales as text", async () => {
    const response = await GET();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const text = await response.text();
    expect(text).toContain("- [Sách một](https://books.example/vi/books/sach-mot): Mô tả hai dòng");
    expect(text).toContain("- [Mai Tran](https://books.example/vi/authors/mai-tran)");
    expect(text).toContain("- [Bộ sông](https://books.example/vi/series/bo-song)");
    expect(text).toContain("- [Thơ](https://books.example/vi/topics/tho)");
    expect(text).toContain("- [Vì sao đọc chậm?](https://books.example/vi/ideas/vi-sao-doc-cham): Because attention.");
    expect(text).toContain("- [Đọc mùa thu](https://books.example/vi/articles/doc-mua-thu): An excerpt.");
    expect(text).toContain("- [Book one](https://books.example/en/books/book-one)\n");
    expect(text).toContain("https://books.example/en/ideas/why-read-slowly");
    expect(text).toContain("https://books.example/en/articles/autumn-reading");
    expect(text.startsWith("# Infinity Books Press")).toBe(true);
    expect(text.indexOf("# Infinity Books Press")).toBeLessThan(text.indexOf("## Tiếng Việt"));
  });

  it("prints a book's price, with the list price and last day while a sale runs", async () => {
    vi.mocked(getBookCards).mockImplementation(async (locale: Locale) =>
      locale === "en"
        ? [card({ slug: "book-one", title: "Book one", offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null } })]
        : cards.vi,
    );
    const text = await (await GET()).text();
    expect(text).toContain("- [Sách một](https://books.example/vi/books/sach-mot): Mô tả hai dòng");
    expect(text).toMatch(/- \[Sách hai\]\(https:\/\/books\.example\/vi\/books\/sach-hai\) \(90\.300\s₫, giá gốc 129\.000\s₫, đến 2026-10-31\)\n/);
    expect(text).toContain("- [Book one](https://books.example/en/books/book-one) (Free)");
  });

  it("lists each shared author, series, and topic once, and no author without a page", async () => {
    const text = await (await GET()).text();
    expect(text.match(/\/vi\/authors\/mai-tran\)/g)).toHaveLength(1);
    expect(text.match(/\/vi\/series\/bo-song\)/g)).toHaveLength(1);
    expect(text.match(/\/vi\/topics\/tho\)/g)).toHaveLength(1);
    expect(text).not.toContain("/en/authors/");
  });

  it("emits exactly one line per entity, even with a multi-line description", async () => {
    const text = await (await GET()).text();
    // vi: 2 books, author, series, topic, idea, article; en: book, topic, idea, article; ja: idea, article.
    expect(text.split("\n").filter((l) => l.startsWith("- ["))).toHaveLength(13);
  });

  it("fails rather than serving a partial index when a read fails", async () => {
    vi.mocked(getArticleIndex).mockRejectedValueOnce(new Error("getArticleIndex failed."));
    await expect(GET()).rejects.toThrow("getArticleIndex failed.");
  });
});
