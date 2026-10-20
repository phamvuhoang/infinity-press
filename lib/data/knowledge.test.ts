// @vitest-environment node
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getBookCards } from "@/lib/data/catalog";
import {
  getArticleIndex,
  getArticlePage,
  getIdeaIndex,
  getIdeaPage,
  getKnowledgeForBook,
  getKnowledgeForTopic,
  getKnowledgeSitemapEntries,
  getPublishedIdeaById,
  getPublishedIdeas,
} from "@/lib/data/knowledge";
import { createPublicClient } from "@/lib/supabase/public";

vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const BOOK_A = "30000000-0000-4000-8000-00000000000a";
const BOOK_B = "30000000-0000-4000-8000-00000000000b";
const BOOK_GONE = "30000000-0000-4000-8000-0000000000ff";
const IDEA_1 = "40000000-0000-4000-8000-000000000001";
const IDEA_2 = "40000000-0000-4000-8000-000000000002";
const IDEA_3 = "40000000-0000-4000-8000-000000000003";
const IDEA_GONE = "40000000-0000-4000-8000-0000000000ff";
const ARTICLE_1 = "50000000-0000-4000-8000-000000000001";
const TOPIC_ID = "60000000-0000-4000-8000-000000000001";

function card(bookId: string, slug: string): CatalogBookCard {
  return {
    bookId,
    slug,
    title: slug,
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

function ideaRow(
  id: string,
  slug: string,
  question: string,
  topics: { slug: string; name: string }[] = [],
) {
  return {
    idea_id: id,
    slug,
    question,
    short_answer: `${question} answer`,
    created_at: "2026-02-01T00:00:00+00:00",
    updated_at: "2026-02-02T00:00:00+00:00",
    alternate_slugs: {},
    metadata_locale: "vi",
    topics,
  };
}

const ideaRows = [
  ideaRow(IDEA_1, "idea-one", "Alpha?", [
    { slug: "habits", name: "Habits" },
    { slug: "focus", name: "Focus" },
  ]),
  ideaRow(IDEA_2, "idea-two", "Beta?"),
  ideaRow(IDEA_3, "idea-three", "Gamma?", [{ slug: "focus", name: "Focus" }]),
];

function ideaPageData(overrides: Record<string, unknown> = {}) {
  return {
    ideaId: IDEA_1,
    slug: "idea-one",
    question: "Alpha?",
    shortAnswer: "Alpha answer",
    bodyBlocks: [
      { type: "paragraph", content: [{ text: "Hello" }] },
      { type: "book_quote", bookId: BOOK_B, text: "A short quote." },
      { type: "book_card", bookId: BOOK_GONE },
      { type: "idea_card", ideaId: IDEA_3 },
      { type: "idea_card", ideaId: IDEA_GONE },
    ],
    seoTitle: null,
    seoDescription: "SEO",
    createdAt: "2026-02-01T00:00:00+00:00",
    updatedAt: "2026-02-02T00:00:00+00:00",
    alternateSlugs: { vi: "y-tuong-mot" },
    metadataLocale: "vi",
    bookIds: [BOOK_GONE, BOOK_A],
    relatedIdeaIds: [IDEA_2, IDEA_GONE],
    topics: [{ slug: "habits", name: "Habits" }],
    ...overrides,
  };
}

function articlePageData(overrides: Record<string, unknown> = {}) {
  return {
    articleId: ARTICLE_1,
    slug: "deep-reading",
    title: "Deep reading",
    excerpt: "Focus.",
    bodyBlocks: [{ type: "quote", text: "Quoted.", bookId: BOOK_A }],
    seoTitle: "SEO title",
    seoDescription: null,
    publishedAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-02T00:00:00+00:00",
    alternateSlugs: {},
    metadataLocale: "vi",
    author: { name: "An Author", slug: null },
    bookIds: [BOOK_B, BOOK_A],
    ideaIds: [IDEA_3, IDEA_1],
    topics: [],
    ...overrides,
  };
}

function mockRpc(results: Record<string, { data: unknown; error: unknown }>) {
  const rpc = vi.fn((name: string) =>
    Promise.resolve(results[name] ?? { data: null, error: null }),
  );
  vi.mocked(createPublicClient).mockReturnValue({
    rpc,
  } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(headers).mockResolvedValue(
    new Headers({ "x-request-id": "req_knowledge123" }) as never,
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(getBookCards).mockResolvedValue([
    card(BOOK_A, "book-a"),
    card(BOOK_B, "book-b"),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getPublishedIdeaById", () => {
  it("finds a published idea by id and is null for an unpublished or unknown one", async () => {
    mockRpc({ knowledge_idea_index: { data: ideaRows, error: null } });
    expect((await getPublishedIdeaById("en", IDEA_2))?.slug).toBe("idea-two");
    expect(await getPublishedIdeaById("en", IDEA_GONE)).toBeNull();
  });
});

describe("getPublishedIdeas", () => {
  it("maps index rows in database order", async () => {
    const rpc = mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
    });
    const ideas = await getPublishedIdeas("en");
    expect(rpc).toHaveBeenCalledWith("knowledge_idea_index", {
      p_locale: "en",
    });
    expect(ideas.map((idea) => idea.slug)).toEqual([
      "idea-one",
      "idea-two",
      "idea-three",
    ]);
    expect(ideas[0]).toEqual({
      ideaId: IDEA_1,
      slug: "idea-one",
      question: "Alpha?",
      shortAnswer: "Alpha? answer",
      createdAt: "2026-02-01T00:00:00+00:00",
      updatedAt: "2026-02-02T00:00:00+00:00",
      alternateSlugs: {},
      metadataLocale: "vi",
      topics: [
        { slug: "habits", name: "Habits" },
        { slug: "focus", name: "Focus" },
      ],
    });
  });
});

describe("getIdeaIndex", () => {
  it("puts a multi-topic idea in each topic group and a topicless idea in the trailing Other group", async () => {
    mockRpc({ knowledge_idea_index: { data: ideaRows, error: null } });
    const groups = await getIdeaIndex("en");
    expect(
      groups.map((group) => [
        group.topic?.slug ?? null,
        group.ideas.map((idea) => idea.slug),
      ]),
    ).toEqual([
      ["focus", ["idea-one", "idea-three"]],
      ["habits", ["idea-one"]],
      [null, ["idea-two"]],
    ]);
  });

  it("orders topic groups by localized name", async () => {
    mockRpc({
      knowledge_idea_index: {
        data: [
          ideaRow(IDEA_1, "idea-one", "Một?", [{ slug: "z", name: "Ý chí" }]),
          ideaRow(IDEA_2, "idea-two", "Hai?", [{ slug: "a", name: "Tâm lý" }]),
          ideaRow(IDEA_3, "idea-three", "Ba?", [
            { slug: "m", name: "Ăn uống" },
          ]),
        ],
        error: null,
      },
    });
    const groups = await getIdeaIndex("vi");
    expect(groups.map((group) => group.topic?.name)).toEqual([
      "Ăn uống",
      "Tâm lý",
      "Ý chí",
    ]);
  });

  it("returns no groups and no Other group when nothing is published", async () => {
    mockRpc({ knowledge_idea_index: { data: [], error: null } });
    await expect(getIdeaIndex("vi")).resolves.toEqual([]);
  });
});

describe("getArticleIndex", () => {
  it("maps rows and keeps the database order", async () => {
    const rpc = mockRpc({
      knowledge_article_index: {
        data: [
          {
            article_id: ARTICLE_1,
            slug: "newer",
            title: "Newer",
            excerpt: "N",
            published_at: "2026-03-01T00:00:00+00:00",
            updated_at: "2026-03-02T00:00:00+00:00",
            alternate_slugs: { vi: "moi-hon" },
            metadata_locale: "vi",
            author: { name: "An Author", slug: "an-author" },
          },
          {
            article_id: "50000000-0000-4000-8000-000000000002",
            slug: "older",
            title: "Older",
            excerpt: "O",
            published_at: "2026-01-01T00:00:00+00:00",
            updated_at: "2026-01-02T00:00:00+00:00",
            alternate_slugs: {},
            metadata_locale: "vi",
            author: { name: "Someone", slug: null },
          },
        ],
        error: null,
      },
    });
    const articles = await getArticleIndex("en");
    expect(rpc).toHaveBeenCalledWith("knowledge_article_index", {
      p_locale: "en",
    });
    expect(articles.map((article) => article.slug)).toEqual(["newer", "older"]);
    expect(articles[0]).toEqual({
      articleId: ARTICLE_1,
      slug: "newer",
      title: "Newer",
      excerpt: "N",
      publishedAt: "2026-03-01T00:00:00+00:00",
      updatedAt: "2026-03-02T00:00:00+00:00",
      alternateSlugs: { vi: "moi-hon" },
      metadataLocale: "vi",
      author: { name: "An Author", slug: "an-author" },
    });
  });
});

describe("getKnowledgeSitemapEntries", () => {
  const articleRow = {
    article_id: ARTICLE_1,
    slug: "deep-reading",
    title: "Deep reading",
    excerpt: "E",
    published_at: "2026-03-01T00:00:00+00:00",
    updated_at: "2026-03-02T00:00:00+00:00",
    alternate_slugs: {},
    metadata_locale: "vi",
    author: { name: "An Author", slug: null },
  };

  it("lists each published localized idea and article path once, with its last edit", async () => {
    const rpc = mockRpc({
      knowledge_idea_index: { data: [...ideaRows, ideaRows[0]], error: null },
      knowledge_article_index: { data: [articleRow], error: null },
    });
    const entries = await getKnowledgeSitemapEntries("vi");
    expect(rpc).toHaveBeenCalledWith("knowledge_idea_index", {
      p_locale: "vi",
    });
    expect(rpc).toHaveBeenCalledWith("knowledge_article_index", {
      p_locale: "vi",
    });
    expect(entries).toEqual([
      { path: "/vi/ideas/idea-one", lastModified: "2026-02-02T00:00:00+00:00" },
      { path: "/vi/ideas/idea-two", lastModified: "2026-02-02T00:00:00+00:00" },
      {
        path: "/vi/ideas/idea-three",
        lastModified: "2026-02-02T00:00:00+00:00",
      },
      {
        path: "/vi/articles/deep-reading",
        lastModified: "2026-03-02T00:00:00+00:00",
      },
    ]);
  });

  it("is empty when nothing is published in the locale", async () => {
    mockRpc({
      knowledge_idea_index: { data: [], error: null },
      knowledge_article_index: { data: [], error: null },
    });
    await expect(getKnowledgeSitemapEntries("en")).resolves.toEqual([]);
  });

  it("rejects when either read fails instead of returning a partial list", async () => {
    mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
      knowledge_article_index: {
        data: null,
        error: { code: "42P01", message: "boom" },
      },
    });
    await expect(getKnowledgeSitemapEntries("en")).rejects.toThrow(
      "getArticleIndex failed.",
    );

    mockRpc({
      knowledge_idea_index: {
        data: null,
        error: { code: "42P01", message: "boom" },
      },
      knowledge_article_index: { data: [articleRow], error: null },
    });
    await expect(getKnowledgeSitemapEntries("vi")).rejects.toThrow(
      "getPublishedIdeas failed.",
    );
  });
});

describe("getIdeaPage", () => {
  it("short-circuits a malformed slug without a database call", async () => {
    const rpc = mockRpc({});
    await expect(getIdeaPage("en", "Not A Slug!")).resolves.toBeNull();
    await expect(getIdeaPage("en", "../secret")).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null for a missing or unpublished idea", async () => {
    const rpc = mockRpc({ knowledge_idea_page: { data: null, error: null } });
    await expect(getIdeaPage("vi", "idea-one")).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith("knowledge_idea_page", {
      p_locale: "vi",
      p_slug: "idea-one",
    });
  });

  it("resolves relations in editorial order and drops references that are not visible", async () => {
    mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
      knowledge_idea_page: { data: ideaPageData(), error: null },
    });
    const page = await getIdeaPage("en", "idea-one");
    expect(page).not.toBeNull();
    expect(getBookCards).toHaveBeenCalledWith("en");

    expect(page?.question).toBe("Alpha?");
    expect(page?.shortAnswer).toBe("Alpha answer");
    expect(page?.alternateSlugs).toEqual({ vi: "y-tuong-mot" });
    expect(page?.createdAt).toBe("2026-02-01T00:00:00+00:00");
    expect(page?.updatedAt).toBe("2026-02-02T00:00:00+00:00");
    expect(page?.topics).toEqual([{ slug: "habits", name: "Habits" }]);
    expect(page?.blocks).toHaveLength(5);

    expect(page?.books.map((book) => book.bookId)).toEqual([BOOK_A]);
    expect(page?.relatedIdeas.map((idea) => idea.ideaId)).toEqual([IDEA_2]);

    // Block references resolve only to visible cards and published ideas.
    expect([...(page?.booksById.keys() ?? [])].sort()).toEqual(
      [BOOK_A, BOOK_B].sort(),
    );
    expect(page?.booksById.get(BOOK_B)?.slug).toBe("book-b");
    expect(page?.booksById.has(BOOK_GONE)).toBe(false);
    expect(page?.ideasById.get(IDEA_3)).toEqual({
      ideaId: IDEA_3,
      slug: "idea-three",
      question: "Gamma?",
      shortAnswer: "Gamma? answer",
    });
    expect(page?.ideasById.has(IDEA_GONE)).toBe(false);
    expect(page).not.toHaveProperty("bodyBlocks");
    expect(page).not.toHaveProperty("bookIds");
  });

  it("preserves the RPC relation order rather than sorting", async () => {
    mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
      knowledge_idea_page: {
        data: ideaPageData({
          bookIds: [BOOK_B, BOOK_A],
          relatedIdeaIds: [IDEA_3, IDEA_2],
        }),
        error: null,
      },
    });
    const page = await getIdeaPage("en", "idea-one");
    expect(page?.books.map((book) => book.slug)).toEqual(["book-b", "book-a"]);
    expect(page?.relatedIdeas.map((idea) => idea.slug)).toEqual([
      "idea-three",
      "idea-two",
    ]);
  });

  it("skips an unreadable stored block instead of failing the page", async () => {
    mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
      knowledge_idea_page: {
        data: ideaPageData({
          bodyBlocks: [
            { type: "html", html: "<script>alert(1)</script>" },
            { type: "heading", level: 2, text: "Kept" },
          ],
        }),
        error: null,
      },
    });
    const page = await getIdeaPage("en", "idea-one");
    expect(page?.blocks).toEqual([{ type: "heading", level: 2, text: "Kept" }]);
    expect(console.error).toHaveBeenCalledWith("Knowledge block skipped.", {
      index: 0,
      issues: expect.any(Array),
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("script");
  });
});

