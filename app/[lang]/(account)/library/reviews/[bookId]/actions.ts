"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { type AdminFormState as ReviewFormState, fieldErrorsFrom, readText } from "@/lib/catalog/form";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { deleteBookReview, NotEntitledToReviewError, submitBookReview } from "@/lib/data/reviews";
import type { Locale } from "@/lib/i18n/config";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { reviewInputSchema } from "@/lib/reviews/schema";

// Customer-facing alias: the form state shape is shared with the admin forms, but `formError` here
// is a KEY ("not_entitled" | "failed") that the form maps to dictionary copy, never English text.
export type { ReviewFormState };

export async function submitBookReviewAction(
  locale: Locale,
  bookId: string,
  _previous: ReviewFormState,
  formData: FormData,
): Promise<ReviewFormState> {
  await requireUser(locale, getCatalogRoutes(locale).review(bookId));
  const parsed = reviewInputSchema.safeParse({ rating: readText(formData, "rating"), body: readText(formData, "body") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await submitBookReview(bookId, parsed.data, locale);
  } catch (error) {
    if (error instanceof NotEntitledToReviewError) return { fieldErrors: {}, formError: "not_entitled", savedAt: null };
    return { fieldErrors: {}, formError: "failed", savedAt: null };
  }
  revalidateStorefront();
  revalidatePath(getCatalogRoutes(locale).review(bookId));
  revalidatePath(getLocaleRoutes(locale).library);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function deleteBookReviewAction(locale: Locale, bookId: string): Promise<void> {
  await requireUser(locale, getCatalogRoutes(locale).review(bookId));
  await deleteBookReview(bookId);
  revalidateStorefront();
  revalidatePath(getCatalogRoutes(locale).review(bookId));
  redirect(getLocaleRoutes(locale).library);
}
