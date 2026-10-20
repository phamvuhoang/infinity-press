import "server-only";
import { alternateSlugsSchema } from "@/lib/i18n/alternates";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { cache } from "react";
import { z } from "zod";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getBookCards } from "@/lib/data/catalog";
import type { Locale } from "@/lib/i18n/config";
import { getKnowledgeRoutes } from "@/lib/i18n/routes";
import {
  type KnowledgeBlock,
  type KnowledgeIdeaReference,
  knowledgeBlockSchema,
} from "@/lib/knowledge/blocks";
import type {
  KnowledgeArticlePage,
  KnowledgeArticleSummary,
  KnowledgeIdeaIndexGroup,
  KnowledgeIdeaPage,
  KnowledgeIdeaSummary,
  KnowledgeLinkSummary,
  KnowledgeTopicRef,
} from "@/lib/knowledge/public-types";
import { getRequestId } from "@/lib/observability/request-id";
import { createPublicClient } from "@/lib/supabase/public";

// Public knowledge reads. Everything goes through the published read functions of
// 20260927120000 with the cookie-less public client; those functions filter status and locale
// themselves. Every response is parsed here, body blocks included, and every book or idea a page
// names is resolved to a visible card or summary before a component sees it, so BlockRenderer and
// the pages never query.

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function currentRequestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    // Outside a request scope (for example a build-time render) there is no request ID.
    return null;
  }
}

// Callers and pages only see the generic message. The database or parse error stays on `cause` and
// goes to the server log once, with the request ID the proxy set. A caller that renders inside a
// static book or topic page passes `requestId` (null) instead: reading headers() there marks the
// route dynamic even inside a try/catch, which would drop the prerender - the regression
// lib/data/recommendations.ts documents for the shelf. A static render has no request to correlate.
async function failure(operation: string, cause: unknown, requestId?: string | null): Promise<Error> {
  const detail =
    cause instanceof z.ZodError
      ? { code: "invalid_response", message: cause.message }
      : {
          code: (cause as { code?: string } | null)?.code ?? null,
          message:
            (cause as { message?: string } | null)?.message ?? String(cause),
        };
  console.error("Knowledge read failed.", {
    operation,
    ...detail,
    requestId: requestId === undefined ? await currentRequestId() : requestId,
  });
  return new Error(`${operation} failed.`, { cause });
}

async function parse<T>(
  operation: string,
  schema: z.ZodType<T>,
  data: unknown,
  requestId?: string | null,
): Promise<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw await failure(operation, parsed.error, requestId);
  return parsed.data;
}

// Stored blocks are parsed one by one: the admin RPCs validate writes with an approximation of
// knowledgeBlockSchema that cannot match it exactly (URL and grapheme rules), so a block that
// slips through must cost the page that block, not the whole page. Only the index path and issue
// codes are logged, never the content. No request ID: static pages reach this schema and must not
// call headers().
const readableBlocksSchema = z.array(z.unknown()).transform((items): KnowledgeBlock[] =>
  items.flatMap((item, index) => {
    const parsed = knowledgeBlockSchema.safeParse(item);
    if (parsed.success) return [parsed.data];
    console.error("Knowledge block skipped.", {
      index,
      issues: parsed.error.issues.map((issue) => `${issue.code}:${issue.path.join(".")}`),
    });
    return [];
  }),
);

const topicRefsSchema = z.array(
  z.object({ slug: z.string(), name: z.string() }),
);
const authorSchema = z.object({
  name: z.string(),
  slug: z.string().nullable(),
});
const idsSchema = z.array(z.string());

const ideaIndexRowsSchema = z.array(
  z.object({
    idea_id: z.string(),
    slug: z.string(),
    question: z.string(),
    short_answer: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    alternate_slugs: alternateSlugsSchema,
    topics: topicRefsSchema,
  }),
);

