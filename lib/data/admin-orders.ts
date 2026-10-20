import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";
import { normalizeEmailQuery } from "@/lib/data/users";
import { createClient } from "@/lib/supabase/server";

export type AdminOrderListItemDTO = {
  id: string;
  profileId: string;
  email: string | null;
  title: string;
  totalMinor: number;
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  createdAt: string;
};

export type AdminOrderDTO = Omit<AdminOrderListItemDTO, "title"> & {
  referenceCode: string;
  item: { bookId: string; title: string; unitPriceMinor: number } | null;
  payments: {
    id: string;
    provider: string;
    externalPaymentId: string | null;
    status: PaymentStatus;
    amountMinor: number;
    currency: string;
    createdAt: string;
  }[];
  events: { id: string; provider: string; providerEventId: string; receivedAt: string; processedAt: string | null }[];
  entitlement: {
    id: string;
    sourceType: "free_order" | "simulated_payment" | "manual_payment" | "sepay_payment" | "admin_grant";
    status: "active" | "revoked";
    grantedAt: string;
    revokedAt: string | null;
  } | null;
  // The reader's "I have transferred" report (spec 5.5), for a manual order still awaiting a
  // decision. Cleared once the order is confirmed or declined, so this is null on every other order.
  manualClaim: { claimedAt: string; note: string | null } | null;
  // The admin's own confirmation record (spec 5.6) - what actually arrived and who accepted it -
  // kept as evidence distinct from the entitlement it produced.
  manualConfirmation: {
    receivedAmountMinor: number;
    bankReference: string;
    note: string | null;
    mismatchAccepted: boolean;
    confirmedAt: string;
  } | null;
};

type OrderRow = {
  id: string;
  profile_id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total_minor: number;
  currency: string;
  created_at: string;
  reference_code?: string;
  items: { book_id?: string; title_snapshot: string; unit_price_minor?: number }[];
  // Both are OBJECTS, not arrays: order_id is the primary key of manual_transfer_claims and of
  // manual_payment_confirmations alike, so PostgREST embeds each as a to-one relation and returns
  // `{...}` or `null`. See lib/data/orders.ts for the full note.
  claims?: { claimed_at: string; note: string | null } | null;
  confirmations?: {
    received_amount_minor: number;
    bank_reference: string;
    note: string | null;
    mismatch_accepted: boolean;
    confirmed_at: string;
  } | null;
};

const LIMIT = 50;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SessionClient = Awaited<ReturnType<typeof createClient>>;

async function emailsFor(supabase: SessionClient, profileIds: string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("customer_identities")
    .select("profile_id, normalized_email")
    .in("profile_id", profileIds);
  if (error) throw new Error("Unable to load order customers.");
  return new Map(
    ((data ?? []) as { profile_id: string | null; normalized_email: string }[]).flatMap((row) =>
      row.profile_id ? [[row.profile_id, row.normalized_email] as const] : [],
    ),
  );
}

// Reads go through the session client under the admin read policies (orders, order_items, payments,
// payment_events, entitlements, customer_identities).
export async function searchAdminOrders(rawQuery: string | undefined): Promise<AdminOrderListItemDTO[]> {
  await requireAdmin();
  const query = rawQuery?.trim() ?? "";
  const supabase = await createClient();

  let profileIds: string[] | null = null;
  if (!uuidPattern.test(query) && query.length >= 3) {
    const { data, error } = await supabase
      .from("customer_identities")
      .select("profile_id")
      .ilike("normalized_email", `%${normalizeEmailQuery(query)}%`)
      .limit(LIMIT);
    if (error) throw new Error("Unable to search orders.");
    profileIds = ((data ?? []) as { profile_id: string | null }[]).flatMap((row) => (row.profile_id ? [row.profile_id] : []));
    if (profileIds.length === 0) return [];
  }

  const base = supabase
    .from("orders")
    .select("id, profile_id, status, payment_status, total_minor, currency, created_at, items:order_items ( title_snapshot )");
  const filtered = uuidPattern.test(query) ? base.eq("id", query) : profileIds ? base.in("profile_id", profileIds) : base;
  const { data, error } = await filtered.order("created_at", { ascending: false }).limit(LIMIT);
  if (error) throw new Error("Unable to search orders.");

  const rows = (data ?? []) as unknown as OrderRow[];
  const emails = await emailsFor(supabase, [...new Set(rows.map((row) => row.profile_id))]);
  return rows.map((row) => ({
    id: row.id,
    profileId: row.profile_id,
    email: emails.get(row.profile_id) ?? null,
    title: row.items[0]?.title_snapshot ?? "",
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    status: row.status,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
  }));
}

