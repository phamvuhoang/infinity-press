import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SearchPage from "@/app/[lang]/(public)/search/page";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { type CatalogSearchResults, searchCatalog } from "@/lib/data/catalog";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ searchCatalog: vi.fn() }));

const book: CatalogBookCard = {
  bookId: "30000000-0000-4000-8000-000000000001",
  slug: "harbour-lights",
  title: "Harbour Lights",
  subtitle: null,
  shortDescription: null,
  author: { name: "Mai Tran", slug: "mai-tran" },
  cover: null,
  offer: null,
  hasActivePublication: true,
  hasSample: false,
  series: null,
  topics: [],
  featured: false,
  shelfPosition: null,
  createdAt: "2026-09-01T00:00:00+00:00",
};

const results: CatalogSearchResults = {
  books: [book],
  authors: [{ kind: "author", slug: "mai-tran", name: "Mai Tran", score: 2 }],
  ideas: [
    {
      kind: "idea",
      slug: "why-read-slowly",
      name: "Why read slowly?",
      score: 3,
    },
    {
      kind: "idea",
      slug: "do-streaks-help",
      name: "Do streaks help?",
      score: 1,
    },
  ],
  articles: [
    {
      kind: "article",
      slug: "autumn-reading",
      name: "Autumn reading",
      score: 2,
    },
  ],
  series: [{ kind: "series", slug: "harbour", name: "Harbour", score: 1 }],
  topics: [{ kind: "topic", slug: "habits", name: "Habits", score: 1 }],
};

const empty: CatalogSearchResults = {
  books: [],
  authors: [],
  ideas: [],
  articles: [],
  series: [],
  topics: [],
};

function renderSearch(lang: string, q?: string) {
  return SearchPage({
    params: Promise.resolve({ lang }),
    searchParams: Promise.resolve(q === undefined ? {} : { q }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchCatalog).mockResolvedValue(results);
});

afterEach(cleanup);

describe("SearchPage", () => {
  it("shows the groups in the order books, authors, ideas, articles, series, topics", async () => {
    render(await renderSearch("en", "read"));

    expect(searchCatalog).toHaveBeenCalledWith("en", "read");
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Books", "Authors", "Ideas", "Articles", "Series", "Topics"]);
  });

  it("links idea and article hits to their knowledge routes with the matched text", async () => {
    render(await renderSearch("en", "read"));

    const ideas = screen.getByRole("region", { name: "Ideas" });
    expect(
      within(ideas)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Why read slowly?", "/en/ideas/why-read-slowly"],
      ["Do streaks help?", "/en/ideas/do-streaks-help"],
    ]);
    const articles = screen.getByRole("region", { name: "Articles" });
    expect(
      within(articles).getByRole("link", { name: "Autumn reading" }),
    ).toHaveAttribute("href", "/en/articles/autumn-reading");
    expect(
      within(screen.getByRole("region", { name: "Authors" })).getByRole(
        "link",
        { name: "Mai Tran" },
      ),
    ).toHaveAttribute("href", "/en/authors/mai-tran");
    expect(
      within(screen.getByRole("region", { name: "Topics" })).getByRole("link", {
        name: "Habits",
      }),
    ).toHaveAttribute("href", "/en/topics/habits");
  });

  it("uses Vietnamese headings and routes", async () => {
    render(await renderSearch("vi", "doc"));

    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Sách", "Tác giả", "Ý tưởng", "Bài viết", "Bộ sách", "Chủ đề"]);
    const ideas = screen.getByRole("region", { name: "Ý tưởng" });
    expect(
      within(ideas).getByRole("link", { name: "Why read slowly?" }),
    ).toHaveAttribute("href", "/vi/ideas/why-read-slowly");
    const articles = screen.getByRole("region", { name: "Bài viết" });
    expect(
      within(articles).getByRole("link", { name: "Autumn reading" }),
    ).toHaveAttribute("href", "/vi/articles/autumn-reading");
  });

  it("shows results when only knowledge matched, so the total counts both new groups", async () => {
    vi.mocked(searchCatalog).mockResolvedValue({
      ...empty,
      ideas: results.ideas,
    });
    render(await renderSearch("en", "slowly"));

    expect(
      screen.queryByText("Nothing matched “slowly”."),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Ideas"]);

    cleanup();
    vi.mocked(searchCatalog).mockResolvedValue({
      ...empty,
      articles: results.articles,
    });
    render(await renderSearch("en", "autumn"));
    expect(
      screen.queryByText("Nothing matched “autumn”."),
    ).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Articles"]);
  });

  it("shows the empty state when no group matched", async () => {
    vi.mocked(searchCatalog).mockResolvedValue(empty);
    render(await renderSearch("en", "zzz"));

    expect(screen.getByText("Nothing matched “zzz”.")).toBeInTheDocument();
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
  });

  it("prompts without searching for a query that is too short", async () => {
    render(await renderSearch("en", "a"));

    expect(searchCatalog).not.toHaveBeenCalled();
    expect(screen.getByText("What are you looking for?")).toBeInTheDocument();
  });

  it("404s on an unsupported locale", async () => {
    await expect(renderSearch("fr", "read")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
