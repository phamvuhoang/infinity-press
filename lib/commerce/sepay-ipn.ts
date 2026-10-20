import "server-only";

import { applyVerifiedPaymentEvent, findPaymentExternalId } from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { recordPaymentOutcome } from "@/lib/commerce/payment-outcome";
import {
  InvalidSepaySecretError,
  MalformedSepayNotificationError,
  SepayNotificationIgnoredError,
  SepayOrderNotFoundError,
  SepayProvider,
} from "@/lib/commerce/sepay";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getServerEnv } from "@/lib/config/server-env";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";

function respond(status: number, body: Record<string, unknown>, requestId: string): Response {
  return Response.json({ ...body, requestId }, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}

// SePay's payment notification (S18 spec 6). The only path by which a SePay order completes.
//
// It answers whenever SePay credentials are configured, not only while PAYMENT_PROVIDER=sepay: a
// reader can be on SePay's page when an operator switches providers, and their payment must still
// settle while the order remains pending. A stale-order cancellation is preserved and flagged
// for manual resolution. apply_payment_event checks the booked provider (EB016).
//
// 200 tells SePay the notification is dealt with. 422 means SePay took money this application could
// not attach to an order; it is logged with everything an operator needs to find it.
export async function handleSepayIpn(request: Request): Promise<Response> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();
  if (!env.sepay) {
    console.warn("SePay IPN received, but SePay is not configured.", { requestId });
    return respond(404, { error: "not_found" }, requestId);
  }

  let verified: VerifiedPaymentEvent & { invoiceNumber: string };
  try {
    verified = await new SepayProvider(env.sepay).verifyEvent(request);
  } catch (error) {
    if (error instanceof InvalidSepaySecretError) {
      console.warn("SePay IPN rejected: bad secret.", { requestId });
      return respond(401, { error: "unauthorized" }, requestId);
    }
    if (error instanceof MalformedSepayNotificationError) {
      // Authenticated, so this may be a real payment the parser refused: the identifiers are the
      // only trail an operator has to it.
      console.error("SePay IPN rejected: malformed. A payment may need a manual grant.", {
        requestId,
        reason: error.message,
        ...error.hints,
      });
      return respond(400, { error: "malformed_event" }, requestId);
    }
    if (error instanceof SepayNotificationIgnoredError) {
      console.warn("SePay IPN acknowledged without action.", { requestId, reason: error.reason });
      return respond(200, { success: true }, requestId);
    }
    if (error instanceof SepayOrderNotFoundError) {
      console.error("SePay IPN names no order. A payment may need a refund.", {
        requestId,
        invoiceNumber: error.invoiceNumber,
        externalPaymentId: error.externalPaymentId,
      });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("SePay IPN could not be verified.", { requestId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }

  // Only the provider-neutral fields go on: the invoice number is for the logs below.
  const { invoiceNumber, ...event } = verified;
  try {
    const outcome = await applyVerifiedPaymentEvent(event);
    if (outcome.orderStatus === "cancelled") {
      // The RPC records the event but intentionally preserves the cancelled order.
      // Preserve payment details in the operational log on first delivery AND retries.
      console.error("SePay IPN paid a cancelled order. Manual resolution required.", {
        requestId,
        orderId: event.orderId,
        eventId: event.eventId,
        invoiceNumber,
        externalPaymentId: event.externalPaymentId,
        amountMinor: event.amountMinor,
        currency: event.currency,
      });
      return respond(422, { error: "manual_resolution_required" }, requestId);
    }
    // A completed order applies nothing from a later event (the RPC records it and returns the order
    // as it stands), so a different SePay order paid against it - a repriced invoice and the old QR
    // both paid - looks exactly like a repeat. The payment row holds the SePay order that completed
    // it: the same one is a repeat, a different one is a second payment to resolve by hand.
    if (outcome.orderStatus === "completed") {
      const recorded = await findPaymentExternalId(event.orderId, event.provider);
      if (recorded !== null && recorded !== event.externalPaymentId) {
        console.error("SePay IPN paid an order that was already completed by another payment. Manual resolution required.", {
          requestId,
          orderId: event.orderId,
          eventId: event.eventId,
          invoiceNumber,
          externalPaymentId: event.externalPaymentId,
          recordedExternalPaymentId: recorded,
          amountMinor: event.amountMinor,
          currency: event.currency,
        });
        return respond(422, { error: "manual_resolution_required" }, requestId);
      }
    }
    await recordPaymentOutcome(event, outcome, requestId);
    return respond(200, { success: true, orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus }, requestId);
  } catch (error) {
    if (error instanceof PaymentEventRejectedError) {
      console.error("SePay IPN does not match its order. A payment may need a refund or a manual grant.", {
        requestId,
        orderId: event.orderId,
        eventId: event.eventId,
        invoiceNumber,
        externalPaymentId: event.externalPaymentId,
        amountMinor: event.amountMinor,
      });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("SePay IPN failed.", { requestId, orderId: event.orderId, eventId: event.eventId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }
}