describe("getArticlePage", () => {
  it("short-circuits a malformed slug", async () => {
    const rpc = mockRpc({});
    await expect(getArticlePage("vi", "UPPER")).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns null for a missing localization", async () => {
    mockRpc({ knowledge_article_page: { data: null, error: null } });
    await expect(getArticlePage("en", "deep-reading")).resolves.toBeNull();
  });

  it("carries the byline and publish date and resolves relations in order", async () => {
    mockRpc({
      knowledge_idea_index: { data: ideaRows, error: null },
      knowledge_article_page: { data: articlePageData(), error: null },
    });
    const page = await getArticlePage("en", "deep-reading");
    expect(page?.author).toEqual({ name: "An Author", slug: null });
    expect(page?.publishedAt).toBe("2026-01-01T00:00:00+00:00");
    expect(page?.updatedAt).toBe("2026-01-02T00:00:00+00:00");
    expect(page?.seoTitle).toBe("SEO title");
    expect(page?.books.map((book) => book.bookId)).toEqual([BOOK_B, BOOK_A]);
    expect(page?.ideas.map((idea) => idea.ideaId)).toEqual([IDEA_3, IDEA_1]);
    expect(page?.booksById.get(BOOK_A)?.slug).toBe("book-a");
    expect([...(page?.ideasById.keys() ?? [])]).toEqual([IDEA_3, IDEA_1]);
  });

  it("omits a book-backed block's book when the book is no longer visible", async () => {
    vi.mocked(getBookCards).mockResolvedValue([card(BOOK_B, "book-b")]);
    mockRpc({
      knowledge_idea_index: { data: [], error: null },
      knowledge_article_page: {
        data: articlePageData({ ideaIds: [IDEA_1] }),
        error: null,
      },
    });
    const page = await getArticlePage("en", "deep-reading");
    expect(page?.booksById.has(BOOK_A)).toBe(false);
    expect(page?.books.map((book) => book.bookId)).toEqual([BOOK_B]);
    expect(page?.ideas).toEqual([]);
  });
});

