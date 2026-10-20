import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { isOrderReference } from "@/lib/commerce/reference-code";
import { normalizeEmailQuery } from "@/lib/data/users";
import { createClient } from "@/lib/supabase/server";

export type ManualPaymentQueueItemDTO = {
  orderId: string;
  referenceCode: string;
  email: string | null;
  title: string;
  totalMinor: number;
  currency: string;
  createdAt: string;
  claimedAt: string | null;
  claimNote: string | null;
};

type OrderRow = {
  id: string;
  reference_code: string;
  profile_id: string;
  total_minor: number;
  currency: string;
  created_at: string;
  items: { title_snapshot: string }[];
  // An OBJECT, not an array: manual_transfer_claims.order_id is that table's primary key, so
  // PostgREST embeds it as a to-one relation and returns `{...}` or `null`. See lib/data/orders.ts
  // for the full note.
  claims: { claimed_at: string; note: string | null } | null;
};

const LIMIT = 50;
type SessionClient = Awaited<ReturnType<typeof createClient>>;

// Matches admin-orders.ts's emailsFor: one lookup for every profile id the page needs, rather than
// a customer_identities round trip per row.
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

// Claimed-first, then oldest-claim-first, then oldest-order-first (spec 5.6's review queue). The
// database applies this same ordering before the limit (see the query below); this settles the
// page it returns, and is the one place the three-way rule is written out in full.
function byQueuePriority(a: ManualPaymentQueueItemDTO, b: ManualPaymentQueueItemDTO): number {
  if (a.claimedAt !== null && b.claimedAt === null) return -1;
  if (a.claimedAt === null && b.claimedAt !== null) return 1;
  if (a.claimedAt !== null && b.claimedAt !== null) {
    const byClaim = Date.parse(a.claimedAt) - Date.parse(b.claimedAt);
    if (byClaim !== 0) return byClaim;
  }
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// The admin's manual-transfer review queue (spec 5.6): every pending order paid through the manual
// provider, whether or not the reader has reported the transfer yet. A query that looks like an
// order reference (isOrderReference, Task 3) searches reference_code; anything else is treated as a
// customer email, the same split searchAdminOrders makes.
export async function listManualPaymentQueue(query?: string): Promise<ManualPaymentQueueItemDTO[]> {
  await requireAdmin();
  const trimmed = query?.trim() ?? "";
  const supabase = await createClient();
  const isReference = trimmed !== "" && isOrderReference(trimmed);

  let profileIds: string[] | null = null;
  if (trimmed !== "" && !isReference) {
    const { data, error } = await supabase
      .from("customer_identities")
      .select("profile_id")
      .ilike("normalized_email", `%${normalizeEmailQuery(trimmed)}%`)
      .limit(LIMIT);
    if (error) throw new Error("Unable to search manual payments.");
    profileIds = ((data ?? []) as { profile_id: string | null }[]).flatMap((row) => (row.profile_id ? [row.profile_id] : []));
    if (profileIds.length === 0) return [];
  }

  // Two filters, not one: `status = pending` is what makes this a queue of open work, and the
  // `payments!inner` join filtered to `provider = manual` is what makes it the *manual* queue - a
  // pending simulator order must not appear here, the same distinction claim_manual_transfer's own
  // WHERE clause draws.
  const base = supabase
    .from("orders")
    .select(
      "id, reference_code, profile_id, total_minor, currency, created_at, " +
        "items:order_items ( title_snapshot ), " +
        "payments!inner ( provider ), " +
        "claims:manual_transfer_claims ( claimed_at, note )",
    )
    .eq("status", "pending")
    .eq("payments.provider", "manual");

  const filtered = isReference ? base.eq("reference_code", trimmed.toUpperCase()) : profileIds ? base.in("profile_id", profileIds) : base;

  // Claimed orders first, at the DATABASE, because the limit is applied there too. Ordering only
  // in application code sorted whatever survived the cut: with more than LIMIT older unclaimed
  // pending orders, a claim reported this morning fell outside the page and never appeared here at
  // all, while the operator alert - which reads manual_transfer_claims directly and is bounded by
  // nothing - still told the admin to come and look at it.
  //
  // `claims(claimed_at)` is PostgREST's ordering by a to-one embedded resource; manual_transfer_claims
  // keys on order_id, so the embed is one row or null, and nullsFirst: false puts the unclaimed
  // orders behind the claimed ones. created_at breaks the remaining ties, oldest first, for both
  // groups at once.
  const { data, error } = await filtered
    .order("claims(claimed_at)", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(LIMIT);
  if (error) throw new Error("Unable to load manual payments.");

  const rows = (data ?? []) as unknown as OrderRow[];
  const emails = await emailsFor(supabase, [...new Set(rows.map((row) => row.profile_id))]);

  const items = rows.map((row) => ({
    orderId: row.id,
    referenceCode: row.reference_code,
    email: emails.get(row.profile_id) ?? null,
    title: row.items[0]?.title_snapshot ?? "",
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    createdAt: row.created_at,
    claimedAt: row.claims?.claimed_at ?? null,
    claimNote: row.claims?.note ?? null,
  }));

  return items.sort(byQueuePriority);
}
