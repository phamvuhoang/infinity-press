"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readOptionalText, type AdminFormState } from "@/lib/catalog/form";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { moderateReview, replyReview, StaleReviewError, type AdminReviewStatus } from "@/lib/data/admin-reviews";
import { plainText } from "@/lib/reviews/schema";

// Review moderation. A Server Action is a public endpoint: each one gates on requireAdmin() itself,
// and the bound review id and status are validated like posted values (the RPCs re-check both and
// the admin role). A blank reply posts as null, which clears the reply.

const statusSchema = z.enum(["pending", "published", "rejected"]);
const replySchema = z.object({ reply: plainText(0, 1000, "a reply").nullable() });

function refresh() {
  revalidateStorefront();
  revalidatePath("/admin/reviews");
}

export async function moderateReviewAction(
  reviewId: string,
  status: AdminReviewStatus,
  revision: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _previous: AdminFormState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/reviews" });
  const parsedStatus = statusSchema.safeParse(status);
  const parsedRevision = z.number().int().positive().safeParse(revision);
  if (!parsedStatus.success || !parsedRevision.success) {
    return { fieldErrors: {}, formError: "Reload the review before moderating it.", savedAt: null };
  }
  try {
    await moderateReview(reviewId, parsedStatus.data, parsedRevision.data);
  } catch (error) {
    if (error instanceof StaleReviewError) {
      revalidatePath("/admin/reviews");
      return { fieldErrors: {}, formError: error.message, savedAt: null };
    }
    return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
  }
  refresh();
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function replyReviewAction(
  reviewId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/reviews" });
  const parsed = replySchema.safeParse({ reply: readOptionalText(formData, "reply") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };
  try {
    await replyReview(reviewId, parsed.data.reply);
  } catch {
    return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
  }
  refresh();
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