const articleIndexRowsSchema = z.array(
  z.object({
    article_id: z.string(),
    slug: z.string(),
    title: z.string(),
    excerpt: z.string(),
    published_at: z.string(),
    updated_at: z.string(),
    alternate_slugs: alternateSlugsSchema,
    author: authorSchema,
  }),
);

const ideaPageSchema = z.object({
  ideaId: z.string(),
  slug: z.string(),
  question: z.string(),
  shortAnswer: z.string(),
  bodyBlocks: readableBlocksSchema,
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  alternateSlugs: alternateSlugsSchema,
  bookIds: idsSchema,
  relatedIdeaIds: idsSchema,
  topics: topicRefsSchema,
});

const articlePageSchema = z.object({
  articleId: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string(),
  bodyBlocks: readableBlocksSchema,
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  publishedAt: z.string(),
  updatedAt: z.string(),
  alternateSlugs: alternateSlugsSchema,
  author: authorSchema,
  bookIds: idsSchema,
  ideaIds: idsSchema,
  topics: topicRefsSchema,
});

const linkRowsSchema = z.array(
  z.object({
    kind: z.enum(["idea", "article"]),
    slug: z.string(),
    title: z.string(),
    excerpt: z.string(),
    published_at: z.string().nullable(),
  }),
);

// Every published idea localized in `locale`, in the database's question-then-id order. Also the
// source of `ideasById` and related-idea summaries, so a page never shows an unpublished idea.
export const getPublishedIdeas = cache(
  async (locale: Locale): Promise<KnowledgeIdeaSummary[]> => {
    const { data, error } = await createPublicClient().rpc(
      "knowledge_idea_index",
      { p_locale: locale },
    );
    if (error) throw await failure("getPublishedIdeas", error);
    const rows = await parse(
      "getPublishedIdeas",
      ideaIndexRowsSchema,
      data ?? [],
    );
    return rows.map((row) => ({
      ideaId: row.idea_id,
      slug: row.slug,
      question: row.question,
      shortAnswer: row.short_answer,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      alternateSlugs: row.alternate_slugs,
      topics: row.topics,
    }));
  },
);

// The idea index grouped by topic. An idea appears under every one of its topics; an idea with no
// visible topic appears once in the trailing `topic: null` (Other) group. Topics are ordered by
// localized name; ideas keep the database order inside each group.
export const getIdeaIndex = cache(
  async (locale: Locale): Promise<KnowledgeIdeaIndexGroup[]> => {
    const ideas = await getPublishedIdeas(locale);
    const groups = new Map<
      string,
      { topic: KnowledgeTopicRef; ideas: KnowledgeIdeaSummary[] }
    >();
    const other: KnowledgeIdeaSummary[] = [];

    for (const idea of ideas) {
      if (idea.topics.length === 0) {
        other.push(idea);
        continue;
      }
      for (const topic of idea.topics) {
        const group = groups.get(topic.slug) ?? { topic, ideas: [] };
        if (!group.ideas.some((existing) => existing.ideaId === idea.ideaId))
          group.ideas.push(idea);
        groups.set(topic.slug, group);
      }
    }

    const collator = new Intl.Collator(locale);
    const ordered: KnowledgeIdeaIndexGroup[] = [...groups.values()].sort(
      (left, right) =>
        collator.compare(left.topic.name, right.topic.name) ||
        left.topic.slug.localeCompare(right.topic.slug),
    );
    if (other.length > 0) ordered.push({ topic: null, ideas: other });
    return ordered;
  },
);

// Published articles localized in `locale`, newest first (then id), as the database orders them.
export const getArticleIndex = cache(
  async (locale: Locale): Promise<KnowledgeArticleSummary[]> => {
    const { data, error } = await createPublicClient().rpc(
      "knowledge_article_index",
      { p_locale: locale },
    );
    if (error) throw await failure("getArticleIndex", error);
    const rows = await parse(
      "getArticleIndex",
      articleIndexRowsSchema,
      data ?? [],
    );
    return rows.map((row) => ({
      articleId: row.article_id,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      alternateSlugs: row.alternate_slugs,
      author: row.author,
    }));
  },
);

