// @vitest-environment node
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createArticle,
  createIdea,
  DuplicateKnowledgeSlugError,
  getAdminKnowledge,
  KnowledgeLocalizationMissingError,
  KnowledgeNotFoundError,
  KnowledgeNotReadyError,
  KnowledgeReferenceNotFoundError,
  listAdminKnowledge,
  publishKnowledge,
  saveArticleLocalization,
  saveIdeaLocalization,
  saveKnowledgeSeo,
  setArticleRelations,
  setIdeaRelations,
  unpublishKnowledge,
  updateArticleDetails,
} from "@/lib/data/admin-knowledge";
import { recordingChain } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const ideaId = "5a1b2c3d-0000-4000-8000-000000000001";
const otherIdea = "5a1b2c3d-0000-4000-8000-000000000002";
const thirdIdea = "5a1b2c3d-0000-4000-8000-000000000003";
const articleId = "5a1b2c3d-0000-4000-8000-0000000000a0";
const authorId = "5a1b2c3d-0000-4000-8000-0000000000a1";
const bookA = "5a1b2c3d-0000-4000-8000-0000000000b1";
const bookB = "5a1b2c3d-0000-4000-8000-0000000000b2";
const topicA = "5a1b2c3d-0000-4000-8000-0000000000c1";
const paragraph = { type: "paragraph", content: [{ text: "Đọc chậm lại." }] };

function fakeClient(options: {
  tables?: Record<string, { data: unknown; error: unknown }>;
  rpc?: { data: unknown; error: unknown };
}): { client: SessionClient; calls: Record<string, [string, unknown[]][]>; rpc: Mock } {
  const calls: Record<string, [string, unknown[]][]> = {};
  const from = vi.fn((table: string) => {
    const recorded = recordingChain(options.tables?.[table] ?? { data: null, error: null }, (calls[table] ??= []));
    return recorded.chain;
  });
  const rpc = vi.fn(() => Promise.resolve(options.rpc ?? { data: null, error: null }));
  return { client: { from, rpc } as unknown as SessionClient, calls, rpc };
}

function ideaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ideaId,
    status: "draft",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
    localizations: [
      {
        id: "loc-en",
        locale: "en",
        slug: "read-slowly",
        question: "Why read slowly?",
        short_answer: "To remember.",
        body_blocks: [],
        seo_title: "Slow reading",
        seo_description: null,
        updated_at: "2026-09-02T00:00:00Z",
      },
      {
        id: "loc-vi",
        locale: "vi",
        slug: "doc-cham",
        question: "Vì sao nên đọc chậm?",
        short_answer: "Để nhớ lâu.",
        body_blocks: [paragraph],
        seo_title: null,
        seo_description: "Mô tả",
        updated_at: "2026-09-02T00:00:00Z",
      },
    ],
    // Deliberately out of position order: the DTO sorts, it does not echo row order.
    books: [
      { book_id: bookB, position: 2, book: { status: "draft", localizations: [{ locale: "en" }, { locale: "vi" }] } },
      { book_id: bookA, position: 1, book: { status: "published", localizations: [{ locale: "en" }, { locale: "vi" }] } },
    ],
    topics: [{ topic_id: topicA }],
    links: [
      { related_idea_id: thirdIdea, position: 2 },
      { related_idea_id: otherIdea, position: 1 },
    ],
    ...overrides,
  };
}

function articleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: articleId,
    status: "published",
    author_id: authorId,
    published_at: "2026-09-03T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
    localizations: [
      {
        id: "a-loc-vi",
        locale: "vi",
        slug: "doc-cham",
        title: "Đọc chậm",
        excerpt: "Tóm tắt.",
        body_blocks: [paragraph],
        seo_title: null,
        seo_description: null,
        updated_at: "2026-09-02T00:00:00Z",
      },
    ],
    books: [{ book_id: bookA, position: 1 }],
    ideas: [
      { idea_id: otherIdea, position: 2 },
      { idea_id: ideaId, position: 1 },
    ],
    topics: [{ topic_id: topicA }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("authorization precedes client creation", () => {
  const denied = new Error("NEXT_FORBIDDEN");
  const ideaLocalization = { locale: "vi" as const, slug: "a", question: "Q", shortAnswer: "A", bodyBlocks: [] };
  const articleLocalization = { locale: "vi" as const, slug: "a", title: "T", excerpt: "E", bodyBlocks: [] };
  const calls: [string, () => Promise<unknown>][] = [
    ["listAdminKnowledge(idea)", () => listAdminKnowledge("idea")],
    ["listAdminKnowledge(article)", () => listAdminKnowledge("article")],
    ["getAdminKnowledge(idea)", () => getAdminKnowledge("idea", ideaId)],
    ["getAdminKnowledge(article)", () => getAdminKnowledge("article", articleId)],
    ["createIdea", () => createIdea({ locale: "vi", slug: "a", question: "Q", shortAnswer: "A" })],
    ["createArticle", () => createArticle({ authorId, locale: "vi", slug: "a", title: "T", excerpt: "E" })],
    ["updateArticleDetails", () => updateArticleDetails(articleId, { authorId })],
    ["saveIdeaLocalization", () => saveIdeaLocalization(ideaId, ideaLocalization)],
    ["saveArticleLocalization", () => saveArticleLocalization(articleId, articleLocalization)],
    ["saveKnowledgeSeo", () => saveKnowledgeSeo("idea", ideaId, { locale: "vi", seoTitle: null, seoDescription: null })],
    ["setIdeaRelations", () => setIdeaRelations(ideaId, { bookIds: [], topicIds: [], relatedIdeaIds: [] })],
    ["setArticleRelations", () => setArticleRelations(articleId, { bookIds: [], ideaIds: [], topicIds: [] })],
    ["publishKnowledge", () => publishKnowledge("idea", ideaId)],
    ["unpublishKnowledge", () => unpublishKnowledge("article", articleId)],
  ];

  it.each(calls)("%s never builds a client for a denied caller", async (_name, call) => {
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each(calls)("%s authorizes before it builds a client", async (name, call) => {
    const list = name.startsWith("list");
    const fake = fakeClient({
      tables: {
        ideas: { data: list ? [ideaRow()] : ideaRow(), error: null },
        articles: { data: list ? [articleRow()] : articleRow(), error: null },
      },
      rpc: { data: ideaId, error: null },
    });
    vi.mocked(createClient).mockImplementation(async () => {
      expect(requireAdmin).toHaveBeenCalled();
      return fake.client;
    });
    await call();
    expect(createClient).toHaveBeenCalled();
  });
});

describe("getAdminKnowledge", () => {
  it("maps an idea: locales vi then en, ordered relations, persisted SEO, readiness", async () => {
    const fake = fakeClient({ tables: { ideas: { data: ideaRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const idea = await getAdminKnowledge("idea", ideaId);

    expect(idea.kind).toBe("idea");
    if (idea.kind !== "idea") throw new Error("expected an idea");
    expect(idea.localizations.map((localization) => localization.locale)).toEqual(["vi", "en"]);
    expect(idea.localizations[0]).toMatchObject({
      slug: "doc-cham",
      question: "Vì sao nên đọc chậm?",
      shortAnswer: "Để nhớ lâu.",
      bodyBlocks: [paragraph],
      storedBlocksReadable: true,
      seoTitle: null,
      seoDescription: "Mô tả",
    });
    expect(idea.localizations[1].seoTitle).toBe("Slow reading");
    expect(idea.bookIds).toEqual([bookA, bookB]);
    expect(idea.relatedIdeaIds).toEqual([otherIdea, thirdIdea]);
    expect(idea.topicIds).toEqual([topicA]);
    expect(idea.readinessIssues).toEqual([]);
  });

  it("reports idea readiness from the snapshot", async () => {
    const fake = fakeClient({
      tables: {
        ideas: {
          data: ideaRow({ books: [], localizations: [{ ...ideaRow().localizations[0], body_blocks: [] }] }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const idea = await getAdminKnowledge("idea", ideaId);

    expect(idea.readinessIssues).toEqual(["missing_blocks", "missing_related_book"]);
  });

  // Regression: a draft (or archived) related book is not shown on the public idea page, so it
  // must not satisfy missing_related_book - the same rule idea_readiness_issues applies in SQL.
  it("does not count unpublished related books toward readiness", async () => {
    const fake = fakeClient({
      tables: {
        ideas: {
          data: ideaRow({
            books: [
              { book_id: bookA, position: 1, book: { status: "draft", localizations: [{ locale: "en" }, { locale: "vi" }] } },
              { book_id: bookB, position: 2, book: { status: "archived", localizations: [{ locale: "vi" }] } },
            ],
          }),
          error: null,
        },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const idea = await getAdminKnowledge("idea", ideaId);

    expect(idea.bookIds).toEqual([bookA, bookB]);
    expect(idea.readinessIssues).toEqual(["missing_related_book"]);
  });

  it("maps an article with its author, publish date, and ordered books and ideas", async () => {
    const fake = fakeClient({ tables: { articles: { data: articleRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const article = await getAdminKnowledge("article", articleId);

    if (article.kind !== "article") throw new Error("expected an article");
    expect(article.authorId).toBe(authorId);
    expect(article.publishedAt).toBe("2026-09-03T00:00:00Z");
    expect(article.status).toBe("published");
    expect(article.localizations[0]).toMatchObject({ title: "Đọc chậm", excerpt: "Tóm tắt.", bodyBlocks: [paragraph] });
    expect(article.bookIds).toEqual([bookA]);
    expect(article.ideaIds).toEqual([ideaId, otherIdea]);
    expect(article.topicIds).toEqual([topicA]);
    expect(article.readinessIssues).toEqual([]);
  });

  it("flags stored blocks the schema cannot read instead of handing them to the editor", async () => {
    const broken = { ...ideaRow().localizations[1], body_blocks: [{ type: "html", html: "<p>x</p>" }] };
    const fake = fakeClient({ tables: { ideas: { data: ideaRow({ localizations: [broken] }), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const idea = await getAdminKnowledge("idea", ideaId);

    expect(idea.localizations[0].bodyBlocks).toEqual([]);
    expect(idea.localizations[0].storedBlocksReadable).toBe(false);
  });

  it("rejects an id that is not a uuid without querying", async () => {
    await expect(getAdminKnowledge("idea", "not-a-uuid")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("renders a missing entity as not found", async () => {
    const fake = fakeClient({ tables: { articles: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(getAdminKnowledge("article", articleId)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("disambiguates the self-referencing idea_links embed", async () => {
    const fake = fakeClient({ tables: { ideas: { data: ideaRow(), error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await getAdminKnowledge("idea", ideaId);

    const select = fake.calls.ideas.find(([method]) => method === "select");
    expect(String(select?.[1][0])).toContain("idea_links!idea_links_idea_id_fkey");
  });

  it("never leaks raw database text", async () => {
    const fake = fakeClient({ tables: { ideas: { data: null, error: { code: "42P01", message: "relation ideas does not exist" } } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(getAdminKnowledge("idea", ideaId)).rejects.toThrow("getAdminKnowledge failed.");
  });
});

describe("listAdminKnowledge", () => {
  it("summarises ideas with status, locale coverage, and readiness", async () => {
    const fake = fakeClient({
      tables: { ideas: { data: [ideaRow(), ideaRow({ id: otherIdea, books: [], localizations: [] })], error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const ideas = await listAdminKnowledge("idea");

    expect(ideas).toEqual([
      { kind: "idea", id: ideaId, title: "Vì sao nên đọc chậm?", status: "draft", locales: ["vi", "en"], readinessIssues: [] },
      {
        kind: "idea",
        id: otherIdea,
        title: otherIdea,
        status: "draft",
        locales: [],
        readinessIssues: ["missing_localization", "missing_blocks", "missing_related_book"],
      },
    ]);
  });

  it("summarises articles by title", async () => {
    const fake = fakeClient({ tables: { articles: { data: [articleRow()], error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const [article] = await listAdminKnowledge("article");

    expect(article).toEqual({
      kind: "article",
      id: articleId,
      title: "Đọc chậm",
      status: "published",
      locales: ["vi"],
      readinessIssues: [],
    });
  });
});

describe("mutations", () => {
  it("creates an idea through admin_create_idea", async () => {
    const fake = fakeClient({ rpc: { data: ideaId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(createIdea({ locale: "vi", slug: "doc-cham", question: "Q?", shortAnswer: "A." })).resolves.toEqual({ id: ideaId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_idea", {
      p_locale: "vi",
      p_slug: "doc-cham",
      p_question: "Q?",
      p_short_answer: "A.",
    });
  });

  it("creates an article through admin_create_article", async () => {
    const fake = fakeClient({ rpc: { data: articleId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(createArticle({ authorId, locale: "en", slug: "slow", title: "Slow", excerpt: "E" })).resolves.toEqual({ id: articleId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_article", {
      p_author_id: authorId,
      p_locale: "en",
      p_slug: "slow",
      p_title: "Slow",
      p_excerpt: "E",
    });
  });

  it("maps a missing author on create to a reference error", async () => {
    const fake = fakeClient({ rpc: { data: null, error: { code: "P0002", message: `admin_create_article: author ${authorId} does not exist` } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(createArticle({ authorId, locale: "en", slug: "slow", title: "Slow", excerpt: "E" })).rejects.toBeInstanceOf(
      KnowledgeReferenceNotFoundError,
    );
  });

  it.each([
    ["idea", "idea_localizations_locale_slug_key"],
    ["article", "article_localizations_locale_slug_key"],
  ] as const)("maps a duplicate %s locale/slug to DuplicateKnowledgeSlugError", async (kind, constraint) => {
    const fake = fakeClient({
      rpc: { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    const call =
      kind === "idea"
        ? saveIdeaLocalization(ideaId, { locale: "vi", slug: "taken", question: "Q", shortAnswer: "A", bodyBlocks: [] })
        : saveArticleLocalization(articleId, { locale: "vi", slug: "taken", title: "T", excerpt: "E", bodyBlocks: [] });
    await expect(call).rejects.toBeInstanceOf(DuplicateKnowledgeSlugError);
  });

  it("saves an idea localization with its typed blocks", async () => {
    const fake = fakeClient({ rpc: { data: "loc", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await saveIdeaLocalization(ideaId, {
      locale: "vi",
      slug: "doc-cham",
      question: "Q",
      shortAnswer: "A",
      bodyBlocks: [paragraph as never],
    });

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_idea_localization", {
      p_idea_id: ideaId,
      p_locale: "vi",
      p_slug: "doc-cham",
      p_question: "Q",
      p_short_answer: "A",
      p_body_blocks: [paragraph],
    });
  });

  it("saves an article localization and details", async () => {
    const fake = fakeClient({ rpc: { data: "loc", error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await saveArticleLocalization(articleId, { locale: "en", slug: "slow", title: "T", excerpt: "E", bodyBlocks: [] });
    await updateArticleDetails(articleId, { authorId });

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_article_localization", {
      p_article_id: articleId,
      p_locale: "en",
      p_slug: "slow",
      p_title: "T",
      p_excerpt: "E",
      p_body_blocks: [],
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_update_article", { p_article_id: articleId, p_author_id: authorId });
  });

  it("saves SEO through the entity's own RPC", async () => {
    const fake = fakeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await saveKnowledgeSeo("idea", ideaId, { locale: "vi", seoTitle: "T", seoDescription: null });
    await saveKnowledgeSeo("article", articleId, { locale: "en", seoTitle: null, seoDescription: "D" });

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_idea_seo", {
      p_idea_id: ideaId,
      p_locale: "vi",
      p_seo_title: "T",
      p_seo_description: null,
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_save_article_seo", {
      p_article_id: articleId,
      p_locale: "en",
      p_seo_title: null,
      p_seo_description: "D",
    });
  });

  it("maps SEO for a locale with no localization to its own error", async () => {
    const fake = fakeClient({
      rpc: { data: null, error: { code: "P0002", message: `admin_save_idea_seo: idea ${ideaId} has no en localization` } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(saveKnowledgeSeo("idea", ideaId, { locale: "en", seoTitle: "T", seoDescription: null })).rejects.toBeInstanceOf(
      KnowledgeLocalizationMissingError,
    );
  });

  it("submits the complete ordered relation lists", async () => {
    const fake = fakeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await setIdeaRelations(ideaId, { bookIds: [bookB, bookA], topicIds: [topicA], relatedIdeaIds: [thirdIdea, otherIdea] });
    await setArticleRelations(articleId, { bookIds: [bookA], ideaIds: [otherIdea, ideaId], topicIds: [] });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_idea_relations", {
      p_idea_id: ideaId,
      p_book_ids: [bookB, bookA],
      p_topic_ids: [topicA],
      p_related_idea_ids: [thirdIdea, otherIdea],
    });
    expect(fake.rpc).toHaveBeenCalledWith("admin_set_article_relations", {
      p_article_id: articleId,
      p_book_ids: [bookA],
      p_idea_ids: [otherIdea, ideaId],
      p_topic_ids: [],
    });
  });

  it("tells a missing entity apart from a missing relation target", async () => {
    const gone = fakeClient({ rpc: { data: null, error: { code: "P0002", message: `admin_set_idea_relations: idea ${ideaId} does not exist` } } });
    vi.mocked(createClient).mockResolvedValue(gone.client);
    await expect(setIdeaRelations(ideaId, { bookIds: [], topicIds: [], relatedIdeaIds: [] })).rejects.toBeInstanceOf(KnowledgeNotFoundError);

    const target = fakeClient({ rpc: { data: null, error: { code: "P0002", message: `admin_set_idea_relations: book ${bookA} does not exist` } } });
    vi.mocked(createClient).mockResolvedValue(target.client);
    await expect(setIdeaRelations(ideaId, { bookIds: [bookA], topicIds: [], relatedIdeaIds: [] })).rejects.toBeInstanceOf(
      KnowledgeReferenceNotFoundError,
    );
  });

  // Regression: the id in an admin URL may be uppercase while Postgres prints uuids in lowercase, so
  // a case-sensitive match misread a missing entry as a missing relation target.
  it("recognises a missing entity whatever the case of the id it was called with", async () => {
    const gone = fakeClient({ rpc: { data: null, error: { code: "P0002", message: `admin_set_idea_relations: idea ${ideaId} does not exist` } } });
    vi.mocked(createClient).mockResolvedValue(gone.client);
    await expect(
      setIdeaRelations(ideaId.toUpperCase(), { bookIds: [], topicIds: [], relatedIdeaIds: [] }),
    ).rejects.toBeInstanceOf(KnowledgeNotFoundError);
  });

  it("never leaks raw database text from an unexpected failure", async () => {
    const fake = fakeClient({ rpc: { data: null, error: { code: "22023", message: "admin_set_idea_relations: an idea cannot link to itself" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await expect(setIdeaRelations(ideaId, { bookIds: [], topicIds: [], relatedIdeaIds: [ideaId] })).rejects.toThrow(
      "setIdeaRelations failed.",
    );
  });

  it("refuses a non-uuid entity id before building a client", async () => {
    await expect(saveKnowledgeSeo("idea", "../x", { locale: "vi", seoTitle: null, seoDescription: null })).rejects.toBeInstanceOf(
      KnowledgeNotFoundError,
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps EB032 and EB033 to KnowledgeNotReadyError carrying the issue codes", async () => {
    const idea = fakeClient({
      rpc: { data: null, error: { code: "EB032", message: "publish_idea: idea is not ready: missing_blocks,missing_related_book" } },
    });
    vi.mocked(createClient).mockResolvedValue(idea.client);
    await expect(publishKnowledge("idea", ideaId)).rejects.toMatchObject({
      name: "KnowledgeNotReadyError",
      issues: ["missing_blocks", "missing_related_book"],
    });

    const article = fakeClient({
      rpc: { data: null, error: { code: "EB033", message: "publish_article: article is not ready: missing_localization,missing_blocks" } },
    });
    vi.mocked(createClient).mockResolvedValue(article.client);
    const error = await publishKnowledge("article", articleId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KnowledgeNotReadyError);
    expect((error as KnowledgeNotReadyError).issues).toEqual(["missing_localization", "missing_blocks"]);
  });

  it("publishes and unpublishes through the kind's RPCs", async () => {
    const fake = fakeClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client);

    await publishKnowledge("idea", ideaId);
    await unpublishKnowledge("idea", ideaId);
    await publishKnowledge("article", articleId);
    await unpublishKnowledge("article", articleId);

    expect(fake.rpc).toHaveBeenCalledWith("publish_idea", { p_idea_id: ideaId });
    expect(fake.rpc).toHaveBeenCalledWith("unpublish_idea", { p_idea_id: ideaId });
    expect(fake.rpc).toHaveBeenCalledWith("publish_article", { p_article_id: articleId });
    expect(fake.rpc).toHaveBeenCalledWith("unpublish_article", { p_article_id: articleId });
  });
});
