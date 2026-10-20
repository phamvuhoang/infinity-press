import "server-only";

import { requireUser } from "@/lib/auth/session";
import { isCouponCode, normalizeCouponCode } from "@/lib/commerce/coupon";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

// One class for every reason a CODE was refused (spec 4: "one message for every invalid code, so
// codes cannot be enumerated by their error"). `detail` exists for the server log and nothing else
// - the Server Action writes it beside the request ID and shows the reader the one shared message.
//
// apply_coupon_to_order (supabase/migrations/20260923120000_s8_coupon_rpcs.sql) does NOT return a
// `detail` column: returning the discriminating reason to the browser-callable `authenticated` role
// would be a code oracle, defeating the reason every invalid code looks identical. The database logs
// the reason with `raise log` instead. So a rejection that came back from the RPC always constructs
// this error with a null detail; only the local malformed-code pre-check below, which the
// application itself decided without asking the database anything, carries one.
export class CouponRejectedError extends Error {
  constructor(readonly detail: string | null) {
    super("This code cannot be used.");
    this.name = "CouponRejectedError";
  }
}

export class CouponRateLimitedError extends Error {
  constructor() {
    super("Too many codes have been tried.");
    this.name = "CouponRateLimitedError";
  }
}

// The ORDER refused the operation - not the caller's, not pending, already couponed, or already
// carrying a reported transfer. Distinct from CouponRejectedError because it sends the reader
// somewhere else rather than asking them to retype anything.
export class OrderNotCouponableError extends Error {
  constructor() {
    super("This order cannot take a code right now.");
    this.name = "OrderNotCouponableError";
  }
}

export type ApplyCouponResult = {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  completed: boolean;
  // Every book the reader now holds for this order, not one of them: a fully discounted BUNDLE
  // order grants each of its member books in the same call (S9 spec 5). Empty on every path that
  // granted nothing - including a completed GIFT order, which grants the buyer nothing at all
  // (S9 spec 7.2), so `completed` with an empty array is an ordinary outcome here and not a
  // contract break.
  entitlementIds: string[];
};

type ApplyRow = {
  subtotal_minor: number;
  discount_minor: number;
  total_minor: number;
  order_status: string;
  entitlement_ids: string[] | null;
  rejection: string | null;
};

export async function applyCouponToOrder(locale: Locale, orderId: string, code: string): Promise<ApplyCouponResult> {
  await requireUser(locale);

  // A code that cannot exist is refused here, so a keyboard mash never reaches the database and
  // never spends a unit of the reader's own attempt quota.
  const normalized = normalizeCouponCode(code);
  if (!isCouponCode(normalized)) throw new CouponRejectedError("malformed code");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("apply_coupon_to_order", { p_order_id: orderId, p_code: normalized });
  if (error) {
    // EB024: the order, not the code. P0002: no profile for this session at all, which means the
    // same thing to the reader - this order is not theirs to change.
    if (error.code === "EB024" || error.code === "P0002") throw new OrderNotCouponableError();
    throw new Error(`applyCouponToOrder: apply_coupon_to_order failed: ${error.message}`);
  }

  const row = (data as ApplyRow[] | null)?.[0];
  if (!row) throw new Error("applyCouponToOrder: apply_coupon_to_order returned no row");
  if (row.rejection === "rate_limited") throw new CouponRateLimitedError();
  if (row.rejection !== null) throw new CouponRejectedError(null);

  return {
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    totalMinor: Number(row.total_minor),
    completed: row.order_status === "completed",
    entitlementIds: row.entitlement_ids ?? [],
  };
}

export async function removeCouponFromOrder(
  locale: Locale,
  orderId: string,
): Promise<{ subtotalMinor: number; discountMinor: number; totalMinor: number }> {
  await requireUser(locale);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_coupon_from_order", { p_order_id: orderId });
  if (error) {
    if (error.code === "EB024" || error.code === "P0002") throw new OrderNotCouponableError();
    throw new Error(`removeCouponFromOrder: remove_coupon_from_order failed: ${error.message}`);
  }
  const row = (data as { subtotal_minor: number; discount_minor: number; total_minor: number }[] | null)?.[0];
  if (!row) throw new Error("removeCouponFromOrder: remove_coupon_from_order returned no row");
  return {
    subtotalMinor: Number(row.subtotal_minor),
    discountMinor: Number(row.discount_minor),
    totalMinor: Number(row.total_minor),
  };
}
