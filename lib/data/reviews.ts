import "server-only";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import type { ReviewInput } from "@/lib/reviews/schema";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// submit_book_review raises this when the caller has no active entitlement to the book.
const ENTITLEMENT_REQUIRED = "EB034";
// delete_book_review raises this when there is nothing to delete; deleting twice is not an error.
const NO_DATA_FOUND = "P0002";

// EB042: the reader holds several editions of the work and did not say which one they are reviewing.
const CHOOSE_EDITION = "EB042";

export class ChooseEditionToReviewError extends Error {
  constructor() {
    super("Choose which edition to review.");
    this.name = "ChooseEditionToReviewError";
  }
}

export class NotEntitledToReviewError extends Error {
  constructor() {
    super("An active entitlement is required to review this book.");
    this.name = "NotEntitledToReviewError";
  }
}

export type PublicReview = {
  id: string;
  reviewerName: string | null;
  rating: number;
  body: string;
  authorReply: string | null;
  authorReplyAt: string | null;
  publishedAt: string;
  // The edition the review is about, so a reader can tell which translation was judged.
  languageCode: string | null;
};

export type MyReview = {
  id: string;
  rating: number;
  body: string;
  status: "pending" | "published" | "rejected";
  authorReply: string | null;
  authorReplyAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

const publicReviewSchema = z.object({
  id: z.string(),
  reviewerName: z.string().nullable(),
  rating: z.number().int(),
  body: z.string(),
  authorReply: z.string().nullable(),
  authorReplyAt: z.string().nullable(),
  publishedAt: z.string(),
  languageCode: z.string().nullable().default(null),
});

const myReviewSchema = z.object({
  id: z.string(),
  rating: z.number().int(),
  body: z.string(),
  status: z.enum(["pending", "published", "rejected"]),
  authorReply: z.string().nullable(),
  authorReplyAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
});

// Same contract as lib/data/catalog.ts's failure(): callers see a generic message, the database
// detail is logged once. getBookReviews is reached by the prerendered book page, and reading
// headers() there would silently make the route dynamic, so it passes no request ID. The
// session-scoped functions below are request-only and pass the proxy's ID.
function failure(operation: string, cause: unknown, requestId: string | null = null): Error {
  console.error("Review read failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    message: (cause as { message?: string } | null)?.message ?? String(cause),
    requestId,
  });
  return new Error(`${operation} failed.`, { cause });
}

async function requestFailure(operation: string, cause: unknown): Promise<Error> {
  return failure(operation, cause, getRequestId(await headers()));
}

// Public, cookie-less read of the newest published reviews. An unparseable payload shows no
// reviews rather than failing the book page.
export const getBookReviews = cache(async (bookId: string, limit = 5): Promise<PublicReview[]> => {
  const { data, error } = await createPublicClient().rpc("catalog_book_reviews", {
    p_book_id: bookId,
    p_limit: limit,
  });
  if (error) throw failure("getBookReviews", error);
  const parsed = z.array(publicReviewSchema).safeParse(data ?? []);
  return parsed.success ? parsed.data : [];
});

export async function getMyBookReview(bookId: string, editionId?: string): Promise<MyReview | null> {
  const { data, error } = await (await createClient()).rpc("get_my_book_review", {
    p_book_id: bookId,
    ...(editionId ? { p_edition_id: editionId } : {}),
  });
  if (error?.code === CHOOSE_EDITION) throw new ChooseEditionToReviewError();
  if (error) throw await requestFailure("getMyBookReview", error);
  return data === null ? null : myReviewSchema.parse(data);
}

export async function submitBookReview(bookId: string, input: ReviewInput, locale: Locale, editionId?: string): Promise<MyReview> {
  const { data, error } = await (await createClient()).rpc("submit_book_review", {
    p_book_id: bookId,
    p_rating: input.rating,
    p_body: input.body,
    p_locale: locale,
    ...(editionId ? { p_edition_id: editionId } : {}),
  });
  if (error?.code === ENTITLEMENT_REQUIRED) throw new NotEntitledToReviewError();
  if (error?.code === CHOOSE_EDITION) throw new ChooseEditionToReviewError();
  if (error) throw await requestFailure("submitBookReview", error);
  return myReviewSchema.parse(data);
}

export async function deleteBookReview(bookId: string, editionId?: string): Promise<void> {
  const { error } = await (await createClient()).rpc("delete_book_review", {
    p_book_id: bookId,
    ...(editionId ? { p_edition_id: editionId } : {}),
  });
  if (error && error.code !== NO_DATA_FOUND) throw await requestFailure("deleteBookReview", error);
}