type PaymentRow = { id: string; provider: string; external_payment_id: string | null; status: PaymentStatus; amount_minor: number; currency: string; created_at: string };
type EventRow = { id: string; provider: string; provider_event_id: string; received_at: string; processed_at: string | null };
type EntitlementRow = { id: string; source_type: "free_order" | "simulated_payment" | "manual_payment" | "sepay_payment" | "admin_grant"; status: "active" | "revoked"; granted_at: string; revoked_at: string | null };

export async function getAdminOrder(orderId: string): Promise<AdminOrderDTO> {
  await requireAdmin();
  if (!uuidPattern.test(orderId)) notFound();

  const supabase = await createClient();
  const [order, payments, entitlement] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id, profile_id, status, payment_status, total_minor, currency, created_at, reference_code, " +
          "items:order_items ( book_id, title_snapshot, unit_price_minor ), " +
          "claims:manual_transfer_claims ( claimed_at, note ), " +
          "confirmations:manual_payment_confirmations ( received_amount_minor, bank_reference, note, mismatch_accepted, confirmed_at )",
      )
      .eq("id", orderId)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("id, provider, external_payment_id, status, amount_minor, currency, created_at")
      .eq("order_id", orderId)
      .order("created_at"),
    supabase
      .from("entitlements")
      .select("id, source_type, status, granted_at, revoked_at")
      .eq("source_order_id", orderId)
      .order("granted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  for (const result of [order, payments, entitlement]) {
    if (result.error) throw new Error("Unable to load order.");
  }
  if (!order.data) notFound();

  const orderRow = order.data as unknown as OrderRow;
  const paymentRows = (payments.data ?? []) as unknown as PaymentRow[];
  const paymentIds = paymentRows.map((payment) => payment.id);

  const [events, emails] = await Promise.all([
    paymentIds.length > 0
      ? supabase
          .from("payment_events")
          .select("id, provider, provider_event_id, received_at, processed_at")
          .in("payment_id", paymentIds)
          .order("received_at")
      : Promise.resolve({ data: [], error: null }),
    emailsFor(supabase, [orderRow.profile_id]),
  ]);
  if (events.error) throw new Error("Unable to load order.");

  const item = orderRow.items[0];
  const entitlementRow = entitlement.data as unknown as EntitlementRow | null;

  return {
    id: orderRow.id,
    profileId: orderRow.profile_id,
    email: emails.get(orderRow.profile_id) ?? null,
    totalMinor: Number(orderRow.total_minor),
    currency: orderRow.currency,
    status: orderRow.status,
    paymentStatus: orderRow.payment_status,
    createdAt: orderRow.created_at,
    referenceCode: orderRow.reference_code ?? "",
    item: item?.book_id
      ? { bookId: item.book_id, title: item.title_snapshot, unitPriceMinor: Number(item.unit_price_minor ?? 0) }
      : null,
    payments: paymentRows.map((payment) => ({
      id: payment.id,
      provider: payment.provider,
      externalPaymentId: payment.external_payment_id,
      status: payment.status,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      createdAt: payment.created_at,
    })),
    events: ((events.data ?? []) as unknown as EventRow[]).map((event) => ({
      id: event.id,
      provider: event.provider,
      providerEventId: event.provider_event_id,
      receivedAt: event.received_at,
      processedAt: event.processed_at,
    })),
    entitlement: entitlementRow
      ? {
          id: entitlementRow.id,
          sourceType: entitlementRow.source_type,
          status: entitlementRow.status,
          grantedAt: entitlementRow.granted_at,
          revokedAt: entitlementRow.revoked_at,
        }
      : null,
    manualClaim: orderRow.claims ? { claimedAt: orderRow.claims.claimed_at, note: orderRow.claims.note } : null,
    manualConfirmation: orderRow.confirmations
      ? {
          receivedAmountMinor: Number(orderRow.confirmations.received_amount_minor),
          bankReference: orderRow.confirmations.bank_reference,
          note: orderRow.confirmations.note,
          mismatchAccepted: orderRow.confirmations.mismatch_accepted,
          confirmedAt: orderRow.confirmations.confirmed_at,
        }
      : null,
  };
}
