import { describe, expect, it } from "vitest";

import { checkoutAmounts, checkoutStatusView, customerOrderStatus } from "@/lib/commerce/checkout-view";
import type { OrderState } from "@/lib/commerce/order-state";

const rows: [OrderState, ReturnType<typeof checkoutStatusView>, ReturnType<typeof customerOrderStatus>][] = [
  [{ status: "completed", paymentStatus: "succeeded" }, "success", "completed"],
  [{ status: "completed", paymentStatus: "not_required" }, "success", "completed"],
  [{ status: "pending", paymentStatus: "failed" }, "failed", "paymentFailed"],
  [{ status: "pending", paymentStatus: "pending" }, "processing", "awaitingPayment"],
  [{ status: "cancelled", paymentStatus: "cancelled" }, "cancelled", "cancelled"],
];

const DECLINED = "2026-09-20T10:00:00+00:00";
const CLAIMED = "2026-09-20T11:00:00+00:00";

describe("checkout views", () => {
  it.each(rows)("maps %j to %s and %s", (order, view, label) => {
    expect(checkoutStatusView(order)).toBe(view);
    expect(customerOrderStatus({ ...order, provider: null, claimedAt: null, declinedAt: null })).toBe(label);
  });

  it("labels a manual order awaiting a transfer", () => {
    expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "manual", claimedAt: null, declinedAt: null }))
      .toBe("awaitingTransfer");
  });

  it("labels a manual order awaiting our confirmation", () => {
    expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "manual", claimedAt: CLAIMED, declinedAt: null }))
      .toBe("awaitingConfirmation");
  });

  it("leaves a simulator order's labels exactly as they were", () => {
    expect(customerOrderStatus({ status: "pending", paymentStatus: "pending", provider: "simulator", claimedAt: null, declinedAt: null }))
      .toBe("awaitingPayment");
  });

  it("labels a confirmed manual order completed", () => {
    expect(customerOrderStatus({ status: "completed", paymentStatus: "succeeded", provider: "manual", claimedAt: null, declinedAt: null }))
      .toBe("completed");
  });

  it("labels a cancelled manual order cancelled", () => {
    expect(customerOrderStatus({ status: "cancelled", paymentStatus: "cancelled", provider: "manual", claimedAt: null, declinedAt: null }))
      .toBe("cancelled");
  });

  it("labels a declined manual order payment failed", () => {
    expect(customerOrderStatus({ status: "pending", paymentStatus: "failed", provider: "manual", claimedAt: null, declinedAt: DECLINED }))
      .toBe("paymentFailed");
  });

  // The order history has to move on with the transfer page: payment_status stays 'failed' after a
  // decline, so a reader who reported a fresh transfer would otherwise still read "Payment failed"
  // in their own order list while the admin queue shows the new report.
  it("labels a manual order reported again after a decline as awaiting confirmation", () => {
    expect(customerOrderStatus({ status: "pending", paymentStatus: "failed", provider: "manual", claimedAt: CLAIMED, declinedAt: DECLINED }))
      .toBe("awaitingConfirmation");
  });
});

describe("checkoutAmounts", () => {
  it("hides the discount rows on an order with no code", () => {
    expect(checkoutAmounts({ subtotalMinor: 129000, discountMinor: 0, totalMinor: 129000, couponCode: null })).toMatchObject({
      hasDiscount: false,
      totalMinor: 129000,
    });
  });

  it("shows the discount rows and the code when one is applied", () => {
    expect(checkoutAmounts({ subtotalMinor: 129000, discountMinor: 25800, totalMinor: 103200, couponCode: "TWENTY" })).toMatchObject({
      hasDiscount: true,
      discountMinor: 25800,
      couponCode: "TWENTY",
    });
  });
});
