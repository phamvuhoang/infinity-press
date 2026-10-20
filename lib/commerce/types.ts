import type { Locale } from "@/lib/i18n/config";

// Provider-neutral commerce contracts. Nothing in lib/access/grant.ts or apply_payment_event knows a
// specific provider - only this shape, produced once a request has been verified. A real provider
// later implements the same interface with its own signature check.
export type VerifiedPaymentEvent = {
  provider: string;
  eventId: string;
  externalPaymentId: string;
  orderId: string;
  status: "succeeded" | "failed" | "cancelled";
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

export type CheckoutSessionInput = { orderId: string; locale: Locale };

export interface PaymentProvider {
  // Where Pay sends the reader. A redirect back from this URL never changes order state (S3 spec 4.8).
  createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }>;
  verifyEvent(request: Request): Promise<VerifiedPaymentEvent>;
}
