import "server-only";
import { headers } from "next/headers";

import type { AnalyticsDeviceClass, Retailer } from "@/lib/analytics/browser";
import { getRequestId } from "@/lib/observability/request-id";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesInsert } from "@/lib/supabase/database.types";

// The events the application writes itself (S5 spec 8.1). The progress milestones, book_published,
// and the three EPUB job events are deliberately absent: database triggers write those inside the
// transaction that makes them true, so no application path can record them - or forget to.
export const analyticsEventNames = [
  "view_book",
  "open_sample",
  "begin_checkout",
  "purchase",
  "payment_failed",
  "open_reader",
  "click_external_store",
  "change_reader_setting",
  "view_library",
  "share_quote",
  "view_quote",
] as const;

export type AnalyticsEventName = (typeof analyticsEventNames)[number];

// Identifier columns only. The table has no column for a title, slug, search text, locator, email,
// IP address, or user agent, and this type offers no way to reach one.
export type TrackEventInput = {
  eventName: AnalyticsEventName;
  dedupeKey?: string;
  profileId?: string;
  bookId?: string;
  orderId?: string;
  publicationId?: string;
  sharedQuoteId?: string;
  retailer?: Retailer;
  locale?: "vi" | "en";
  deviceClass?: AnalyticsDeviceClass;
};

// Postgres unique_violation: the partial unique index on dedupe_key refused a second row for the
// same key, which means the event is already recorded. That is the success case for a replay.
const DUPLICATE_KEY = "23505";

function toRow(input: TrackEventInput): TablesInsert<"analytics_events"> {
  const row: TablesInsert<"analytics_events"> = { event_name: input.eventName };
  if (input.dedupeKey !== undefined) row.dedupe_key = input.dedupeKey;
  if (input.profileId !== undefined) row.profile_id = input.profileId;
  if (input.bookId !== undefined) row.book_id = input.bookId;
  if (input.orderId !== undefined) row.order_id = input.orderId;
  if (input.publicationId !== undefined) row.publication_id = input.publicationId;
  if (input.sharedQuoteId !== undefined) row.shared_quote_id = input.sharedQuoteId;
  if (input.retailer !== undefined) row.retailer = input.retailer;
  if (input.locale !== undefined) row.locale = input.locale;
  if (input.deviceClass !== undefined) row.device_class = input.deviceClass;
  return row;
}

async function resolveLogRequestId(requestId: string | undefined): Promise<string> {
  if (requestId) return requestId;
  try {
    return getRequestId(await headers());
  } catch {
    // Outside a request scope there are no headers to read; a fresh ID still correlates the log.
    return crypto.randomUUID();
  }
}

// Records one event, or logs why it could not. It never throws and never rejects: every caller runs
// it after its own business mutation has committed, and a customer action must not fail - or change
// its response - because analytics did (S5 spec 8.3). The log carries the request ID and the
// Postgres error code only; a Postgres message can quote the offending row's values.
export async function trackEventBestEffort(
  input: TrackEventInput,
  context: { requestId?: string } = {},
): Promise<void> {
  let code: string;
  try {
    const { error } = await createAdminClient().from("analytics_events").insert(toRow(input));
    if (!error || error.code === DUPLICATE_KEY) return;
    code = error.code || "unknown";
  } catch {
    code = "exception";
  }

  console.error("Analytics event insert failed.", {
    requestId: await resolveLogRequestId(context.requestId),
    eventName: input.eventName,
    code,
  });
}
