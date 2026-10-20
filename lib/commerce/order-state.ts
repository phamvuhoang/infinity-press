// Order state rules for one payment event (S3 spec 4.5). apply_payment_event implements the same
// rules in the database, and supabase/tests/018_ebook_orders.sql runs the same cases. This function
// never changes an order; it is the tested statement of the contract the RPC keeps.
export type OrderStatus = "draft" | "pending" | "completed" | "cancelled";
export type PaymentStatus = "not_required" | "pending" | "succeeded" | "failed" | "cancelled";
export type PaymentEventStatus = "succeeded" | "failed" | "cancelled";

export type OrderState = { status: OrderStatus; paymentStatus: PaymentStatus };

export function nextOrderState(order: OrderState, event: PaymentEventStatus): OrderState & { grantsEntitlement: boolean } {
  // Only a pending order reacts. A failed payment leaves the order pending, so a retry can succeed.
  if (order.status !== "pending") return { ...order, grantsEntitlement: false };

  switch (event) {
    case "succeeded":
      return { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true };
    case "failed":
      return { status: "pending", paymentStatus: "failed", grantsEntitlement: false };
    case "cancelled":
      return { status: "cancelled", paymentStatus: "cancelled", grantsEntitlement: false };
  }
}
