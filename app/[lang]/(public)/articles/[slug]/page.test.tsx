import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ArticlePage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/[lang]/(public)/articles/[slug]/page";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getArticlePage } from "@/lib/data/knowledge";
import { knowledgeStaticParams } from "@/lib/knowledge/static-params";
import type {
  KnowledgeArticlePage,
  KnowledgeIdeaSummary,
} from "@/lib/knowledge/public-types";

const header = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));
vi.mock("@/components/site-header", () => ({
  SiteHeader: (props: Record<string, unknown>) => {
    header.props = props;
    return null;
  },
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({ getArticlePage: vi.fn() }));
vi.mock("@/lib/knowledge/static-params", () => ({
  knowledgeStaticParams: vi.fn(),
}));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

const book: CatalogBookCard = {
  bookId: BOOK_ID,
  slug: "harbour-lights",
  title: "Harbour Lights",
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
  createdAt: "2026-09-01T00:00:00+00:00",
};

const relatedIdea: KnowledgeIdeaSummary = {
  ideaId: "50000000-0000-4000-8000-000000000002",
  slug: "streaks",
  question: "Do streaks help?",
  shortAnswer: "Sometimes.",
  createdAt: "2026-09-01T00:00:00+00:00",
  updatedAt: "2026-09-02T00:00:00+00:00",
  alternateSlugs: {},
  topics: [],
};

const article: KnowledgeArticlePage = {
  articleId: "60000000-0000-4000-8000-000000000001",
  slug: "autumn-reading",
  title: "Autumn reading",
  excerpt: "Five books for longer evenings.",
  seoTitle: null,
  seoDescription: null,
  publishedAt: "2026-09-20T03:00:00+00:00",
  updatedAt: "2026-09-21T03:00:00+00:00",
  alternateSlugs: { vi: "doc-mua-thu" },
  author: { name: "Mai Tran", slug: "mai-tran" },
  blocks: [
    {
      type: "paragraph",
      content: [{ text: "The evenings are getting longer." }],
    },
  ],
  books: [book],
  ideas: [relatedIdea],
  topics: [{ slug: "habits", name: "Habits" }],
  booksById: new Map([[BOOK_ID, book]]),
  ideasById: new Map([[relatedIdea.ideaId, relatedIdea]]),
};

const params = Promise.resolve({ lang: "en", slug: "autumn-reading" });

function follows(earlier: Element, later: Element) {
  return Boolean(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  header.props = null;
  vi.mocked(getServerEnv).mockReturnValue({
    siteUrl: "https://books.example",
  } as ReturnType<typeof getServerEnv>);
  vi.mocked(getArticlePage).mockResolvedValue(article);
});

afterEach(cleanup);

describe("ArticlePage", () => {
  it("404s on an unsupported locale without reading anything", async () => {
    await expect(
      ArticlePage({
        params: Promise.resolve({ lang: "fr", slug: "autumn-reading" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getArticlePage).not.toHaveBeenCalled();
  });

  it("404s for a missing localization or an invalid slug", async () => {
    vi.mocked(getArticlePage).mockResolvedValue(null);
    await expect(
      ArticlePage({
        params: Promise.resolve({ lang: "vi", slug: "Not A Slug" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getArticlePage).toHaveBeenCalledWith("vi", "Not A Slug");
  });

  it("shows title, linked author, date and excerpt before the body, then related books, ideas and topics", async () => {
    render(await ArticlePage({ params }));

    const main = screen.getByRole("main");
    const heading = within(main).getByRole("heading", {
      level: 1,
      name: "Autumn reading",
    });
    const author = within(main).getByRole("link", { name: "Mai Tran" });
    const date = main.querySelector("time")!;
    const excerpt = within(main).getByText("Five books for longer evenings.");
    const body = within(main).getByText("The evenings are getting longer.");
    const books = screen.getByRole("region", { name: "Related books" });
    const ideas = screen.getByRole("region", { name: "Related ideas" });
    const topics = screen.getByRole("region", { name: "Topics" });

    expect(author).toHaveAttribute("href", "/en/authors/mai-tran");
    expect(date).toHaveAttribute("dateTime", "2026-09-20T03:00:00+00:00");
    expect(date).toHaveTextContent("Sep 20, 2026");
    for (const [earlier, later] of [
      [heading, author],
      [author, date],
      [date, excerpt],
      [excerpt, body],
      [body, books],
      [books, ideas],
      [ideas, topics],
    ] as const) {
      expect(follows(earlier, later)).toBe(true);
    }

    expect(
      within(books).getByRole("link", { name: "Harbour Lights" }),
    ).toHaveAttribute("href", "/en/books/harbour-lights");
    expect(
      within(ideas).getByRole("link", { name: "Do streaks help?" }),
    ).toHaveAttribute("href", "/en/ideas/streaks");
    expect(
      within(topics).getByRole("link", { name: "Habits" }),
    ).toHaveAttribute("href", "/en/topics/habits");
  });

  it("shows an updated date only when the localization changed on a later day than publication", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      publishedAt: "2026-09-01T10:00:00+00:00",
      updatedAt: "2026-09-15T08:00:00+00:00",
    });
    const { container } = render(await ArticlePage({ params }));
    const updated = container.querySelector(
      'time[datetime="2026-09-15T08:00:00+00:00"]',
    );
    expect(updated).toHaveTextContent("Sep 15, 2026");
    expect(updated?.parentElement).toHaveTextContent("Updated");
    cleanup();

    // Both instants fall on Sep 1 in Vietnam.
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      publishedAt: "2026-09-01T01:00:00+00:00",
      updatedAt: "2026-09-01T10:00:00+00:00",
    });
    const same = render(await ArticlePage({ params }));
    expect(same.container).not.toHaveTextContent("Updated");
    expect(same.container.querySelectorAll("time")).toHaveLength(1);
  });

  it("compares the days the reader sees (Vietnam time), not UTC days", async () => {
    // Different UTC days, both Sep 2 in Vietnam: no Updated.
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      publishedAt: "2026-09-01T18:00:00+00:00",
      updatedAt: "2026-09-02T02:00:00+00:00",
    });
    const sameLocalDay = render(await ArticlePage({ params }));
    expect(sameLocalDay.container).not.toHaveTextContent("Updated");
    cleanup();

    // Same UTC day, Sep 1 vs Sep 2 in Vietnam: Updated shown.
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      publishedAt: "2026-09-01T10:00:00+00:00",
      updatedAt: "2026-09-01T23:00:00+00:00",
    });
    const laterLocalDay = render(await ArticlePage({ params }));
    expect(laterLocalDay.container).toHaveTextContent("Updated");
    expect(laterLocalDay.container).toHaveTextContent("Sep 2, 2026");
  });

  it("shows no updated date without a publication date", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      publishedAt: null as unknown as string,
    });
    const { container } = render(await ArticlePage({ params }));
    expect(container).not.toHaveTextContent("Updated");
  });

  it("labels the updated date in Vietnamese", async () => {
    render(
      await ArticlePage({
        params: Promise.resolve({ lang: "vi", slug: "doc-mua-thu" }),
      }),
    );
    expect(screen.getByText(/Cập nhật/)).toBeInTheDocument();
  });

  it("shows an author without a public page as plain text", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      author: { name: "Guest Writer", slug: null },
      books: [],
    });
    render(await ArticlePage({ params }));

    expect(screen.getByText(/Guest Writer/)).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Guest Writer" }),
    ).not.toBeInTheDocument();
  });

  it("renders no heading for an empty relation", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      books: [],
      ideas: [],
      topics: [],
    });
    render(await ArticlePage({ params }));

    expect(
      screen.queryByRole("heading", { name: "Related books" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Related ideas" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Topics" }),
    ).not.toBeInTheDocument();
  });

  it("points the language switcher at the alternate, or leaves it on the other locale's home", async () => {
    render(await ArticlePage({ params }));
    expect(header.props).toMatchObject({
      locale: "en",
      current: "articles",
      alternates: { vi: "/vi/articles/doc-mua-thu" },
    });
    cleanup();

    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      alternateSlugs: {},
    });
    render(await ArticlePage({ params }));
    expect(header.props?.alternates).toEqual({});
  });

  it("emits Article and breadcrumbs, and no FAQPage", async () => {
    const { container } = render(await ArticlePage({ params }));

    const scripts = container.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    expect(scripts).toHaveLength(1);
    const data = [JSON.parse(scripts[0].textContent ?? "null")].flat();
    expect(data.map((entry) => entry["@type"])).toEqual([
      "Article",
      "BreadcrumbList",
    ]);
    expect(data[0]).toMatchObject({
      headline: "Autumn reading",
      description: "Five books for longer evenings.",
      url: "https://books.example/en/articles/autumn-reading",
      inLanguage: "en",
      datePublished: "2026-09-20T03:00:00+00:00",
      dateModified: "2026-09-21T03:00:00+00:00",
      author: {
        "@type": "Person",
        name: "Mai Tran",
        url: "https://books.example/en/authors/mai-tran",
      },
    });
    expect(
      data[1].itemListElement.map((item: { item: string }) => item.item),
    ).toEqual([
      "https://books.example/en",
      "https://books.example/en/articles",
      "https://books.example/en/articles/autumn-reading",
    ]);
  });

  it("keeps SEO overrides, internal ids, and body text out of structured data", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      seoTitle: "SEO-TITLE-MARKER",
      seoDescription: "SEO-DESCRIPTION-MARKER",
    });
    const { container } = render(await ArticlePage({ params }));

    const json =
      container.querySelector('script[type="application/ld+json"]')
        ?.textContent ?? "";
    for (const marker of [
      "SEO-TITLE-MARKER",
      "SEO-DESCRIPTION-MARKER",
      article.articleId,
      BOOK_ID,
      "The evenings are getting longer.",
    ]) {
      expect(json).not.toContain(marker);
    }
  });
});

