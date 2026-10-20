import "server-only";
import type { Locale } from "@/lib/i18n/config";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import type {
  ArticleCreateInput,
  ArticleDetailsInput,
  ArticleLocalizationInput,
  ArticleRelationsInput,
  IdeaCreateInput,
  IdeaLocalizationInput,
  IdeaRelationsInput,
  KnowledgeSeoInput,
} from "@/lib/catalog/schemas";
import { knowledgeBlocksSchema, type KnowledgeBlock } from "@/lib/knowledge/blocks";
import {
  checkArticleReadiness,
  checkIdeaReadiness,
  parseArticleReadinessError,
  parseIdeaReadinessError,
  type ArticleReadinessIssueCode,
  type IdeaReadinessIssueCode,
} from "@/lib/knowledge/readiness";
import { createClient } from "@/lib/supabase/server";

// The admin read model and write path for S12 ideas and articles. Every function runs
// requireAdmin() before it builds a client. Reads go through the session client under the
// "admin reads …" policies (20260927100000); every write goes through one of the audited definer
// RPCs (20260927110000), because browser roles hold no write grant on these tables at all.

export type KnowledgeKind = "idea" | "article";
export type KnowledgeStatus = "draft" | "published" | "archived";

export class KnowledgeNotFoundError extends Error {
  constructor() {
    super("This entry no longer exists.");
    this.name = "KnowledgeNotFoundError";
  }
}

// A relation target or author named by the form is gone - a different fix from the entry itself
// being gone, so it is a different error.
export class KnowledgeReferenceNotFoundError extends Error {
  constructor() {
    super("A selected author, book, topic, or idea no longer exists. Reload and try again.");
    this.name = "KnowledgeReferenceNotFoundError";
  }
}

export class KnowledgeLocalizationMissingError extends Error {
  constructor() {
    super("Save this language's content before its SEO.");
    this.name = "KnowledgeLocalizationMissingError";
  }
}

export class DuplicateKnowledgeSlugError extends Error {
  constructor() {
    super("This slug is already used in this language.");
    this.name = "DuplicateKnowledgeSlugError";
  }
}

export class KnowledgeNotReadyError extends Error {
  readonly issues: (IdeaReadinessIssueCode | ArticleReadinessIssueCode)[];

  constructor(issues: (IdeaReadinessIssueCode | ArticleReadinessIssueCode)[]) {
    super("This entry is not ready to publish.");
    this.name = "KnowledgeNotReadyError";
    this.issues = issues;
  }
}

type DatabaseError = { code?: string; message: string };

