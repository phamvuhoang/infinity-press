import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import IdeaPage, {
  generateMetadata,
  generateStaticParams,
} from "@/app/[lang]/(public)/ideas/[slug]/page";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getIdeaPage } from "@/lib/data/knowledge";
import { knowledgeStaticParams } from "@/lib/knowledge/static-params";
import type {
  KnowledgeIdeaPage,
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
vi.mock("@/lib/data/knowledge", () => ({ getIdeaPage: vi.fn() }));
vi.mock("@/lib/knowledge/static-params", () => ({
  knowledgeStaticParams: vi.fn(),
}));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

function card(bookId: string, slug: string, title: string): CatalogBookCard {
  return {
    bookId,
    slug,
    title,
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
}

const related: KnowledgeIdeaSummary = {
  ideaId: "50000000-0000-4000-8000-000000000002",
  slug: "streaks",
  question: "Do streaks help?",
  shortAnswer: "Sometimes.",
  createdAt: "2026-09-01T00:00:00+00:00",
  updatedAt: "2026-09-02T00:00:00+00:00",
  alternateSlugs: {},
  topics: [],
};

const book = card(BOOK_ID, "harbour-lights", "Harbour Lights");

const idea: KnowledgeIdeaPage = {
  ideaId: "50000000-0000-4000-8000-000000000001",
  slug: "why-read-slowly",
  question: "Why read slowly?",
  shortAnswer: "Because understanding takes time.",
  seoTitle: null,
  seoDescription: null,
  createdAt: "2026-09-01T00:00:00+00:00",
  updatedAt: "2026-09-03T00:00:00+00:00",
  alternateSlugs: { vi: "vi-sao-doc-cham" },
  blocks: [
    { type: "paragraph", content: [{ text: "Slow reading is a practice." }] },
  ],
  books: [book],
  relatedIdeas: [related],
  topics: [{ slug: "habits", name: "Habits" }],
  booksById: new Map([[BOOK_ID, book]]),
  ideasById: new Map([[related.ideaId, related]]),
};

const params = Promise.resolve({ lang: "en", slug: "why-read-slowly" });

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
  vi.mocked(getIdeaPage).mockResolvedValue(idea);
});

afterEach(cleanup);