describe("generateMetadata", () => {
  it("uses the title and excerpt, and links the existing alternate", async () => {
    const metadata = await generateMetadata({ params });

    expect(metadata.title).toBe("Autumn reading");
    expect(metadata.description).toBe("Five books for longer evenings.");
    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/articles/autumn-reading",
      vi: "https://books.example/vi/articles/doc-mua-thu",
      "x-default": "https://books.example/en/articles/autumn-reading",
    });
  });

  it("prefers the SEO overrides and names only the locales that exist", async () => {
    vi.mocked(getArticlePage).mockResolvedValue({
      ...article,
      alternateSlugs: {},
      seoTitle: "Read this autumn",
      seoDescription: "Five picks.",
    });

    const metadata = await generateMetadata({ params });

    expect(metadata.title).toBe("Read this autumn");
    expect(metadata.description).toBe("Five picks.");
    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/articles/autumn-reading",
      "x-default": "https://books.example/en/articles/autumn-reading",
    });
  });

  it("is empty for an unknown article or an unsupported locale", async () => {
    vi.mocked(getArticlePage).mockResolvedValue(null);
    await expect(generateMetadata({ params })).resolves.toEqual({});
    await expect(
      generateMetadata({ params: Promise.resolve({ lang: "fr", slug: "x" }) }),
    ).resolves.toEqual({});
  });
});

describe("generateStaticParams", () => {
  it("prerenders the published article slugs of the locale", async () => {
    vi.mocked(knowledgeStaticParams).mockResolvedValue({
      ideas: ["streaks"],
      articles: ["autumn-reading"],
    });

    await expect(
      generateStaticParams({ params: { lang: "vi" } }),
    ).resolves.toEqual([{ slug: "autumn-reading" }]);
    expect(knowledgeStaticParams).toHaveBeenCalledWith("vi");
  });
});