// Raw database text never leaves this module. `entityId` separates "the entry is gone" from "a
// relation target or author is gone": both are P0002, but only the first names the entry's id.
// Postgres prints a uuid in lowercase while the id may arrive from the URL in any case, so both
// sides are compared lowercased.
function failure(operation: string, error: DatabaseError, entityId?: string): Error {
  if (error.code === "P0002") {
    if (/has no (vi|en) localization/.test(error.message)) return new KnowledgeLocalizationMissingError();
    if (entityId && error.message.toLowerCase().includes(entityId.toLowerCase())) return new KnowledgeNotFoundError();
    return new KnowledgeReferenceNotFoundError();
  }
  if (error.code === "23505" && /(idea|article)_localizations_locale_slug_key/.test(error.message)) {
    return new DuplicateKnowledgeSlugError();
  }
  return new Error(`${operation} failed.`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new KnowledgeNotFoundError();
}

type LocalizationBase = {
  id: string;
  locale: Locale;
  slug: string;
  // Parsed through knowledgeBlocksSchema. Stored rows were validated by the same schema on write,
  // so an unreadable array means the contract changed underneath it: the editor starts empty and
  // says so rather than handing over blocks it cannot represent.
  bodyBlocks: KnowledgeBlock[];
  storedBlocksReadable: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  updatedAt: string;
};

export type AdminIdeaLocalizationDTO = LocalizationBase & { question: string; shortAnswer: string };
export type AdminArticleLocalizationDTO = LocalizationBase & { title: string; excerpt: string };

export type AdminKnowledgeDTO =
  | {
      kind: "idea";
      id: string;
      status: KnowledgeStatus;
      localizations: AdminIdeaLocalizationDTO[];
      bookIds: string[];
      topicIds: string[];
      relatedIdeaIds: string[];
      readinessIssues: IdeaReadinessIssueCode[];
    }
  | {
      kind: "article";
      id: string;
      status: KnowledgeStatus;
      authorId: string;
      publishedAt: string | null;
      localizations: AdminArticleLocalizationDTO[];
      bookIds: string[];
      ideaIds: string[];
      topicIds: string[];
      readinessIssues: ArticleReadinessIssueCode[];
    };

export type AdminKnowledgeListItemDTO =
  | { kind: "idea"; id: string; title: string; status: KnowledgeStatus; locales: Locale[]; readinessIssues: IdeaReadinessIssueCode[] }
  | {
      kind: "article";
      id: string;
      title: string;
      status: KnowledgeStatus;
      locales: Locale[];
      readinessIssues: ArticleReadinessIssueCode[];
    };

type LocalizationRowBase = {
  id: string;
  locale: Locale;
  slug: string;
  body_blocks: unknown;
  seo_title: string | null;
  seo_description: string | null;
  updated_at: string;
};
type IdeaLocalizationRow = LocalizationRowBase & { question: string; short_answer: string };
type ArticleLocalizationRow = LocalizationRowBase & { title: string; excerpt: string };
type Ordered<Key extends string> = Record<Key, string> & { position: number };

type IdeaRow = {
  id: string;
  status: KnowledgeStatus;
  localizations: IdeaLocalizationRow[];
  // The embedded book status and locales feed missing_related_book: only a published, localized
  // book is visible on the public idea page.
  books: (Ordered<"book_id"> & { book: { status: string; localizations: { locale: string }[] } | null })[];
  topics: { topic_id: string }[];
  links: Ordered<"related_idea_id">[];
};

type ArticleRow = {
  id: string;
  status: KnowledgeStatus;
  author_id: string;
  published_at: string | null;
  localizations: ArticleLocalizationRow[];
  books: Ordered<"book_id">[];
  ideas: Ordered<"idea_id">[];
  topics: { topic_id: string }[];
};

const localizationColumns = "id, locale, slug, body_blocks, seo_title, seo_description, updated_at";

// idea_links references ideas twice (idea_id and related_idea_id), so its embed names the
// foreign key that points back at the parent row.
const ideaSelect = `
  id,
  status,
  localizations:idea_localizations ( ${localizationColumns}, question, short_answer ),
  books:idea_books ( book_id, position, book:books ( status, localizations:book_localizations ( locale ) ) ),
  topics:idea_topics ( topic_id ),
  links:idea_links!idea_links_idea_id_fkey ( related_idea_id, position )
`;

const articleSelect = `
  id,
  status,
  author_id,
  published_at,
  localizations:article_localizations ( ${localizationColumns}, title, excerpt ),
  books:article_books ( book_id, position ),
  ideas:article_ideas ( idea_id, position ),
  topics:article_topics ( topic_id )
`;

const localeOrder: Record<string, number> = { vi: 0, en: 1 };

function byLocale<Row extends { locale: string }>(rows: Row[] | null | undefined): Row[] {
  return [...(rows ?? [])].sort((a, b) => (localeOrder[a.locale] ?? 9) - (localeOrder[b.locale] ?? 9));
}

function inOrder<Key extends string>(rows: Ordered<Key>[] | null | undefined, key: Key): string[] {
  return [...(rows ?? [])].sort((a, b) => a.position - b.position).map((row) => row[key]);
}

// Readiness counts stored blocks the way publish_idea/publish_article do (jsonb_array_length), so
// the editor's verdict matches the database's gate even for a row this schema can no longer read.
function storedBlockCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function localizationBase(row: LocalizationRowBase): LocalizationBase {
  const parsed = knowledgeBlocksSchema.safeParse(row.body_blocks);
  return {
    id: row.id,
    locale: row.locale,
    slug: row.slug,
    bodyBlocks: parsed.success ? parsed.data : [],
    storedBlocksReadable: parsed.success,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    updatedAt: row.updated_at,
  };
}

function ideaReadiness(row: IdeaRow): IdeaReadinessIssueCode[] {
  return checkIdeaReadiness({
    localizations: (row.localizations ?? []).map((localization) => ({
      locale: localization.locale,
      slug: localization.slug,
      question: localization.question,
      shortAnswer: localization.short_answer,
      blockCount: storedBlockCount(localization.body_blocks),
    })),
    relatedBookLocales: (row.books ?? []).flatMap((book) =>
      book.book?.status === "published" ? book.book.localizations.map((localization) => localization.locale) : [],
    ),
  });
}

function articleReadiness(row: ArticleRow): ArticleReadinessIssueCode[] {
  return checkArticleReadiness({
    localizations: (row.localizations ?? []).map((localization) => ({
      slug: localization.slug,
      title: localization.title,
      excerpt: localization.excerpt,
      blockCount: storedBlockCount(localization.body_blocks),
    })),
  });
}

function toIdeaDto(row: IdeaRow): AdminKnowledgeDTO {
  return {
    kind: "idea",
    id: row.id,
    status: row.status,
    localizations: byLocale(row.localizations).map((localization) => ({
      ...localizationBase(localization),
      question: localization.question,
      shortAnswer: localization.short_answer,
    })),
    bookIds: inOrder(row.books, "book_id"),
    topicIds: (row.topics ?? []).map((topic) => topic.topic_id),
    relatedIdeaIds: inOrder(row.links, "related_idea_id"),
    readinessIssues: ideaReadiness(row),
  };
}

function toArticleDto(row: ArticleRow): AdminKnowledgeDTO {
  return {
    kind: "article",
    id: row.id,
    status: row.status,
    authorId: row.author_id,
    publishedAt: row.published_at,
    localizations: byLocale(row.localizations).map((localization) => ({
      ...localizationBase(localization),
      title: localization.title,
      excerpt: localization.excerpt,
    })),
    bookIds: inOrder(row.books, "book_id"),
    ideaIds: inOrder(row.ideas, "idea_id"),
    topicIds: (row.topics ?? []).map((topic) => topic.topic_id),
    readinessIssues: articleReadiness(row),
  };
}

// A stale admin link is a 404 page, not a server error - the same treatment getAdminBundle gives.
export async function getAdminKnowledge(kind: KnowledgeKind, id: string): Promise<AdminKnowledgeDTO> {
  await requireAdmin();
  if (!uuidPattern.test(id)) notFound();

  const supabase = await createClient();
  const { data, error } =
    kind === "idea"
      ? await supabase.from("ideas").select(ideaSelect).eq("id", id).maybeSingle()
      : await supabase.from("articles").select(articleSelect).eq("id", id).maybeSingle();

  if (error) throw failure("getAdminKnowledge", error);
  if (!data) notFound();

  return kind === "idea" ? toIdeaDto(data as unknown as IdeaRow) : toArticleDto(data as unknown as ArticleRow);
}

export async function listAdminKnowledge(kind: "idea"): Promise<Extract<AdminKnowledgeListItemDTO, { kind: "idea" }>[]>;
export async function listAdminKnowledge(kind: "article"): Promise<Extract<AdminKnowledgeListItemDTO, { kind: "article" }>[]>;
export async function listAdminKnowledge(kind: KnowledgeKind): Promise<AdminKnowledgeListItemDTO[]>;
export async function listAdminKnowledge(kind: KnowledgeKind): Promise<AdminKnowledgeListItemDTO[]> {
  await requireAdmin();

  const supabase = await createClient();
  if (kind === "idea") {
    const { data, error } = await supabase.from("ideas").select(ideaSelect).order("updated_at", { ascending: false });
    if (error) throw failure("listAdminKnowledge", error);
    return ((data ?? []) as unknown as IdeaRow[]).map((row) => {
      const localizations = byLocale(row.localizations);
      return {
        kind: "idea",
        id: row.id,
        title: localizations[0]?.question ?? row.id,
        status: row.status,
        locales: localizations.map((localization) => localization.locale),
        readinessIssues: ideaReadiness(row),
      };
    });
  }

  // Articles carry no updated_at; newest first by creation keeps drafts in view.
  const { data, error } = await supabase.from("articles").select(articleSelect).order("created_at", { ascending: false });
  if (error) throw failure("listAdminKnowledge", error);
  return ((data ?? []) as unknown as ArticleRow[]).map((row) => {
    const localizations = byLocale(row.localizations);
    return {
      kind: "article",
      id: row.id,
      title: localizations[0]?.title ?? row.id,
      status: row.status,
      locales: localizations.map((localization) => localization.locale),
      readinessIssues: articleReadiness(row),
    };
  });
}

function createdId(operation: string, data: unknown): { id: string } {
  if (typeof data !== "string" || data.length === 0) throw new Error(`${operation} returned no id.`);
  return { id: data };
}

export async function createIdea(input: IdeaCreateInput): Promise<{ id: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_idea", {
    p_locale: input.locale,
    p_slug: input.slug,
    p_question: input.question,
    p_short_answer: input.shortAnswer,
  });
  if (error) throw failure("createIdea", error);
  return createdId("createIdea", data);
}

