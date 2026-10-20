import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { STALE_EPUB_JOB_MS, STALE_READER_QUESTION_MS, STUCK_NOTIFICATION_ATTEMPTS, UNPROCESSED_PAYMENT_EVENT_MS } from "@/lib/ops/checks";
import {
  OPS_RULE_NAMES,
  type CompletedOrderRow,
  type EpubJobRow,
  type ManualTransferClaimRow,
  type OperationsAlertState,
  type OperationsSnapshot,
  type OpsRuleName,
  type OutboxRow,
  type PaymentEventRow,
  type ReaderQuestionRow,
} from "@/lib/ops/types";
import type { Database } from "@/lib/supabase/database.types";

// Source-row loaders for the operational rules (spec S5 10). This module never creates a client:
// the scheduled worker passes a service-role client after its bearer-token gate, and
// /admin/operations passes the admin's session client after requireAdmin(), where the existing
// admin-only select policies on every table read here apply.
//
// Each query filters server-side to candidate rows and selects only IDs, timestamps, statuses,
// and book/order/profile references - never an email, a payment payload, or book text.
// evaluateOperations then applies the exact boundaries against the same `now`.

type Client = SupabaseClient<Database>;

// Safety cap per rule. The candidate filters already keep these sets small; the cap only bounds
// a pathological backlog, keeping the oldest rows (the ones an operator should see first).
export const MAX_ROWS_PER_RULE = 500;

export class OperationsQueryError extends Error {
  constructor(readonly source: string, readonly code: string | null) {
    super(`Operations query failed: ${source}`);
    this.name = "OperationsQueryError";
  }
}

function fail(source: string, error: { code?: string | null }): never {
  throw new OperationsQueryError(source, error.code ?? null);
}

// A to-one embed comes back as an object; tolerate an array shape defensively.
function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function loadEpubJobs(client: Client, now: Date): Promise<EpubJobRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_EPUB_JOB_MS).toISOString();
  const { data, error } = await client
    .from("processing_jobs")
    .select("id, status, updated_at, lease_expires_at, ebook_assets!inner(edition_id, editions!inner(book_id))")
    .in("status", ["queued", "processing"])
    .or(`updated_at.lt.${staleBefore},lease_expires_at.lt.${now.toISOString()}`)
    .order("updated_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("processing_jobs", error);

  return (data ?? []).flatMap((row) => {
    const asset = one(row.ebook_assets);
    const bookId = one(asset?.editions)?.book_id;
    const editionId = asset?.edition_id;
    if (!bookId || !editionId) return [];
    return [
      {
        id: row.id,
        bookId,
        editionId,
        status: row.status,
        updatedAt: row.updated_at,
        leaseExpiresAt: row.lease_expires_at,
      },
    ];
  });
}

async function loadCompletedOrders(client: Client): Promise<CompletedOrderRow[]> {
  // Anti-join: the embedded entitlements are limited to active/revoked order-backed rows, and
  // `entitlements is null` keeps only orders with none of them (spec S5 4.4).
  const { data, error } = await client
    .from("orders")
    .select("id, created_at, entitlements(status)")
    .eq("status", "completed")
    .in("entitlements.status", ["active", "revoked"])
    .is("entitlements", null)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("orders", error);

  return (data ?? []).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    orderEntitlementStatuses: (row.entitlements ?? []).map((entitlement) => entitlement.status),
  }));
}