export type KnowledgeSitemapEntry = { path: string; lastModified: string };

// Every published idea and article detail path in `locale`, from the same reads the index pages and
// generateStaticParams use, so a listed URL is a page that exists. lastModified is the
// localization's last edit. Either read failing rejects the whole list: a sitemap missing half the
// hub must not be served as if it were complete.
export async function getKnowledgeSitemapEntries(
  locale: Locale,
): Promise<KnowledgeSitemapEntry[]> {
  const [ideas, articles] = await Promise.all([
    getPublishedIdeas(locale),
    getArticleIndex(locale),
  ]);
  const routes = getKnowledgeRoutes(locale);
  const entries = new Map<string, KnowledgeSitemapEntry>();
  for (const { path, lastModified } of [
    ...ideas.map((idea) => ({
      path: routes.idea(idea.slug),
      lastModified: idea.updatedAt,
    })),
    ...articles.map((article) => ({
      path: routes.article(article.slug),
      lastModified: article.updatedAt,
    })),
  ]) {
    if (!entries.has(path)) entries.set(path, { path, lastModified });
  }
  return [...entries.values()];
}

function blockBookIds(blocks: KnowledgeBlock[]): string[] {
  return blocks.flatMap((block) => {
    if (block.type === "book_quote" || block.type === "book_card")
      return [block.bookId];
    if (block.type === "quote" && block.bookId !== undefined)
      return [block.bookId];
    return [];
  });
}

function blockIdeaIds(blocks: KnowledgeBlock[]): string[] {
  return blocks.flatMap((block) =>
    block.type === "idea_card" ? [block.ideaId] : [],
  );
}

// Resolves ids against visible cards and summaries: relation arrays keep their order and silently
// drop anything no longer visible, and the renderer maps hold only what the page references.
async function resolveReferences(
  locale: Locale,
  blocks: KnowledgeBlock[],
  relationBookIds: string[],
  relationIdeaIds: string[],
) {
  const [cards, ideas] = await Promise.all([
    getBookCards(locale),
    getPublishedIdeas(locale),
  ]);
  const cardById = new Map(cards.map((card) => [card.bookId, card]));
  const ideaById = new Map(ideas.map((idea) => [idea.ideaId, idea]));

  const books = relationBookIds.flatMap((id) => cardById.get(id) ?? []);
  const relatedIdeas = relationIdeaIds.flatMap((id) => ideaById.get(id) ?? []);

  const booksById = new Map<string, CatalogBookCard>();
  for (const id of [...relationBookIds, ...blockBookIds(blocks)]) {
    const card = cardById.get(id);
    if (card) booksById.set(id, card);
  }
  const ideasById = new Map<string, KnowledgeIdeaReference>();
  for (const id of [...relationIdeaIds, ...blockIdeaIds(blocks)]) {
    const idea = ideaById.get(id);
    if (idea) {
      ideasById.set(id, {
        ideaId: idea.ideaId,
        slug: idea.slug,
        question: idea.question,
        shortAnswer: idea.shortAnswer,
      });
    }
  }

  return { books, relatedIdeas, booksById, ideasById };
}

// Null means notFound(): a malformed slug, or no published idea localized in `locale` under it.
export const getIdeaPage = cache(
  async (locale: Locale, slug: string): Promise<KnowledgeIdeaPage | null> => {
    if (!slugPattern.test(slug)) return null;

    const { data, error } = await createPublicClient().rpc(
      "knowledge_idea_page",
      { p_locale: locale, p_slug: slug },
    );
    if (error) throw await failure("getIdeaPage", error);
    if (data === null) return null;

    const { bodyBlocks, bookIds, relatedIdeaIds, ...page } = await parse(
      "getIdeaPage",
      ideaPageSchema,
      data,
    );
    const { books, relatedIdeas, booksById, ideasById } =
      await resolveReferences(locale, bodyBlocks, bookIds, relatedIdeaIds);
    return {
      ...page,
      blocks: bodyBlocks,
      books,
      relatedIdeas,
      booksById,
      ideasById,
    };
  },
);