export async function createArticle(input: ArticleCreateInput): Promise<{ id: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_article", {
    p_author_id: input.authorId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
    p_excerpt: input.excerpt,
  });
  if (error) throw failure("createArticle", error);
  return createdId("createArticle", data);
}

export async function updateArticleDetails(articleId: string, input: ArticleDetailsInput): Promise<void> {
  await requireAdmin();
  assertUuid(articleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_article", { p_article_id: articleId, p_author_id: input.authorId });
  if (error) throw failure("updateArticleDetails", error, articleId);
}

export async function saveIdeaLocalization(ideaId: string, input: IdeaLocalizationInput): Promise<void> {
  await requireAdmin();
  assertUuid(ideaId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_idea_localization", {
    p_idea_id: ideaId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_question: input.question,
    p_short_answer: input.shortAnswer,
    p_body_blocks: input.bodyBlocks,
  });
  if (error) throw failure("saveIdeaLocalization", error, ideaId);
}

export async function saveArticleLocalization(articleId: string, input: ArticleLocalizationInput): Promise<void> {
  await requireAdmin();
  assertUuid(articleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_article_localization", {
    p_article_id: articleId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
    p_excerpt: input.excerpt,
    p_body_blocks: input.bodyBlocks,
  });
  if (error) throw failure("saveArticleLocalization", error, articleId);
}

