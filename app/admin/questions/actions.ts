"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readText, type AdminFormState } from "@/lib/catalog/form";
import { revalidateKnowledgeHub } from "@/lib/catalog/revalidate";
import { ideaCreateSchema } from "@/lib/catalog/schemas";
import { DuplicateKnowledgeSlugError } from "@/lib/data/admin-knowledge";
import { AnswerDeliveryInProgressError, answerQuestion, answerQuestionWithIdea, archiveQuestion, QuestionUnavailableError } from "@/lib/data/admin-questions";

// Reader-question inbox. A Server Action is a public endpoint: each one gates on requireAdmin()
// itself, and the bound question id is validated like a posted value (the RPCs re-check the admin
// role and the question's state). Raw database text never reaches the form.

const NEXT = "/admin/questions";
const genericFailure = "Something went wrong saving. Try again.";
const idSchema = z.uuid();
const linkSchema = z.object({ ideaId: z.uuid({ error: "Choose an idea." }) });

const failed = (formError: string): AdminFormState => ({ fieldErrors: {}, formError, savedAt: null });

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateKnowledgeSlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
  if (error instanceof QuestionUnavailableError || error instanceof AnswerDeliveryInProgressError) return failed(error.message);
  return failed(genericFailure);
}

export async function archiveQuestionAction(
  questionId: string,
  // The plain form action receives the (empty) FormData last; nothing in it is read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<void> {
  await requireAdmin({ next: NEXT });
  await archiveQuestion(idSchema.parse(questionId));
  revalidatePath(NEXT);
}

export async function answerQuestionAction(
  questionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: NEXT });
  const id = idSchema.safeParse(questionId);
  const parsed = linkSchema.safeParse({ ideaId: readText(formData, "ideaId") });
  if (!id.success) return failed(genericFailure);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await answerQuestion(id.data, parsed.data.ideaId);
  } catch (error) {
    return knownFailure(error);
  }
  revalidatePath(NEXT);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function answerWithIdeaAction(
  questionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: NEXT });
  const id = idSchema.safeParse(questionId);
  const parsed = ideaCreateSchema.safeParse({
    locale: readText(formData, "locale"),
    slug: readText(formData, "slug"),
    question: readText(formData, "question"),
    shortAnswer: readText(formData, "shortAnswer"),
  });
  if (!id.success) return failed(genericFailure);
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  let ideaId: string;
  try {
    ({ ideaId } = await answerQuestionWithIdea(id.data, parsed.data));
  } catch (error) {
    return knownFailure(error);
  }

  revalidateKnowledgeHub("idea", ideaId);
  revalidatePath(NEXT);
  redirect(`/admin/ideas/${ideaId}`);
}
