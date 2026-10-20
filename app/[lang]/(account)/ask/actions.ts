"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/session";
import { type AdminFormState as AskFormState, fieldErrorsFrom, readOptionalText, readText } from "@/lib/catalog/form";
import { QuestionTargetNotFoundError, submitReaderQuestion, TooManyOpenQuestionsError } from "@/lib/data/questions";
import type { Locale } from "@/lib/i18n/config";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { questionInputSchema } from "@/lib/questions/schema";

// Customer-facing alias: `formError` is a KEY ("too_many" | "target_missing" | "failed") that the
// form maps to dictionary copy, never English text.
export type { AskFormState };

export async function submitReaderQuestionAction(
  locale: Locale,
  _previous: AskFormState,
  formData: FormData,
): Promise<AskFormState> {
  const bookId = readOptionalText(formData, "bookId") ?? undefined;
  const ideaId = readOptionalText(formData, "ideaId") ?? undefined;
  const routes = getCatalogRoutes(locale);
  const askPath = bookId ? routes.ask({ book: bookId }) : ideaId ? routes.ask({ idea: ideaId }) : null;
  await requireUser(locale, askPath ?? getLocaleRoutes(locale).library);
  const parsed = questionInputSchema.safeParse({ body: readText(formData, "body"), bookId, ideaId });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await submitReaderQuestion(parsed.data, locale);
  } catch (error) {
    if (error instanceof TooManyOpenQuestionsError) return { fieldErrors: {}, formError: "too_many", savedAt: null };
    if (error instanceof QuestionTargetNotFoundError) return { fieldErrors: {}, formError: "target_missing", savedAt: null };
    return { fieldErrors: {}, formError: "failed", savedAt: null };
  }
  // Revalidate the page path, not the query: the list of the reader's questions is the same for
  // every target.
  const { bookId: sentBookId, ideaId: sentIdeaId } = parsed.data;
  revalidatePath((sentBookId !== undefined ? routes.ask({ book: sentBookId }) : routes.ask({ idea: sentIdeaId ?? "" })).split("?")[0]);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
