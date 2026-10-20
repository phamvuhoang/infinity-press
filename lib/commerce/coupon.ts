// The discount rules, written once (S8 spec 6). apply_coupon_to_order implements the same rules in
// SQL and supabase/tests/036_s8_coupon_rpcs.sql runs the same cases, the way lib/commerce/
// order-state.ts and supabase/tests/018_ebook_orders.sql already mirror each other. This module
// reads nothing and decides nothing about eligibility; it is arithmetic and a code format.
export type CouponKind = "percent" | "fixed";

export type CouponRule =
  | { kind: "percent"; percentOff: number }
  | { kind: "fixed"; amountOffMinor: number; currency: string };

export type OrderAmount = { subtotalMinor: number; currency: string };

// A code is read off a screen, a chat message, or a slip of paper and typed back in, so the
// alphabet stays to upper-case ASCII letters, digits, and the hyphen. The same pattern is a CHECK
// constraint on coupons.code, so a code that cannot be typed here cannot be created there either.
export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,30}[A-Z0-9]$/;

// Readers paste codes with stray spaces and in whatever case they were written. Normalization is
// applied on write (the admin editor) and on read (the checkout field), so the two always meet.
export function normalizeCouponCode(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isCouponCode(value: string): boolean {
  return COUPON_CODE_PATTERN.test(value);
}

export function computeDiscountMinor(coupon: CouponRule, order: OrderAmount): number {
  const raw =
    coupon.kind === "percent"
      ? // Integer maths, floored: a discount never rounds up into the house's money.
        Math.floor((order.subtotalMinor * coupon.percentOff) / 100)
      : fixedAmount(coupon, order);
  // Clamped, so a fixed amount larger than the price yields a zero total rather than a negative one.
  return Math.min(Math.max(raw, 0), Math.max(order.subtotalMinor, 0));
}

function fixedAmount(coupon: { amountOffMinor: number; currency: string }, order: OrderAmount): number {
  // Unreachable through apply_coupon_to_order, which rejects a currency mismatch as an invalid
  // coupon before it computes anything. It throws rather than converting because there is no
  // conversion rate in this system, and silently treating 500 USD cents as 500 VND would be a
  // pricing error nobody would see until the money was gone.
  if (coupon.currency !== order.currency) {
    throw new Error(`computeDiscountMinor: coupon currency ${coupon.currency} does not match order currency ${order.currency}`);
  }
  return coupon.amountOffMinor;
}