async function loadPaymentEvents(client: Client, now: Date): Promise<PaymentEventRow[]> {
  const receivedBefore = new Date(now.getTime() - UNPROCESSED_PAYMENT_EVENT_MS).toISOString();
  const { data, error } = await client
    .from("payment_events")
    .select("id, received_at, processed_at, payments!inner(order_id)")
    .is("processed_at", null)
    .lt("received_at", receivedBefore)
    .order("received_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("payment_events", error);

  return (data ?? []).flatMap((row) => {
    const orderId = one(row.payments)?.order_id;
    if (!orderId) return [];
    return [{ id: row.id, orderId, receivedAt: row.received_at, processedAt: row.processed_at }];
  });
}

// The outbox is read in two queries because PostgREST cannot express "inner-join entitlements OR
// gift_id is not null" in one: an `entitlements!inner` join drops every gift row unconditionally,
// and a gift row has entitlement_id IS NULL. Before the second branch existed a jammed gift
// delivery burned its six attempts in silence - the purchaser had paid, the recipient never heard,
// and no finding was ever raised. The first query is kept exactly as it was so that book-ready
// detection is provably unchanged by the addition.
async function loadStuckBookOutbox(client: Client, now: Date): Promise<OutboxRow[]> {
  const { data, error } = await client
    .from("notification_outbox")
    .select("id, profile_id, attempt_count, lease_expires_at, sent_at, created_at, entitlements!inner(status)")
    .is("sent_at", null)
    // Only an active entitlement's row can be claimed and cleared (claim_notification_outbox
    // filters the same way), so a revoked one is not a delivery fault.
    .eq("entitlements.status", "active")
    .gte("attempt_count", STUCK_NOTIFICATION_ATTEMPTS)
    .or(`lease_expires_at.is.null,lease_expires_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("notification_outbox", error);

  return (data ?? []).flatMap((row) => {
    const entitlementStatus = one(row.entitlements)?.status;
    // profile_id became nullable when the outbox learned to carry gift rows, which have neither an
    // entitlement nor a profile. The `entitlements!inner` join above already excludes them; this
    // narrows the type honestly rather than asserting, and keeps the finding's link to a real
    // profile page well-formed.
    if (!entitlementStatus || row.profile_id === null) return [];
    return [
      {
        id: row.id,
        profileId: row.profile_id,
        giftId: null,
        orderId: null,
        reviewId: null,
        entitlementStatus,
        attemptCount: row.attempt_count,
        leaseExpiresAt: row.lease_expires_at,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      },
    ];
  });
}

// Through a definer RPC rather than a PostgREST select, and that is not a style choice:
// public.gifts is granted to NOBODY, service_role included (20260924150000), because every read of
// a gift is supposed to go through the security-barrier view or a definer function. An embed of
// `gifts!inner(...)` fails at PLANNING time with 42501 whoever asks, so it never returned a row
// and never could. The RPC carries the same predicate and the same cap, and returns ids and
// timestamps only - no recipient address, no claim path, no token.
async function loadStuckGiftOutbox(client: Client, now: Date): Promise<OutboxRow[]> {
  const { data, error } = await client.rpc("stuck_gift_notifications", {
    p_attempt_floor: STUCK_NOTIFICATION_ATTEMPTS,
    p_now: now.toISOString(),
    p_limit: MAX_ROWS_PER_RULE,
  });
  if (error) fail("notification_outbox", error);

  return (data ?? []).map((row) => ({
    id: row.id,
    profileId: null,
    giftId: row.gift_id,
    orderId: row.order_id,
    reviewId: null,
    entitlementStatus: null,
    attemptCount: row.attempt_count,
    leaseExpiresAt: row.lease_expires_at,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  }));
}

// S15: a review-reply row joins book_reviews, which service_role and admins can select directly
// (unlike gifts), so a PostgREST embed is enough. Only a published review with a reply can be
// claimed (claim_notification_outbox filters the same way), so an unpublished one is not a
// delivery fault and is filtered here for the same reason the book branch filters on an active
// entitlement.
async function loadStuckReviewOutbox(client: Client, now: Date): Promise<OutboxRow[]> {
  const { data, error } = await client
    .from("notification_outbox")
    .select("id, profile_id, review_id, attempt_count, lease_expires_at, sent_at, created_at, book_reviews!inner(status, author_reply)")
    .is("sent_at", null)
    .eq("book_reviews.status", "published")
    .not("book_reviews.author_reply", "is", null)
    .gte("attempt_count", STUCK_NOTIFICATION_ATTEMPTS)
    .or(`lease_expires_at.is.null,lease_expires_at.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("notification_outbox", error);

  return (data ?? []).flatMap((row) => {
    if (row.review_id === null) return [];
    return [
      {
        id: row.id,
        profileId: row.profile_id,
        giftId: null,
        orderId: null,
        reviewId: row.review_id,
        entitlementStatus: null,
        attemptCount: row.attempt_count,
        leaseExpiresAt: row.lease_expires_at,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      },
    ];
  });
}

// Merged oldest first and capped OVERALL, so a backlog on one branch cannot starve the others out
// of the operator's view.
async function loadStuckOutbox(client: Client, now: Date): Promise<OutboxRow[]> {
  const [books, gifts, reviews] = await Promise.all([
    loadStuckBookOutbox(client, now),
    loadStuckGiftOutbox(client, now),
    loadStuckReviewOutbox(client, now),
  ]);
  return [...books, ...gifts, ...reviews]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_ROWS_PER_RULE);
}

async function loadManualTransferClaims(client: Client): Promise<ManualTransferClaimRow[]> {
  // The `orders!inner` join filtered to `status = pending` is what excludes a claim whose order
  // confirm_manual_payment or reject_manual_payment already resolved - both delete the claim row
  // too, but this filter is what keeps a claim off the page the instant its order stops being
  // pending, without waiting on that delete.
  const { data, error } = await client
    .from("manual_transfer_claims")
    .select("order_id, claimed_at, orders!inner ( status )")
    .eq("orders.status", "pending")
    .order("claimed_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("manual_transfer_claims", error);

  return (data ?? []).map((row) => ({ orderId: row.order_id, claimedAt: row.claimed_at }));
}

// Filters on `new` and the age boundary server-side, so the 500-row cap keeps the oldest stale
// questions rather than filling with young ones. Both clients can read the table: service_role
// bypasses RLS, and an admin session passes the `admin reads questions` select policy.
async function loadReaderQuestions(client: Client, now: Date): Promise<ReaderQuestionRow[]> {
  const staleBefore = new Date(now.getTime() - STALE_READER_QUESTION_MS).toISOString();
  const { data, error } = await client
    .from("reader_questions")
    .select("id, created_at")
    .eq("status", "new")
    .lt("created_at", staleBefore)
    .order("created_at", { ascending: true })
    .limit(MAX_ROWS_PER_RULE);
  if (error) fail("reader_questions", error);

  return (data ?? []).map((row) => ({ id: row.id, createdAt: row.created_at }));
}

export async function loadOperationsSnapshot(client: Client, now: Date): Promise<OperationsSnapshot> {
  const [epubJobs, completedOrders, paymentEvents, outbox, manualTransferClaims, readerQuestions] = await Promise.all([
    loadEpubJobs(client, now),
    loadCompletedOrders(client),
    loadPaymentEvents(client, now),
    loadStuckOutbox(client, now),
    loadManualTransferClaims(client),
    loadReaderQuestions(client, now),
  ]);
  return { epubJobs, completedOrders, paymentEvents, outbox, manualTransferClaims, readerQuestions };
}

function isRuleName(value: string): value is OpsRuleName {
  return (OPS_RULE_NAMES as readonly string[]).includes(value);
}

export async function loadOperationsAlertState(client: Client): Promise<OperationsAlertState[]> {
  const { data, error } = await client
    .from("operations_alert_state")
    .select("rule_name, active, fingerprint, first_detected_at, last_evaluated_at, last_alerted_at, resolved_at");
  if (error) fail("operations_alert_state", error);

  return (data ?? [])
    .filter((row) => isRuleName(row.rule_name))
    .map((row) => ({
      ruleName: row.rule_name as OpsRuleName,
      active: row.active,
      fingerprint: row.fingerprint,
      firstDetectedAt: row.first_detected_at,
      lastEvaluatedAt: row.last_evaluated_at,
      lastAlertedAt: row.last_alerted_at,
      resolvedAt: row.resolved_at,
    }))
    .sort((a, b) => OPS_RULE_NAMES.indexOf(a.ruleName) - OPS_RULE_NAMES.indexOf(b.ruleName));
}