// The generated Args type marks these text parameters non-null, but the RPCs store
// nullif(trim(...), '') and a SQL null is the intended "no override" value.
export async function saveKnowledgeSeo(kind: KnowledgeKind, id: string, input: KnowledgeSeoInput): Promise<void> {
  await requireAdmin();
  assertUuid(id);

  const supabase = await createClient();
  const seo = { p_locale: input.locale, p_seo_title: input.seoTitle as string, p_seo_description: input.seoDescription as string };
  const { error } =
    kind === "idea"
      ? await supabase.rpc("admin_save_idea_seo", { p_idea_id: id, ...seo })
      : await supabase.rpc("admin_save_article_seo", { p_article_id: id, ...seo });
  if (error) throw failure("saveKnowledgeSeo", error, id);
}

// Each submitted list IS its order: the relation RPCs number books and ideas with `with ordinality`.
export async function setIdeaRelations(ideaId: string, input: IdeaRelationsInput): Promise<void> {
  await requireAdmin();
  assertUuid(ideaId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_idea_relations", {
    p_idea_id: ideaId,
    p_book_ids: input.bookIds,
    p_topic_ids: input.topicIds,
    p_related_idea_ids: input.relatedIdeaIds,
  });
  if (error) throw failure("setIdeaRelations", error, ideaId);
}

export async function setArticleRelations(articleId: string, input: ArticleRelationsInput): Promise<void> {
  await requireAdmin();
  assertUuid(articleId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_article_relations", {
    p_article_id: articleId,
    p_book_ids: input.bookIds,
    p_idea_ids: input.ideaIds,
    p_topic_ids: input.topicIds,
  });
  if (error) throw failure("setArticleRelations", error, articleId);
}

export async function publishKnowledge(kind: KnowledgeKind, id: string): Promise<void> {
  await requireAdmin();
  assertUuid(id);

  const supabase = await createClient();
  if (kind === "idea") {
    const { error } = await supabase.rpc("publish_idea", { p_idea_id: id });
    if (!error) return;
    if (error.code === "EB032") throw new KnowledgeNotReadyError(parseIdeaReadinessError(error.message) ?? []);
    throw failure("publishKnowledge", error, id);
  }

  const { error } = await supabase.rpc("publish_article", { p_article_id: id });
  if (!error) return;
  if (error.code === "EB033") throw new KnowledgeNotReadyError(parseArticleReadinessError(error.message) ?? []);
  throw failure("publishKnowledge", error, id);
}

export async function unpublishKnowledge(kind: KnowledgeKind, id: string): Promise<void> {
  await requireAdmin();
  assertUuid(id);

  const supabase = await createClient();
  const { error } =
    kind === "idea"
      ? await supabase.rpc("unpublish_idea", { p_idea_id: id })
      : await supabase.rpc("unpublish_article", { p_article_id: id });
  if (error) throw failure("unpublishKnowledge", error, id);
}
