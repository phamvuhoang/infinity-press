import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import type { CouponInput } from "@/lib/catalog/schemas";
import type { CouponKind } from "@/lib/commerce/coupon";
import { createClient } from "@/lib/supabase/server";

export type AdminCouponDTO = {
  id: string;
  code: string;
  kind: CouponKind;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  maxRedemptions: number | null;
  maxRedemptionsPerProfile: number;
  note: string | null;
  createdAt: string;
  // Reserved is "held by a pending order"; redeemed is "spent". Together they are the whole
  // reporting surface S8 has (spec 3).
  reservedCount: number;
  redeemedCount: number;
  // Two independent scopes (S9 spec 8). Empty arrays on both means the code applies to everything;
  // bundle scope is never inferred from a bundle's member books.
  bookIds: string[];
  bundleIds: string[];
};

type CouponRow = {
  id: string; code: string; kind: CouponKind; percent_off: number | null; amount_off_minor: number | null;
  currency: string | null; starts_at: string | null; ends_at: string | null; active: boolean;
  max_redemptions: number | null; max_redemptions_per_profile: number; note: string | null;
  created_at: string; reserved_count: number; redeemed_count: number; book_ids: string[] | null;
  bundle_ids: string[] | null;
};

// EB025 is surfaced as a named condition rather than swallowed: the editor tells the operator why
// the value did not change instead of showing a generic failure.
export class CouponValueLockedError extends Error {
  constructor() {
    super("This coupon has already been used, so its value cannot change.");
    this.name = "CouponValueLockedError";
  }
}

// The unique index on coupons.code (23505). Named the same way lib/data/books.ts names
// DuplicateCanonicalKeyError, so the action can show it against the code field instead of a
// generic failure.
export class DuplicateCouponCodeError extends Error {
  constructor() {
    super("A coupon with this code already exists.");
    this.name = "DuplicateCouponCodeError";
  }
}

function toDTO(row: CouponRow): AdminCouponDTO {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    percentOff: row.percent_off,
    amountOffMinor: row.amount_off_minor === null ? null : Number(row.amount_off_minor),
    currency: row.currency,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    active: row.active,
    maxRedemptions: row.max_redemptions,
    maxRedemptionsPerProfile: row.max_redemptions_per_profile,
    note: row.note,
    createdAt: row.created_at,
    reservedCount: Number(row.reserved_count),
    redeemedCount: Number(row.redeemed_count),
    bookIds: row.book_ids ?? [],
    bundleIds: row.bundle_ids ?? [],
  };
}

// coupons has no select policy at all, by design (spec 5.2), so every read here goes through a
// definer RPC rather than through PostgREST.
export async function listAdminCoupons(): Promise<AdminCouponDTO[]> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_coupons");
  if (error) throw new Error(`listAdminCoupons: admin_list_coupons failed: ${error.message}`);
  return ((data ?? []) as CouponRow[]).map(toDTO);
}

export async function getAdminCoupon(couponId: string): Promise<AdminCouponDTO | null> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_get_coupon", { p_id: couponId });
  if (error) throw new Error(`getAdminCoupon: admin_get_coupon failed: ${error.message}`);
  const row = (data as CouponRow[] | null)?.[0];
  return row ? toDTO(row) : null;
}

function rpcArguments(input: CouponInput) {
  return {
    p_kind: input.kind,
    p_percent_off: input.percentOff,
    p_amount_off_minor: input.amountOffMinor,
    p_currency: input.currency,
    p_starts_at: input.startsAt,
    p_ends_at: input.endsAt,
    p_max_redemptions: input.maxRedemptions,
    p_max_redemptions_per_profile: input.maxRedemptionsPerProfile,
    p_note: input.note,
    p_book_ids: input.bookIds,
    p_bundle_ids: input.bundleIds,
  };
}

export async function createCoupon(input: CouponInput): Promise<string> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_coupon", { p_code: input.code, ...rpcArguments(input) });
  if (error) {
    // 23505: the unique index on coupons.code. supabase-js exposes the Postgres error code on
    // `error.code`, so this checks that directly rather than matching on the message text.
    if (error.code === "23505") throw new DuplicateCouponCodeError();
    throw new Error(`createCoupon: admin_create_coupon failed: ${error.message}`);
  }
  return data as string;
}

export async function updateCoupon(couponId: string, input: CouponInput): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_update_coupon", { p_id: couponId, p_active: input.active, ...rpcArguments(input) });
  if (error) {
    if (error.code === "EB025") throw new CouponValueLockedError();
    throw new Error(`updateCoupon: admin_update_coupon failed: ${error.message}`);
  }
}