describe("IdeaPage", () => {
  it("404s on an unsupported locale without reading anything", async () => {
    await expect(
      IdeaPage({
        params: Promise.resolve({ lang: "fr", slug: "why-read-slowly" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getIdeaPage).not.toHaveBeenCalled();
  });

  it("404s when the idea is missing or not localized in this locale", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue(null);
    await expect(
      IdeaPage({
        params: Promise.resolve({ lang: "vi", slug: "why-read-slowly" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getIdeaPage).toHaveBeenCalledWith("vi", "why-read-slowly");
  });

  it("opens with the question and short answer, then the body, related books, related ideas, and topics", async () => {
    render(await IdeaPage({ params }));

    // Book cards are articles too; the idea itself is the first one.
    const article = screen.getAllByRole("article")[0];
    const heading = within(article).getByRole("heading", {
      level: 1,
      name: "Why read slowly?",
    });
    const answer = within(article).getByText(
      "Because understanding takes time.",
    );
    const body = within(article).getByText("Slow reading is a practice.");
    const books = screen.getByRole("region", { name: "Related books" });
    const ideas = screen.getByRole("region", { name: "Related ideas" });
    const topics = screen.getByRole("region", { name: "Topics" });

    // Nothing but the eyebrow comes before the question, and the answer comes straight after it.
    expect(within(article).getAllByRole("heading")[0]).toBe(heading);
    expect(follows(heading, answer)).toBe(true);
    expect(follows(answer, body)).toBe(true);
    expect(follows(body, books)).toBe(true);
    expect(follows(books, ideas)).toBe(true);
    expect(follows(ideas, topics)).toBe(true);

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

  it("links to the ask-the-author page for this idea, after the header and before the body", async () => {
    render(await IdeaPage({ params }));

    const link = screen.getByRole("link", { name: "Ask the editors about this" });
    expect(link).toHaveAttribute("href", `/en/ask?idea=${idea.ideaId}`);
    expect(follows(screen.getByText("Because understanding takes time."), link)).toBe(true);
    expect(follows(link, screen.getByText("Slow reading is a practice."))).toBe(true);
  });

  it("renders no heading for an empty relation", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue({
      ...idea,
      books: [],
      relatedIdeas: [],
      topics: [],
    });
    render(await IdeaPage({ params }));

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

  it("points the language switcher at the idea's alternate when it exists", async () => {
    render(await IdeaPage({ params }));

    expect(header.props).toMatchObject({
      locale: "en",
      alternates: { vi: "/vi/ideas/vi-sao-doc-cham" },
    });
  });

  it("leaves the switcher on the other locale's home when the idea has no alternate", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue({ ...idea, alternateSlugs: {} });
    render(await IdeaPage({ params }));

    expect(header.props?.alternates).toEqual({});
  });

  it("emits breadcrumbs through the idea index", async () => {
    const { container } = render(await IdeaPage({ params }));

    const data = [
      ...container.querySelectorAll('script[type="application/ld+json"]'),
    ].flatMap((node) => [JSON.parse(node.textContent ?? "null")].flat());
    const breadcrumbs = data.find(
      (entry) => entry["@type"] === "BreadcrumbList",
    );
    expect(
      breadcrumbs.itemListElement.map((item: { item: string }) => item.item),
    ).toEqual([
      "https://books.example/en",
      "https://books.example/en/ideas",
      "https://books.example/en/ideas/why-read-slowly",
    ]);
  });

  it("emits Article, breadcrumbs, and a FAQPage mirroring the visible Q&A in one payload", async () => {
    const { container } = render(await IdeaPage({ params }));

    const scripts = container.querySelectorAll(
      'script[type="application/ld+json"]',
    );
    expect(scripts).toHaveLength(1);
    const data = [JSON.parse(scripts[0].textContent ?? "null")].flat();
    expect(data.map((entry) => entry["@type"])).toEqual([
      "Article",
      "BreadcrumbList",
      "FAQPage",
    ]);

    const article = data[0];
    expect(article).toMatchObject({
      headline: "Why read slowly?",
      description: "Because understanding takes time.",
      url: "https://books.example/en/ideas/why-read-slowly",
      inLanguage: "en",
      dateModified: "2026-09-03T00:00:00+00:00",
    });

    const faq = data[2];
    const question = faq.mainEntity[0];
    // The structured answer is exactly what the hero shows.
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      question.name,
    );
    expect(screen.getByText(question.acceptedAnswer.text)).toBeInTheDocument();
    expect(faq.mainEntity).toHaveLength(1);
  });

  it("emits no FAQPage when the visible Q&A would be incomplete", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue({ ...idea, shortAnswer: " " });
    const { container } = render(await IdeaPage({ params }));

    const data = [
      ...container.querySelectorAll('script[type="application/ld+json"]'),
    ].flatMap((node) => [JSON.parse(node.textContent ?? "null")].flat());
    expect(data.map((entry) => entry["@type"])).toEqual([
      "Article",
      "BreadcrumbList",
    ]);
  });

  it("keeps SEO overrides, internal ids, and body text out of structured data", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue({
      ...idea,
      seoTitle: "SEO-TITLE-MARKER",
      seoDescription: "SEO-DESCRIPTION-MARKER",
    });
    const { container } = render(await IdeaPage({ params }));

    const json =
      container.querySelector('script[type="application/ld+json"]')
        ?.textContent ?? "";
    for (const marker of [
      "SEO-TITLE-MARKER",
      "SEO-DESCRIPTION-MARKER",
      idea.ideaId,
      BOOK_ID,
      "Slow reading is a practice.",
    ]) {
      expect(json).not.toContain(marker);
    }
  });
});

describe("generateMetadata", () => {
  it("uses the question and short answer, and links the existing alternate", async () => {
    const metadata = await generateMetadata({ params });

    expect(metadata.title).toBe("Why read slowly?");
    expect(metadata.description).toBe("Because understanding takes time.");
    expect(metadata.alternates).toEqual({
      canonical: "https://books.example/en/ideas/why-read-slowly",
      languages: {
        en: "https://books.example/en/ideas/why-read-slowly",
        vi: "https://books.example/vi/ideas/vi-sao-doc-cham",
        "x-default": "https://books.example/en/ideas/why-read-slowly",
      },
    });
  });

  it("prefers the SEO overrides and names only the locales that exist", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue({
      ...idea,
      alternateSlugs: {},
      seoTitle: "Slow reading, explained",
      seoDescription: "What slow reading gives you.",
    });

    const metadata = await generateMetadata({ params });

    expect(metadata.title).toBe("Slow reading, explained");
    expect(metadata.description).toBe("What slow reading gives you.");
    expect(metadata.alternates?.languages).toEqual({
      en: "https://books.example/en/ideas/why-read-slowly",
      "x-default": "https://books.example/en/ideas/why-read-slowly",
    });
  });

  it("is empty for an unknown idea or an unsupported locale", async () => {
    vi.mocked(getIdeaPage).mockResolvedValue(null);
    await expect(generateMetadata({ params })).resolves.toEqual({});
    await expect(
      generateMetadata({ params: Promise.resolve({ lang: "fr", slug: "x" }) }),
    ).resolves.toEqual({});
  });
});

describe("generateStaticParams", () => {
  it("prerenders the published idea slugs of the locale", async () => {
    vi.mocked(knowledgeStaticParams).mockResolvedValue({
      ideas: ["why-read-slowly", "streaks"],
      articles: ["autumn"],
    });

    await expect(
      generateStaticParams({ params: { lang: "en" } }),
    ).resolves.toEqual([{ slug: "why-read-slowly" }, { slug: "streaks" }]);
    expect(knowledgeStaticParams).toHaveBeenCalledWith("en");
    await expect(
      generateStaticParams({ params: { lang: "fr" } }),
    ).resolves.toEqual([]);
  });
});
