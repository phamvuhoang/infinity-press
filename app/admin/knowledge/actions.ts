"use server";

import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readList, readOptionalText, readText, type AdminFormState, type FieldErrors } from "@/lib/catalog/form";
import { revalidateKnowledgeHub } from "@/lib/catalog/revalidate";
import {
  articleCreateSchema,
  articleDetailsSchema,
  articleLocalizationSchema,
  articleRelationsSchema,
  ideaCreateSchema,
  ideaLocalizationSchema,
  ideaRelationsSchema,
  knowledgeSeoSchema,
} from "@/lib/catalog/schemas";
import {
  createArticle,
  createIdea,
  DuplicateKnowledgeSlugError,
  KnowledgeLocalizationMissingError,
  KnowledgeNotFoundError,
  KnowledgeNotReadyError,
  KnowledgeReferenceNotFoundError,
  publishKnowledge,
  saveArticleLocalization,
  saveIdeaLocalization,
  saveKnowledgeSeo,
  setArticleRelations,
  setIdeaRelations,
  unpublishKnowledge,
  updateArticleDetails,
  type KnowledgeKind,
} from "@/lib/data/admin-knowledge";
import type { KnowledgeBlock } from "@/lib/knowledge/blocks";
import type { ArticleReadinessIssueCode, IdeaReadinessIssueCode } from "@/lib/knowledge/readiness";

// The S12 idea and article editors. Each action gates on requireAdmin() for its own editor before
// it parses anything, validates every posted value with a schema from lib/catalog/schemas.ts,
// never returns raw database text, and revalidates the knowledge hub only after a successful write.
// Bound arguments (kind, id, locale) come from the server-rendered page, but a Server Action is a
// public endpoint, so they are validated like everything else. Every runtime export of a
// "use server" module must be an async function; initial form state lives in lib/catalog/form.ts.

type Locale = "vi" | "en";

const genericFailure = "Something went wrong saving. Try again.";
const genericPublishFailure = "Something went wrong. Try again.";

const isKind = (kind: unknown): kind is KnowledgeKind => kind === "idea" || kind === "article";
const listPath = (kind: KnowledgeKind) => (kind === "article" ? "/admin/articles" : "/admin/ideas");
const editorPath = (kind: KnowledgeKind, id: string) => `${listPath(kind)}/${id}`;

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const invalid = (error: Parameters<typeof fieldErrorsFrom>[0]): AdminFormState => ({
  fieldErrors: fieldErrorsFrom(error),
  formError: null,
  savedAt: null,
});
const formError = (message: string): AdminFormState => ({ fieldErrors: {}, formError: message, savedAt: null });

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateKnowledgeSlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
  if (
    error instanceof KnowledgeNotFoundError ||
    error instanceof KnowledgeReferenceNotFoundError ||
    error instanceof KnowledgeLocalizationMissingError
  ) {
    return formError(error.message);
  }
  return formError(genericFailure);
}

// Creating an idea or article is creating its first localization; the editor does the rest.
export async function createIdeaAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/ideas/new" });

  const parsed = ideaCreateSchema.safeParse({
    locale: readText(formData, "locale"),
    slug: readText(formData, "slug"),
    question: readText(formData, "question"),
    shortAnswer: readText(formData, "shortAnswer"),
  });
  if (!parsed.success) return invalid(parsed.error);

  let id: string;
  try {
    ({ id } = await createIdea(parsed.data));
  } catch (error) {
    return knownFailure(error);
  }

  revalidateKnowledgeHub("idea", id);
  redirect(editorPath("idea", id));
}

export async function createArticleAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/articles/new" });

  const parsed = articleCreateSchema.safeParse({
    authorId: readText(formData, "authorId"),
    locale: readText(formData, "locale"),
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
    excerpt: readText(formData, "excerpt"),
  });
  if (!parsed.success) return invalid(parsed.error);

  let id: string;
  try {
    ({ id } = await createArticle(parsed.data));
  } catch (error) {
    // The only reference a create names is the author.
    if (error instanceof KnowledgeReferenceNotFoundError) {
      return { fieldErrors: { authorId: "This author no longer exists. Choose another." }, formError: null, savedAt: null };
    }
    return knownFailure(error);
  }

  revalidateKnowledgeHub("article", id);
  redirect(editorPath("article", id));
}

export async function updateArticleDetailsAction(
  articleId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath("article", articleId) });

  const parsed = articleDetailsSchema.safeParse({ authorId: readText(formData, "authorId") });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateArticleDetails(articleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub("article", articleId);
  return saved();
}

// knowledgeBlocksSchema only checks that an image key has the minted shape. The key must also belong
// to the entity being edited - knowledge/{ideas|articles}/{thisEntityId}/ - so a crafted post cannot
// point this entry at an image uploaded for another idea or article. Ids are compared lowercased:
// the minted keys are, and the bound id may arrive in either case.
const foreignImageMessage = "Upload the image through this editor.";

