import "server-only";

import type { AppliedPaymentEventOutcome } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";

// Payment analytics from the state apply_payment_event RETURNED, never from the event's own status
// (S5 spec 8.3): a replay or an out-of-order event reports the order as it now stands. Keys are
// deterministic - purchase by order, payment_failed by provider event - so a replay inserts nothing.
// Runs after the payment has committed and cannot throw into the response.
export async function recordPaymentOutcome(
  event: VerifiedPaymentEvent,
  outcome: AppliedPaymentEventOutcome,
  requestId: string,
): Promise<void> {
  try {
    if (outcome.orderStatus === "completed" && outcome.paymentStatus === "succeeded") {
      await trackEventBestEffort(
        { eventName: "purchase", dedupeKey: `purchase/${event.orderId}`, orderId: event.orderId },
        { requestId },
      );
    } else if (outcome.paymentStatus === "failed") {
      await trackEventBestEffort(
        { eventName: "payment_failed", dedupeKey: `payment-failed/${event.eventId}`, orderId: event.orderId },
        { requestId },
      );
    }
  } catch {
    // trackEventBestEffort logs its own failures; the payment result stands either way.
  }
}