// Null means notFound(): a malformed slug, or no published article localized in `locale` under it.
export const getArticlePage = cache(
  async (
    locale: Locale,
    slug: string,
  ): Promise<KnowledgeArticlePage | null> => {
    if (!slugPattern.test(slug)) return null;

    const { data, error } = await createPublicClient().rpc(
      "knowledge_article_page",
      { p_locale: locale, p_slug: slug },
    );
    if (error) throw await failure("getArticlePage", error);
    if (data === null) return null;

    const { bodyBlocks, bookIds, ideaIds, ...page } = await parse(
      "getArticlePage",
      articlePageSchema,
      data,
    );
    const { books, relatedIdeas, booksById, ideasById } =
      await resolveReferences(locale, bodyBlocks, bookIds, ideaIds);
    return {
      ...page,
      blocks: bodyBlocks,
      books,
      ideas: relatedIdeas,
      booksById,
      ideasById,
    };
  },
);

// Any 8-4-4-4-12 hex id, not only RFC 4122 variants: fixture and seed ids are hand-written.
const idSchema = z.guid();

// Backlinks are decoration on the book and topic pages, like the recommendation shelf
// (getShelfRecommendations in lib/data/recommendations.ts): they sit below the content the page
// exists to show and already render nothing when empty. A failed read therefore degrades to no
// links instead of breaking every book and topic page (or aborting their prerender). The error is
// logged once by failure(), with a null request ID because these pages are static - see failure().
async function readBacklinks(
  operation: string,
  rpc: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<KnowledgeLinkSummary[]> {
  try {
    const { data, error } = await rpc();
    if (error) throw await failure(operation, error, null);
    const rows = await parse(operation, linkRowsSchema, data ?? [], null);
    return rows.map((row) => ({
      kind: row.kind,
      slug: row.slug,
      title: row.title,
      excerpt: row.excerpt,
      publishedAt: row.published_at,
    }));
  } catch (error) {
    // notFound(), redirect() and dynamic-rendering bailouts are control flow that Next.js throws
    // through this stack; swallowing one would break the page it was meant to steer.
    unstable_rethrow(error);
    return [];
  }
}

// Backlinks for a book page: ideas (by question) then articles (newest first), as the database
// orders them. Pass the id of a book the page has already resolved as public. Never rejects.
export const getKnowledgeForBook = cache(
  async (locale: Locale, bookId: string): Promise<KnowledgeLinkSummary[]> => {
    if (!idSchema.safeParse(bookId).success) return [];
    return readBacklinks("getKnowledgeForBook", () =>
      createPublicClient().rpc("knowledge_for_book", {
        p_locale: locale,
        p_book_id: bookId,
      }),
    );
  },
);

// Backlinks for a topic page, in the same order as getKnowledgeForBook. Never rejects.
export const getKnowledgeForTopic = cache(
  async (locale: Locale, topicId: string): Promise<KnowledgeLinkSummary[]> => {
    if (!idSchema.safeParse(topicId).success) return [];
    return readBacklinks("getKnowledgeForTopic", () =>
      createPublicClient().rpc("knowledge_for_topic", {
        p_locale: locale,
        p_topic_id: topicId,
      }),
    );
  },
);

// One published idea of `locale` by id, or null when it is unpublished or not localized. Built on the
// cached index, so it adds no query and reads no request state.
export async function getPublishedIdeaById(
  locale: Locale,
  ideaId: string,
): Promise<KnowledgeIdeaSummary | null> {
  return (await getPublishedIdeas(locale)).find((idea) => idea.ideaId === ideaId) ?? null;
}
