import "server-only";
import { cache } from "react";

import { requireAdmin } from "@/lib/auth/admin";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminSummaryDTO = {
  bookCount: number;
  publicationCount: number;
  failedProcessingJobCount: number;
  userCount: number;
  activeEntitlementCount: number;
  pendingReviewCount: number;
  newQuestionCount: number;
};

// Fails loud rather than rendering a permission error, dropped column, or
// transient network failure as a healthy-looking zero - a wrong "0 failed
// processing jobs" is exactly the number an operator would misread as "the
// pipeline is fine". Task 8 owns how this surfaces in the UI.
function requireCount(label: string, result: { count: number | null; error: { message: string } | null }) {
  if (result.error) {
    throw new Error(`Failed to count ${label}: ${result.error.message}`);
  }
  return result.count ?? 0;
}

// Dashboard totals for admins only. `requireAdmin()` runs first so the
// service-role client - which bypasses the RLS that revoked SELECT on these
// tables for ordinary sessions - is never constructed for an unauthorized
// caller. Only counts are returned: no storage keys, audit payloads, or auth
// metadata.
export const getAdminSummary = cache(async (): Promise<AdminSummaryDTO> => {
  await requireAdmin();

  const supabase = createAdminClient();
  const [books, publications, failedProcessingJobs, users, activeEntitlements, pendingReviews, newQuestions] = await Promise.all([
    supabase.from("books").select("*", { count: "exact", head: true }),
    supabase.from("ebook_publications").select("*", { count: "exact", head: true }),
    supabase
      .from("processing_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "failed"),
    supabase.from("profiles").select("*", { count: "exact", head: true }),
    supabase
      .from("entitlements")
      .select("*", { count: "exact", head: true })
      .eq("status", "active"),
    supabase.from("book_reviews").select("*", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("reader_questions").select("*", { count: "exact", head: true }).eq("status", "new"),
  ]);

  return {
    bookCount: requireCount("books", books),
    publicationCount: requireCount("publications", publications),
    failedProcessingJobCount: requireCount("failed processing jobs", failedProcessingJobs),
    userCount: requireCount("users", users),
    activeEntitlementCount: requireCount("active entitlements", activeEntitlements),
    pendingReviewCount: requireCount("pending reviews", pendingReviews),
    newQuestionCount: requireCount("new questions", newQuestions),
  };
});
