import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EntityPage } from "@/components/catalog/entity-page";
import { getServerEnv } from "@/lib/config/server-env";
import { getEntityPage } from "@/lib/data/catalog";
import { getKnowledgeForTopic } from "@/lib/data/knowledge";
import { getShelfRecommendations } from "@/lib/data/recommendations";
import type { CatalogBookCard, CatalogEntityPage } from "@/lib/catalog/public-types";
import type { KnowledgeLinkSummary } from "@/lib/knowledge/public-types";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getEntityPage: vi.fn() }));
vi.mock("@/lib/data/recommendations", () => ({ getShelfRecommendations: vi.fn() }));
vi.mock("@/lib/data/knowledge", () => ({ getKnowledgeForTopic: vi.fn() }));

const OWN_BOOK_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_OWN_BOOK_ID = "30000000-0000-4000-8000-000000000002";
const CANDIDATE_ID = "30000000-0000-4000-8000-000000000003";
// A third own-book id, used only in the seeding-order test below. With just two books whose ids
// and titles both happen to sort the same way as they were inserted, "preserves insertion order"
// cannot be told apart from "sorts by book_id" or "sorts alphabetically by title". These three
// ids/titles instead give three different sequences: first-occurrence [C, A, B], ascending
// book_id [A, B, C], and alphabetical title [C, B, A].
const OWN_BOOK_C_ID = "30000000-0000-4000-8000-000000000004";

function makeCard(bookId: string, title: string): CatalogBookCard {
  return {
    bookId,
    slug: bookId,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: "an-author" },
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

function makeEntity(kind: CatalogEntityPage["kind"], books: CatalogBookCard[]): CatalogEntityPage {
  return {
    kind,
    id: "40000000-0000-4000-8000-000000000001",
    name: "Habits",
    description: null,
    alternateSlugs: {},
    quote: null,
    image: null,
    books,
  };
}

const params = Promise.resolve({ lang: "en", slug: "habits" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: "https://infinitybooks.test" } as ReturnType<typeof getServerEnv>);
  vi.mocked(getKnowledgeForTopic).mockResolvedValue([]);
});

afterEach(cleanup);

