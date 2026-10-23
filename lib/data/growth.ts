import "server-only";

import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import { adminTitle } from "@/lib/data/admin-journeys";
import { getRequestId } from "@/lib/observability/request-id";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type Fn<Name extends keyof Database["public"]["Functions"]> = Database["public"]["Functions"][Name]["Returns"];

// S20 growth report for /admin/growth. The admin_growth_* functions check is_admin() against the
// caller's session, so this uses the admin's session client (never the service role, whose
// auth.uid() is null). Counts stay raw integers with their denominators; the page shows them as
// "n / d" and adds a percentage only when the denominator is above 0.

export const GROWTH_WINDOWS = [30, 90] as const;
export type GrowthDays = (typeof GROWTH_WINDOWS)[number];

export type GrowthFunnelRow = {
  bookId: string;
  bookTitle: string;
  openSample: number;
  openReader: number;
  sessionCompletedReaders: number;
  journeyCompleted: number;
};
export type GrowthRetentionRow = { cohortDay: string; activated: number; returnedD7: number; rate: string | null };
export type GrowthShare = { shared: number; opened: number; continued: number };
export type GrowthReport = { funnel: GrowthFunnelRow[]; retention: GrowthRetentionRow[]; share: GrowthShare };

// A whole-percent string, or null when there is nothing to divide by.
export function ratio(numerator: number, denominator: number): string | null {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : null;
}

async function failure(operation: string, error: { code?: string | null }): Promise<Error> {
  let requestId: string | null = null;
  try {
    requestId = getRequestId(await headers());
  } catch {
    // Outside a request scope there is no request ID.
  }
  console.error("Growth report query failed.", { operation, code: error.code ?? null, requestId });
  return new Error(`${operation} failed.`, { cause: error });
}

export async function getGrowthReport(days: GrowthDays): Promise<GrowthReport> {
  await requireAdmin();
  const supabase = await createClient();
  const [funnel, retention, share] = await Promise.all([
    supabase.rpc("admin_growth_funnel", { p_days: days }),
    supabase.rpc("admin_growth_retention", { p_days: days }),
    supabase.rpc("admin_growth_share", { p_days: days }),
  ]);
  if (funnel.error) throw await failure("admin_growth_funnel", funnel.error);
  if (retention.error) throw await failure("admin_growth_retention", retention.error);
  if (share.error) throw await failure("admin_growth_share", share.error);

  const funnelRows = (funnel.data ?? []) as unknown as Fn<"admin_growth_funnel">;
  const retentionRows = (retention.data ?? []) as unknown as Fn<"admin_growth_retention">;
  const shareRow = ((share.data ?? []) as unknown as Fn<"admin_growth_share">)[0];

  const bookIds = funnelRows.map((row) => row.book_id);
  const titles = new Map<string, { locale: string; title: string }[]>();
  if (bookIds.length > 0) {
    const { data, error } = await supabase.from("book_localizations").select("book_id, locale, title").in("book_id", bookIds);
    if (error) throw await failure("book_localizations", error);
    for (const row of data ?? []) titles.set(row.book_id, [...(titles.get(row.book_id) ?? []), row]);
  }

  return {
    funnel: funnelRows.map((row) => ({
      bookId: row.book_id,
      bookTitle: adminTitle(titles.get(row.book_id) ?? [], "en") ?? row.book_id,
      openSample: Number(row.open_sample),
      openReader: Number(row.open_reader),
      sessionCompletedReaders: Number(row.session_completed_readers),
      journeyCompleted: Number(row.journey_completed),
    })),
    retention: retentionRows.map((row) => ({
      cohortDay: row.cohort_day,
      activated: Number(row.activated),
      returnedD7: Number(row.returned_d7),
      rate: ratio(Number(row.returned_d7), Number(row.activated)),
    })),
    share: {
      shared: Number(shareRow?.shared ?? 0),
      opened: Number(shareRow?.opened ?? 0),
      continued: Number(shareRow?.continued ?? 0),
    },
  };
}
