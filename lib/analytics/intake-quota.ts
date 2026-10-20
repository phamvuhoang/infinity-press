import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

// Durable, cross-instance quota for POST /api/analytics/events, backed by
// public.consume_analytics_quota (supabase/migrations/20260916140000_s5_analytics_intake_quota.sql).
// It is consumed before the service-role insert, so no caller can grow analytics_events faster than
// these limits allow, however many fresh event IDs it mints. Change a limit here and redeploy; the
// database function takes the limit per call, so no migration is needed.
export const INTAKE_WINDOW_SECONDS = 60;
// One signed-in person: page views, reader opens, and setting changes are a few events a minute
// even for an active reader. Sixty leaves ample headroom and caps one account at 86,400 rows a day.
export const PROFILE_INTAKE_LIMIT = 60;
// Every anonymous visitor shares this bucket (only view_book, open_sample, click_external_store, and view_quote are anonymous). Six
// hundred a minute is ten book views a second - far above launch traffic - and caps anonymous rows
// at 864,000 a day. Raise it when real traffic approaches it; see docs/runbooks/seo-and-operations.md.
export const ANONYMOUS_INTAKE_LIMIT = 600;

export type QuotaResult = "allowed" | "limited" | { error: string };

// Never throws. An error result carries the Postgres or PostgREST code only: a message can quote
// values, and the caller logs this.
export async function consumeAnalyticsQuota(profileId: string | undefined): Promise<QuotaResult> {
  try {
    const { data, error } = await createAdminClient().rpc("consume_analytics_quota", {
      p_bucket_key: profileId ? `profile/${profileId}` : "anonymous",
      p_limit: profileId ? PROFILE_INTAKE_LIMIT : ANONYMOUS_INTAKE_LIMIT,
      p_window_seconds: INTAKE_WINDOW_SECONDS,
    });
    if (error) return { error: error.code || "unknown" };
    return data === true ? "allowed" : "limited";
  } catch {
    return { error: "exception" };
  }
}
