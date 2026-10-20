import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";

// Manual transfers add no order_status or payment_status value (spec 5.4). Adding one would reopen
// the S3 transition table and its pgTAP mirror for a distinction that only ever changes a label, so
// the five reader-facing states are derived here instead.
export type ManualTransferState =
  | "awaiting_transfer"
  | "awaiting_confirmation"
  | "confirmed"
  | "declined"
  | "cancelled";

function instant(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// A decline and a claim are compared by recency, not by precedence. reject_manual_payment leaves
// payment_status = 'failed' permanently and nothing ever resets it, so "failed wins" meant a reader
// who transferred again and pressed the button again kept seeing the decline banner and the report
// button - never "we have your report" - on the one screen the runbook tells them to use as many
// times as it takes. A report made after the latest decline is news that decline cannot speak to.
//
// A tie counts as answered: reject_manual_payment deletes the claim in the same transaction that
// writes the decline, so a claim not strictly newer than the decline is the one it already saw.
export function resolveManualTransferState(input: {
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  claimedAt: string | null;
  declinedAt: string | null;
}): ManualTransferState {
  if (input.orderStatus === "completed") return "confirmed";
  if (input.orderStatus === "cancelled") return "cancelled";
  const claimedAt = instant(input.claimedAt);
  const declinedAt = instant(input.declinedAt);
  const claimIsCurrent = claimedAt !== null && (declinedAt === null || claimedAt > declinedAt);
  if (input.paymentStatus === "failed" && !claimIsCurrent) return "declined";
  return claimedAt !== null ? "awaiting_confirmation" : "awaiting_transfer";
}