describe("EntityPage recommendations", () => {
  it.each([["topic"], ["author"]] as const)(
    "seeds recommendations from the %s's own books and renders them below the grid",
    async (kind) => {
      // Insertion order [C, A, B] disagrees with both ascending book_id order [A, B, C] and
      // alphabetical title order [C, B, A] - see the OWN_BOOK_C_ID comment above.
      const ownBooks = [
        makeCard(OWN_BOOK_C_ID, "Book Alpha"),
        makeCard(OWN_BOOK_ID, "Book Zulu"),
        makeCard(OTHER_OWN_BOOK_ID, "Book Mike"),
      ];
      vi.mocked(getEntityPage).mockResolvedValue(makeEntity(kind, ownBooks));
      vi.mocked(getShelfRecommendations).mockResolvedValue([makeCard(CANDIDATE_ID, "Candidate Book")]);

      render(await EntityPage({ kind, params }));

      expect(getShelfRecommendations).toHaveBeenCalledWith({
        seedBookIds: [OWN_BOOK_C_ID, OWN_BOOK_ID, OTHER_OWN_BOOK_ID],
        excludeBookIds: [],
        locale: "en",
        limit: 6,
      });

      // The entity's own grid still shows its own books.
      const grid = screen.getByRole("region", { name: "Books" });
      expect(within(grid).getByRole("link", { name: "Book Alpha" })).toBeVisible();
      expect(within(grid).getByRole("link", { name: "Book Zulu" })).toBeVisible();
      expect(within(grid).getByRole("link", { name: "Book Mike" })).toBeVisible();

      // The recommendation shelf contains only the returned candidate, and nothing the entity
      // already owns - a shelf that just echoed the grid would prove no seeding happened.
      const shelf = screen.getByRole("region", { name: "Related books" });
      expect(within(shelf).getByRole("link", { name: "Candidate Book" })).toBeVisible();
      expect(within(shelf).queryByRole("link", { name: "Book Alpha" })).not.toBeInTheDocument();
      expect(within(shelf).queryByRole("link", { name: "Book Zulu" })).not.toBeInTheDocument();
      expect(within(shelf).queryByRole("link", { name: "Book Mike" })).not.toBeInTheDocument();

      // The shelf renders after the grid in DOM order, not merely "somewhere on the page" - a
      // shelf placed above the grid or outside <main> would also pass every assertion above.
      expect(grid.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    },
  );

  it("renders no recommendation heading when there are no candidates", async () => {
    vi.mocked(getEntityPage).mockResolvedValue(makeEntity("topic", [makeCard(OWN_BOOK_ID, "Own Book")]));
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await EntityPage({ kind: "topic", params }));

    expect(screen.queryByRole("heading", { name: "Related books" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Related books" })).not.toBeInTheDocument();
  });

  it("never calls the recommendation DAL or renders a shelf for a series", async () => {
    vi.mocked(getEntityPage).mockResolvedValue(makeEntity("series", [makeCard(OWN_BOOK_ID, "Own Book")]));

    render(await EntityPage({ kind: "series", params }));

    expect(getShelfRecommendations).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Related books" })).not.toBeInTheDocument();
  });
});

const TOPIC_ID = "40000000-0000-4000-8000-000000000001";

const knowledgeLinks: KnowledgeLinkSummary[] = [
  { kind: "idea", slug: "small-habits", title: "Why do small habits last?", excerpt: "They are easy.", publishedAt: null },
  {
    kind: "article",
    slug: "habit-reading-list",
    title: "A habit reading list",
    excerpt: "Five books.",
    publishedAt: "2026-09-10T00:00:00+00:00",
  },
];

describe("EntityPage knowledge backlinks", () => {
  it.each([
    ["en", "Ideas and articles", "Idea", "Article"],
    ["vi", "Ý tưởng và bài viết", "Ý tưởng", "Bài viết"],
  ] as const)("loads a topic's backlinks and links them in %s", async (lang, heading, ideaLabel, articleLabel) => {
    vi.mocked(getEntityPage).mockResolvedValue(makeEntity("topic", [makeCard(OWN_BOOK_ID, "Own Book")]));
    vi.mocked(getShelfRecommendations).mockResolvedValue([makeCard(CANDIDATE_ID, "Candidate Book")]);
    vi.mocked(getKnowledgeForTopic).mockResolvedValue(knowledgeLinks);

    render(await EntityPage({ kind: "topic", params: Promise.resolve({ lang, slug: "habits" }) }));

    expect(getKnowledgeForTopic).toHaveBeenCalledWith(lang, TOPIC_ID);
    const section = screen.getByRole("region", { name: heading });
    expect(within(section).getByRole("link", { name: "Why do small habits last?" })).toHaveAttribute(
      "href",
      `/${lang}/ideas/small-habits`,
    );
    expect(within(section).getByRole("link", { name: "A habit reading list" })).toHaveAttribute(
      "href",
      `/${lang}/articles/habit-reading-list`,
    );
    expect(within(section).getByText(ideaLabel)).toBeVisible();
    expect(within(section).getByText(articleLabel)).toBeVisible();

    // Rendered after the topic's own book grid, and kept apart from the recommendation shelf.
    const grid = screen.getByRole("heading", { level: 2, name: lang === "en" ? "Books" : "Sách" }).closest("section")!;
    expect(grid.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).queryByRole("link", { name: "Candidate Book" })).not.toBeInTheDocument();
  });

  it("renders no knowledge section for a topic without backlinks", async () => {
    vi.mocked(getEntityPage).mockResolvedValue(makeEntity("topic", [makeCard(OWN_BOOK_ID, "Own Book")]));
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);
    vi.mocked(getKnowledgeForTopic).mockResolvedValue([]);

    render(await EntityPage({ kind: "topic", params }));

    expect(getKnowledgeForTopic).toHaveBeenCalledWith("en", TOPIC_ID);
    expect(screen.queryByRole("heading", { name: "Ideas and articles" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ideas and articles" })).not.toBeInTheDocument();
  });

  it.each([["author"], ["series"]] as const)("never requests or renders backlinks for a %s", async (kind) => {
    vi.mocked(getEntityPage).mockResolvedValue(makeEntity(kind, [makeCard(OWN_BOOK_ID, "Own Book")]));
    vi.mocked(getShelfRecommendations).mockResolvedValue([]);

    render(await EntityPage({ kind, params }));

    expect(getKnowledgeForTopic).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Ideas and articles" })).not.toBeInTheDocument();
    // The existing page still renders the entity and its books.
    expect(screen.getByRole("heading", { level: 1, name: "Habits" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Own Book" })).toBeVisible();
  });

  it("never requests backlinks for a missing topic", async () => {
    vi.mocked(getEntityPage).mockResolvedValue(null);

    await expect(EntityPage({ kind: "topic", params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getKnowledgeForTopic).not.toHaveBeenCalled();
  });
});