describe("backlinks", () => {
  const links = [
    {
      kind: "idea",
      slug: "idea-one",
      title: "Alpha?",
      excerpt: "Yes.",
      published_at: null,
    },
    {
      kind: "article",
      slug: "newer",
      title: "Newer",
      excerpt: "N",
      published_at: "2026-03-01T00:00:00+00:00",
    },
  ];

  it("maps book backlinks in RPC order", async () => {
    const rpc = mockRpc({ knowledge_for_book: { data: links, error: null } });
    await expect(getKnowledgeForBook("vi", BOOK_A)).resolves.toEqual([
      {
        kind: "idea",
        slug: "idea-one",
        title: "Alpha?",
        excerpt: "Yes.",
        publishedAt: null,
      },
      {
        kind: "article",
        slug: "newer",
        title: "Newer",
        excerpt: "N",
        publishedAt: "2026-03-01T00:00:00+00:00",
      },
    ]);
    expect(rpc).toHaveBeenCalledWith("knowledge_for_book", {
      p_locale: "vi",
      p_book_id: BOOK_A,
    });
  });

  it("maps topic backlinks", async () => {
    const rpc = mockRpc({
      knowledge_for_topic: { data: links.slice(1), error: null },
    });
    const result = await getKnowledgeForTopic("en", TOPIC_ID);
    expect(result.map((link) => link.slug)).toEqual(["newer"]);
    expect(rpc).toHaveBeenCalledWith("knowledge_for_topic", {
      p_locale: "en",
      p_topic_id: TOPIC_ID,
    });
  });

  it("accepts hand-written fixture ids and short-circuits non-ids", async () => {
    const rpc = mockRpc({ knowledge_for_book: { data: [], error: null } });
    await expect(
      getKnowledgeForBook("vi", "d5710000-0000-0000-0000-000000000001"),
    ).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
    await expect(getKnowledgeForBook("vi", "not-an-id")).resolves.toEqual([]);
    await expect(getKnowledgeForTopic("vi", "")).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

// Regression: a failed backlink read used to reject, and the book and topic pages await it, so one
// RPC failure broke every book and topic page. Backlinks now degrade like the recommendation shelf:
// log once (no headers() read - these pages are static), render no links, keep Next.js control flow.
describe("backlink failures", () => {
  const dbError = {
    code: "42883",
    message: "relation secret_table does not exist",
  };

  const cases = [
    {
      operation: "getKnowledgeForBook",
      rpcName: "knowledge_for_book",
      run: () => getKnowledgeForBook("en", BOOK_A),
    },
    {
      operation: "getKnowledgeForTopic",
      rpcName: "knowledge_for_topic",
      run: () => getKnowledgeForTopic("en", TOPIC_ID),
    },
  ];

  it.each(cases)(
    "$operation degrades a database error to no links and logs it once",
    async ({ operation, rpcName, run }) => {
      mockRpc({ [rpcName]: { data: null, error: dbError } });

      await expect(run()).resolves.toEqual([]);
      expect(headers).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("Knowledge read failed.", {
        operation,
        code: "42883",
        message: "relation secret_table does not exist",
        requestId: null,
      });
    },
  );

  it.each(cases)(
    "$operation degrades a malformed response to no links",
    async ({ operation, rpcName, run }) => {
      mockRpc({ [rpcName]: { data: [{ kind: "podcast" }], error: null } });

      await expect(run()).resolves.toEqual([]);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith(
        "Knowledge read failed.",
        expect.objectContaining({ operation, code: "invalid_response", requestId: null }),
      );
    },
  );

  it.each(cases)(
    "$operation rethrows Next.js control flow instead of degrading it",
    async ({ run }) => {
      let control: unknown;
      try {
        notFound();
      } catch (error) {
        control = error;
      }
      vi.mocked(createPublicClient).mockImplementation(() => {
        throw control;
      });

      await expect(run()).rejects.toBe(control);
    },
  );
});

describe("read failures", () => {
  const dbError = {
    code: "42P01",
    message: "relation secret_table does not exist",
  };

  const cases: { operation: string; run: () => Promise<unknown> }[] = [
    {
      operation: "getPublishedIdeas",
      run: () => {
        mockRpc({ knowledge_idea_index: { data: null, error: dbError } });
        return getPublishedIdeas("en");
      },
    },
    {
      operation: "getArticleIndex",
      run: () => {
        mockRpc({ knowledge_article_index: { data: null, error: dbError } });
        return getArticleIndex("en");
      },
    },
    {
      operation: "getIdeaPage",
      run: () => {
        mockRpc({ knowledge_idea_page: { data: null, error: dbError } });
        return getIdeaPage("en", "idea-one");
      },
    },
    {
      operation: "getArticlePage",
      run: () => {
        mockRpc({ knowledge_article_page: { data: null, error: dbError } });
        return getArticlePage("en", "deep-reading");
      },
    },
  ];

  it.each(cases)(
    "$operation hides database error text and logs it with the request ID",
    async ({ operation, run }) => {
      const rejection = await run().then(
        () => {
          throw new Error("expected a rejection");
        },
        (error: unknown) => error as Error,
      );

      expect(rejection.message).toBe(`${operation} failed.`);
      expect(rejection.message).not.toContain("secret_table");
      expect(rejection.cause).toBe(dbError);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith("Knowledge read failed.", {
        operation,
        code: "42P01",
        message: "relation secret_table does not exist",
        requestId: "req_knowledge123",
      });
    },
  );

  it("rejects a malformed index response instead of rendering a partial page", async () => {
    mockRpc({
      knowledge_idea_index: { data: [{ idea_id: IDEA_1 }], error: null },
    });
    await expect(getIdeaIndex("en")).rejects.toThrow(
      "getPublishedIdeas failed.",
    );
  });
});
