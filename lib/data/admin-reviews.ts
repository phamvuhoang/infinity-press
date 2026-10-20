import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// S13 review moderation. Every function runs requireAdmin() first and talks to the database as the
// admin's own session: the admin_* RPCs re-check is_admin() themselves (a non-admin gets null from
// the list and 42501 from the writes), so no service-role client is involved.

export type AdminReviewStatus = "pending" | "published" | "rejected";

const adminReviewSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  bookId: z.string(),
  bookTitle: z.string(),
  reviewerName: z.string().nullable(),
  rating: z.number().int(),
  body: z.string(),
  locale: z.string(),
  status: z.enum(["pending", "published", "rejected"]),
  authorReply: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
  // max(sent_at) over the review's review_replied outbox rows; null until the first delivery.
  replyEmailedAt: z.string().nullable(),
});
export type AdminReviewDTO = z.infer<typeof adminReviewSchema>;

export class StaleReviewError extends Error {
  constructor() {
    super("This review changed. Read the refreshed review before moderating it.");
    this.name = "StaleReviewError";
  }
}

// Callers see a generic message; the database detail is logged once with the request ID.
async function failure(operation: string, cause: unknown): Promise<Error> {
  console.error("Review admin operation failed.", {
    operation,
    code: (cause as { code?: string } | null)?.code ?? null,
    message: (cause as { message?: string } | null)?.message ?? String(cause),
    requestId: getRequestId(await headers()),
  });
  return new Error(`${operation} failed.`, { cause });
}

export async function listAdminReviews(status: AdminReviewStatus): Promise<AdminReviewDTO[]> {
  await requireAdmin();
  const { data, error } = await (await createClient()).rpc("admin_list_reviews", { p_status: status });
  if (error) throw await failure("listAdminReviews", error);
  return z.array(adminReviewSchema).parse(data ?? []);
}

export async function moderateReview(reviewId: string, status: AdminReviewStatus, revision: number): Promise<void> {
  await requireAdmin();
  const { error } = await (await createClient()).rpc("admin_moderate_review", {
    p_review_id: reviewId,
    p_status: status,
    p_expected_revision: revision,
  });
  if (error?.code === "EB036") throw new StaleReviewError();
  if (error) throw await failure("moderateReview", error);
}

// A null reply clears the author reply.
export async function replyReview(reviewId: string, reply: string | null): Promise<void> {
  await requireAdmin();
  const { error } = await (await createClient()).rpc("admin_reply_review", {
    p_review_id: reviewId,
    // The RPC treats blank and null alike; the generated type just has no nullable arg.
    p_reply: reply ?? "",
  });
  if (error) throw await failure("replyReview", error);
}
