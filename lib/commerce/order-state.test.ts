import { describe, expect, it } from "vitest";

import { nextOrderState, type OrderState, type PaymentEventStatus } from "@/lib/commerce/order-state";

const pending: OrderState = { status: "pending", paymentStatus: "pending" };
const pendingFailed: OrderState = { status: "pending", paymentStatus: "failed" };
const completed: OrderState = { status: "completed", paymentStatus: "succeeded" };
const cancelled: OrderState = { status: "cancelled", paymentStatus: "cancelled" };

// S3 spec 4.5. supabase/tests/018_ebook_orders.sql runs the same rows through apply_payment_event.
const cases: [string, OrderState, PaymentEventStatus, ReturnType<typeof nextOrderState>][] = [
  ["pending + succeeded", pending, "succeeded", { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true }],
  ["pending + failed", pending, "failed", { status: "pending", paymentStatus: "failed", grantsEntitlement: false }],
  ["pending + cancelled", pending, "cancelled", { status: "cancelled", paymentStatus: "cancelled", grantsEntitlement: false }],
  ["failed payment + succeeded (try again)", pendingFailed, "succeeded", { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true }],
  ["completed + succeeded", completed, "succeeded", { ...completed, grantsEntitlement: false }],
  ["completed + failed", completed, "failed", { ...completed, grantsEntitlement: false }],
  ["completed + cancelled", completed, "cancelled", { ...completed, grantsEntitlement: false }],
  ["cancelled + succeeded", cancelled, "succeeded", { ...cancelled, grantsEntitlement: false }],
  ["cancelled + failed", cancelled, "failed", { ...cancelled, grantsEntitlement: false }],
  ["cancelled + cancelled", cancelled, "cancelled", { ...cancelled, grantsEntitlement: false }],
];

describe("nextOrderState", () => {
  it.each(cases)("%s", (_label, before, event, after) => {
    expect(nextOrderState(before, event)).toEqual(after);
  });
});
