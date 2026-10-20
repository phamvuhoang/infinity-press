import type { OrderState } from "@/lib/commerce/order-state";
import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";

export type CheckoutStatusView = "success" | "failed" | "processing" | "cancelled";

// What /checkout/[orderId]/status shows (S3 spec 5.2). Read from the database only.
export function checkoutStatusView(order: OrderState): CheckoutStatusView {
  if (order.status === "completed") return "success";
  if (order.status === "cancelled") return "cancelled";
  if (order.paymentStatus === "failed") return "failed";
  return "processing";
}

export type CustomerOrderStatus =
  | "completed"
  | "awaitingPayment"
  | "awaitingTransfer"
  | "awaitingConfirmation"
  | "paymentFailed"
  | "cancelled";

export type CustomerOrderView = OrderState & {
  provider: string | null;
  claimedAt: string | null;
  declinedAt: string | null;
};

// The status label on the reader's order pages (S3 spec 6, extended by S7 spec 5.4). Keys match
// dictionary orders.statuses. Manual orders get their own labels; every other provider keeps the
// S3 labels untouched.
export function customerOrderStatus(order: CustomerOrderView): CustomerOrderStatus {
  if (order.provider === "manual") {
    switch (resolveManualTransferState({
      orderStatus: order.status,
      paymentStatus: order.paymentStatus,
      claimedAt: order.claimedAt,
      declinedAt: order.declinedAt,
    })) {
      case "confirmed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "declined":
        return "paymentFailed";
      case "awaiting_confirmation":
        return "awaitingConfirmation";
      case "awaiting_transfer":
        return "awaitingTransfer";
    }
  }
  switch (checkoutStatusView(order)) {
    case "success":
      return "completed";
    case "failed":
      return "paymentFailed";
    case "processing":
      return "awaitingPayment";
    case "cancelled":
      return "cancelled";
  }
}

export type CheckoutAmounts = {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  hasDiscount: boolean;
  couponCode: string | null;
};

// What the checkout page's money block renders (S8 spec 7.1). The subtotal and discount lines
// appear only when a code is actually on the order, so an ordinary purchase looks exactly as it did
// before S8 - one total, no empty rows suggesting a discount that is not there.
export function checkoutAmounts(order: {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  couponCode: string | null;
}): CheckoutAmounts {
  return {
    subtotalMinor: order.subtotalMinor,
    discountMinor: order.discountMinor,
    totalMinor: order.totalMinor,
    hasDiscount: order.discountMinor > 0 && order.couponCode !== null,
    couponCode: order.couponCode,
  };
}

// The order's one book, or null. Three pages and one Server Action ask this question and each had
// spelled it out for itself; spelled out four times it is four chances to forget one of the two
// halves. Both halves matter: `bundleId === null` because a one-member bundle is still a bundle and
// is never opened as a book, and `items.length === 1` because a multi-line order has no single
// subject to open, name a cover after, or link back to.
export function singleBookOf<Item>(order: { bundleId: string | null; items: Item[] }): Item | null {
  return order.bundleId === null && order.items.length === 1 ? order.items[0] : null;
}
