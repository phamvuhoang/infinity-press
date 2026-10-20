import "server-only";

import { headers } from "next/headers";

import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";
import { getActiveEntitlementBookIds } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

// One line of an order. An order holds several since S9 (spec 5): a bundle purchase is one order
// over every published member book.
export type CustomerOrderItemDTO = {
  bookId: string;
  title: string;
  hasActiveEntitlement: boolean;
};

export type CustomerOrderDTO = {
  id: string;
  // Non-null exactly for a bundle purchase, which is what every page branches on. It is read from
  // orders.bundle_id rather than inferred from the number of items: a bundle can hold one published
  // member, and a single-book order is never a bundle however it is priced.
  bundleId: string | null;
  // The order's own name: orders.title_snapshot for a bundle (the bundle's title at the moment of
  // sale), the single line's title for a book. Never one arbitrary member of a bundle.
  title: string;
  // In persisted order_items.position order, which is a sparse rank and not a dense index:
  // create_bundle_order numbers the lines after bundle_books.position, and an unpublished member is
  // left out, so positions 2, 3 with no 1 is an ordinary order.
  items: CustomerOrderItemDTO[];
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  totalMinor: number;
  currency: string;
  createdAt: string;
  // True only when EVERY book of the order is already held. A bundle is never prorated for partial
  // ownership (spec 5), so this is what decides "pay" against "go to your library" - the ownership
  // of any single line decides nothing.
  hasAllActiveEntitlements: boolean;
  referenceCode: string;
  provider: string;
  subtotalMinor: number;
  discountMinor: number;
  couponCode: string | null;
  // Timestamps rather than a boolean and a reason alone: which of the two happened last is what
  // separates "we declined your transfer" from "you told us about a new one". See
  // resolveManualTransferState.
  claimedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
};

type OrderRow = {
  id: string;
  reference_code: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total_minor: number;
  currency: string;
  subtotal_minor: number;
  discount_minor: number;
  coupon_code: string | null;
  created_at: string;
  // The provider is a column on the order, deliberately, and not an embed of the order's payments
  // row. public.payments carries exactly one policy - "admin reads payments" - so for the reader
  // every manual state on this page is rendered for, a payments embed comes back empty and the
  // provider read off it was always null. See 20260922160000_order_payment_provider.sql.
  payment_provider: string;
  bundle_id: string | null;
  title_snapshot: string | null;
  items: { book_id: string; title_snapshot: string; position: number }[];
  // An OBJECT, not an array. PostgREST decides an embed's cardinality from the child's key:
  // manual_transfer_claims.order_id is its PRIMARY key, so at most one row can exist per order and
  // the embed comes back as `{...}` or `null`. manual_payment_declines keys on its own id with
  // order_id merely indexed, so that one is a collection and stays an array. Typing the claim as an
  // array compiles, and `(row.claims ?? []).length > 0` on an object is silently always false - the
  // reader's report then never registers anywhere in the UI, which is exactly what happened.
  claims?: { claimed_at: string } | null;
  declines?: { reason: string; sequence: number; declined_at: string }[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderColumns =
  "id, reference_code, status, payment_status, total_minor, currency, subtotal_minor, discount_minor, coupon_code, created_at, payment_provider, " +
  "bundle_id, title_snapshot, " +
  "items:order_items ( book_id, title_snapshot, position ), " +
  "claims:manual_transfer_claims ( claimed_at ), " +
  "declines:manual_payment_declines ( reason, sequence, declined_at )";

async function failure(operation: string, cause: unknown): Promise<Error> {
  let requestId: string | null = null;
  try {
    requestId = getRequestId(await headers());
  } catch {
    // Outside a request scope there is no request ID.
  }
  console.error("Order read failed.", { operation, code: (cause as { code?: string } | null)?.code ?? null, requestId });
  return new Error(`${operation} failed.`, { cause });
}

function toDTO(row: OrderRow, owned: Set<string>): CustomerOrderDTO | null {
  // Sorted here as well as in the query. The query's `order` is what PostgREST is asked for; this
  // is what the DTO guarantees, and a reader of this function should not have to go and check the
  // query to know the list is in the order the shop sold it in.
  const items = [...row.items]
    .sort((left, right) => left.position - right.position)
    .map((item) => ({ bookId: item.book_id, title: item.title_snapshot, hasActiveEntitlement: owned.has(item.book_id) }));
  // An order with no line is not renderable: there is nothing to name it, price or open.
  if (items.length === 0) return null;
  // Declines are a history, not a single row (spec 5.6): the reader is shown the most recent
  // reason, which is the row with the highest sequence - not the first one returned, and not the
  // one with the latest declined_at, since sequence is what orders them without depending on ties.
  const latestDecline = (row.declines ?? []).reduce<{ reason: string; sequence: number; declined_at: string } | null>(
    (best, candidate) => (best === null || candidate.sequence > best.sequence ? candidate : best),
    null,
  );
  return {
    id: row.id,
    bundleId: row.bundle_id,
    // title_snapshot is written by create_bundle_order and by nothing else, so it is non-null
    // exactly for a bundle order.
    title: row.title_snapshot ?? items[0].title,
    items,
    status: row.status,
    paymentStatus: row.payment_status,
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    createdAt: row.created_at,
    hasAllActiveEntitlements: items.every((item) => item.hasActiveEntitlement),
    referenceCode: row.reference_code,
    provider: row.payment_provider,
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    couponCode: row.coupon_code,
    claimedAt: row.claims?.claimed_at ?? null,
    declinedAt: latestDecline?.declined_at ?? null,
    declineReason: latestDecline?.reason ?? null,
  };
}

// Customer order reads (S3 spec 4.9). RLS limits a reader to their own orders, but admins can read
// every order, so each query also filters by the caller's own profile ID. Another reader's order
// looks exactly like a missing one.
export async function getCustomerOrder(orderId: string): Promise<CustomerOrderDTO | null> {
  if (!uuidPattern.test(orderId)) return null;
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();
  const [{ data, error }, owned] = await Promise.all([
    supabase
      .from("orders")
      .select(orderColumns)
      .eq("id", orderId)
      .eq("profile_id", profile.id)
      .order("position", { referencedTable: "order_items" })
      .maybeSingle(),
    getActiveEntitlementBookIds(profile.id),
  ]);
  if (error) throw await failure("getCustomerOrder", error);
  return data ? toDTO(data as unknown as OrderRow, owned) : null;
}

export async function listCustomerOrders(): Promise<CustomerOrderDTO[]> {
  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();
  const [{ data, error }, owned] = await Promise.all([
    supabase
      .from("orders")
      .select(orderColumns)
      .eq("profile_id", profile.id)
      .order("position", { referencedTable: "order_items" })
      .order("created_at", { ascending: false })
      .limit(100),
    getActiveEntitlementBookIds(profile.id),
  ]);
  if (error) throw await failure("listCustomerOrders", error);
  return ((data ?? []) as unknown as OrderRow[]).flatMap((row) => toDTO(row, owned) ?? []);
}
