import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import type { IdeaCreateInput } from "@/lib/catalog/schemas";
import { DuplicateKnowledgeSlugError } from "@/lib/data/admin-knowledge";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// S13 reader-question inbox. Every function runs requireAdmin() first and talks to the database as
// the admin's own session: the admin_* RPCs re-check is_admin() themselves (a non-admin gets null
// from the list and 42501 from the writes), so no service-role client is involved.

export type AdminQuestionStatus = "new" | "answered" | "archived";

// Book and idea foreign keys are on delete set null, so every target field can be null.
const adminQuestionSchema = z.object({
  id: z.string(),
  body: z.string(),
  locale: z.string(),
  status: z.enum(["new", "answered", "archived"]),
  createdAt: z.string(),
  askerName: z.string().nullable(),
  bookId: z.string().nullable(),
  bookTitle: z.string().nullable(),
  ideaId: z.string().nullable(),
  ideaQuestion: z.string().nullable(),
  answerIdeaId: z.string().nullable(),
});
export type AdminQuestionDTO = z.infer<typeof adminQuestionSchema>;

// The question (or the idea it is being linked to) is gone, or the question is no longer in a state
// that allows the change. Safe to show: it carries no database text.
export class QuestionUnavailableError extends Error {
  constructor() {
    super("This question can no longer be answered.");
    this.name = "QuestionUnavailableError";
  }
}

export class AnswerDeliveryInProgressError extends Error {
  constructor() {
    super("The answer email is being delivered. Try again after delivery finishes.");
    this.name = "AnswerDeliveryInProgressError";
  }
}

type DatabaseError = { code?: string; message?: string };

// Callers see a generic message; the database detail is logged once with the request ID.
async function failure(operation: string, cause: DatabaseError): Promise<Error> {
  if (cause.code === "EB037") return new AnswerDeliveryInProgressError();
  if (cause.code === "P0002") return new QuestionUnavailableError();
  if (cause.code === "23505" && /idea_localizations_locale_slug_key/.test(cause.message ?? "")) {
    return new DuplicateKnowledgeSlugError();
  }
  console.error("Question admin operation failed.", {
    operation,
    code: cause.code ?? null,
    message: cause.message ?? String(cause),
    requestId: getRequestId(await headers()),
  });
  return new Error(`${operation} failed.`, { cause });
}

export async function listAdminQuestions(status: AdminQuestionStatus): Promise<AdminQuestionDTO[]> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_list_questions", { p_status: status });
  if (error) throw await failure("listAdminQuestions", error);
  return z.array(adminQuestionSchema).parse(data ?? []);
}

export async function archiveQuestion(questionId: string): Promise<void> {
  await requireAdmin();
  const { error } = await (await createClient()).rpc("admin_archive_question", { p_question_id: questionId });
  if (error) throw await failure("archiveQuestion", error);
}

export async function answerQuestion(questionId: string, ideaId: string): Promise<void> {
  await requireAdmin();
  const { error } = await (await createClient()).rpc("admin_answer_question", {
    p_question_id: questionId,
    p_idea_id: ideaId,
  });
  if (error) throw await failure("answerQuestion", error);
}

export async function answerQuestionWithIdea(questionId: string, input: IdeaCreateInput): Promise<{ ideaId: string }> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_answer_question_with_idea", {
    p_question_id: questionId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_question: input.question,
    p_short_answer: input.shortAnswer,
  });
  if (error) throw await failure("answerQuestionWithIdea", error);
  if (typeof data !== "string" || data.length === 0) throw new Error("answerQuestionWithIdea returned no id.");
  return { ideaId: data };
}