function foreignImageErrors(kind: KnowledgeKind, entityId: string, blocks: KnowledgeBlock[]): FieldErrors | null {
  const prefix = `knowledge/${kind === "article" ? "articles" : "ideas"}/${entityId.toLowerCase()}/`;
  const errors: FieldErrors = {};
  blocks.forEach((block, index) => {
    if (block.type === "image" && !block.storageKey.startsWith(prefix)) {
      errors[`bodyBlocks.${index}.storageKey`] = foreignImageMessage;
    }
  });
  return Object.keys(errors).length > 0 ? errors : null;
}

const imageFailure = (fieldErrors: FieldErrors): AdminFormState => ({ fieldErrors, formError: null, savedAt: null });

// The locale is bound by the server-rendered form: which localization a form edits is not the
// submitter's to choose. bodyBlocks is the editor's hidden JSON field.
export async function saveIdeaLocalizationAction(
  ideaId: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath("idea", ideaId) });

  const parsed = ideaLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    question: readText(formData, "question"),
    shortAnswer: readText(formData, "shortAnswer"),
    bodyBlocks: readText(formData, "bodyBlocks"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const ideaImageErrors = foreignImageErrors("idea", ideaId, parsed.data.bodyBlocks);
  if (ideaImageErrors) return imageFailure(ideaImageErrors);

  try {
    await saveIdeaLocalization(ideaId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub("idea", ideaId);
  return saved();
}

export async function saveArticleLocalizationAction(
  articleId: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath("article", articleId) });

  const parsed = articleLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
    excerpt: readText(formData, "excerpt"),
    bodyBlocks: readText(formData, "bodyBlocks"),
  });
  if (!parsed.success) return invalid(parsed.error);
  const articleImageErrors = foreignImageErrors("article", articleId, parsed.data.bodyBlocks);
  if (articleImageErrors) return imageFailure(articleImageErrors);

  try {
    await saveArticleLocalization(articleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub("article", articleId);
  return saved();
}

export async function saveKnowledgeSeoAction(
  kind: KnowledgeKind,
  id: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath(isKind(kind) ? kind : "idea", id) });
  if (!isKind(kind)) return formError(genericFailure);

  const parsed = knowledgeSeoSchema.safeParse({
    locale,
    seoTitle: readOptionalText(formData, "seoTitle"),
    seoDescription: readOptionalText(formData, "seoDescription"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveKnowledgeSeo(kind, id, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub(kind, id);
  return saved();
}

// Books and related ideas post in their editorial order; the relation RPC numbers each list.
export async function setIdeaRelationsAction(
  ideaId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath("idea", ideaId) });

  const parsed = ideaRelationsSchema.safeParse({
    bookIds: readList(formData, "bookIds"),
    topicIds: readList(formData, "topicIds"),
    relatedIdeaIds: readList(formData, "relatedIdeaIds"),
  });
  if (!parsed.success) return invalid(parsed.error);
  // admin_set_idea_relations refuses a self-link too; saying it here puts it on the right field.
  if (parsed.data.relatedIdeaIds.includes(ideaId)) {
    return { fieldErrors: { relatedIdeaIds: "An idea cannot relate to itself." }, formError: null, savedAt: null };
  }

  try {
    await setIdeaRelations(ideaId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub("idea", ideaId);
  return saved();
}

export async function setArticleRelationsAction(
  articleId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: editorPath("article", articleId) });

  const parsed = articleRelationsSchema.safeParse({
    bookIds: readList(formData, "bookIds"),
    ideaIds: readList(formData, "ideaIds"),
    topicIds: readList(formData, "topicIds"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setArticleRelations(articleId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateKnowledgeHub("article", articleId);
  return saved();
}

export type KnowledgePublishActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; issues: (IdeaReadinessIssueCode | ArticleReadinessIssueCode)[] };

const noun = (kind: KnowledgeKind) => (kind === "idea" ? "Idea" : "Article");

export async function publishKnowledgeAction(kind: KnowledgeKind, id: string): Promise<KnowledgePublishActionResult> {
  await requireAdmin({ next: editorPath(isKind(kind) ? kind : "idea", id) });
  if (!isKind(kind)) return { ok: false, error: genericPublishFailure, issues: [] };

  try {
    await publishKnowledge(kind, id);
  } catch (error) {
    // The database is the gate; the editor's own verdict is only a preview of it.
    if (error instanceof KnowledgeNotReadyError) return { ok: false, error: error.message, issues: error.issues };
    if (error instanceof KnowledgeNotFoundError) return { ok: false, error: error.message, issues: [] };
    return { ok: false, error: genericPublishFailure, issues: [] };
  }
  revalidateKnowledgeHub(kind, id);
  return { ok: true, message: `${noun(kind)} published.` };
}

export async function unpublishKnowledgeAction(kind: KnowledgeKind, id: string): Promise<KnowledgePublishActionResult> {
  await requireAdmin({ next: editorPath(isKind(kind) ? kind : "idea", id) });
  if (!isKind(kind)) return { ok: false, error: genericPublishFailure, issues: [] };

  try {
    await unpublishKnowledge(kind, id);
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError) return { ok: false, error: error.message, issues: [] };
    return { ok: false, error: genericPublishFailure, issues: [] };
  }
  revalidateKnowledgeHub(kind, id);
  return { ok: true, message: `${noun(kind)} unpublished.` };
}
