import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ArticlesPage, { generateMetadata } from "@/app/[lang]/(public)/articles/page";
import { getServerEnv } from "@/lib/config/server-env";
import { getArticleIndex } from "@/lib/data/knowledge";
import type { KnowledgeArticleSummary } from "@/lib/knowledge/public-types";

const header = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
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
vi.mock("@/lib/config/build-environment", () => ({ deferPrerenderWithoutServerEnv: vi.fn(async () => {}) }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({ getArticleIndex: vi.fn() }));

function article(slug: string, title: string, publishedAt: string): KnowledgeArticleSummary {
  return {
    articleId: `id-${slug}`,
    slug,
    title,
    excerpt: `About ${title}`,
    publishedAt,
    updatedAt: publishedAt,
    alternateSlug: null,
    author: { name: "Mai Tran", slug: "mai-tran" },
  };
}

const params = Promise.resolve({ lang: "en" });

beforeEach(() => {
  vi.clearAllMocks();
  header.props = null;
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: "https://books.example" } as ReturnType<typeof getServerEnv>);
  vi.mocked(getArticleIndex).mockResolvedValue([
    article("older", "Older piece", "2026-08-01T00:00:00+00:00"),
    article("newest", "Newest piece", "2026-09-20T00:00:00+00:00"),
  ]);
});

afterEach(cleanup);

describe("ArticlesPage", () => {
  it("404s on an unsupported locale without reading anything", async () => {
    await expect(ArticlesPage({ params: Promise.resolve({ lang: "fr" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getArticleIndex).not.toHaveBeenCalled();
  });

  it("renders one heading and the articles newest first, with author and date", async () => {
    render(await ArticlesPage({ params }));

    expect(getArticleIndex).toHaveBeenCalledWith("en");
    expect(screen.getAllByRole("heading", { level: 1 }).map((heading) => heading.textContent)).toEqual(["Articles"]);
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
      "Newest piece",
      "Older piece",
    ]);
    expect(screen.getByRole("link", { name: "Newest piece" })).toHaveAttribute("href", "/en/articles/newest");
    expect(screen.getAllByRole("link", { name: "Mai Tran" })[0]).toHaveAttribute("href", "/en/authors/mai-tran");
    expect(screen.getByText("Sep 20, 2026")).toBeInTheDocument();
  });

  it("marks Articles current and switches language to the other locale's article index", async () => {
    render(await ArticlesPage({ params: Promise.resolve({ lang: "vi" }) }));

    expect(header.props).toMatchObject({ locale: "vi", current: "articles", alternates: { en: "/en/articles" } });
  });

  it("shows the empty state when nothing is published", async () => {
    vi.mocked(getArticleIndex).mockResolvedValue([]);
    render(await ArticlesPage({ params: Promise.resolve({ lang: "vi" }) }));

    expect(screen.getByText("Chưa có bài viết nào được xuất bản.")).toBeInTheDocument();
  });
});

describe("generateMetadata", () => {
  it("uses the fixed index copy and both locale paths", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ lang: "vi" }) });

    expect(metadata.title).toBe("Bài viết");
    expect(metadata.alternates).toEqual({
      canonical: "https://books.example/vi/articles",
      languages: {
        vi: "https://books.example/vi/articles",
        en: "https://books.example/en/articles",
        "x-default": "https://books.example/vi/articles",
      },
    });
  });

  it("is empty for an unsupported locale", async () => {
    await expect(generateMetadata({ params: Promise.resolve({ lang: "fr" }) })).resolves.toEqual({});
  });
});
