import "server-only";

import { applyVerifiedPaymentEvent } from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { recordPaymentOutcome } from "@/lib/commerce/payment-outcome";
import { getPaymentProvider } from "@/lib/commerce/payment-provider";
import {
  InvalidSimulatorSignatureError,
  isSimulatorAllowedEnvironment,
  isSimulatorCheckoutEnabled,
  MalformedSimulatedEventError,
} from "@/lib/commerce/simulator";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getServerEnv } from "@/lib/config/server-env";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";

function respond(status: number, body: Record<string, unknown>, requestId: string): Response {
  return Response.json({ ...body, requestId }, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}

// The one entry point for a simulated payment event (S3 spec 4.7). The webhook route and the simulate
// page's Server Action both call it, so a click and a network delivery take the same path:
// verifyEvent checks the HMAC signature, then apply_payment_event decides the outcome. Responses never
// carry database text; logs carry the request ID.
export async function handleSimulatorWebhook(request: Request): Promise<Response> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();
  if (!isSimulatorCheckoutEnabled(env)) {
    const reason = isSimulatorAllowedEnvironment(env.appEnv) ? "provider" : "environment";
    console.warn("Simulator webhook is disabled.", { requestId, reason });
    return respond(404, { error: "not_found" }, requestId);
  }

  let event: VerifiedPaymentEvent;
  try {
    event = await getPaymentProvider(env).verifyEvent(request);
  } catch (error) {
    if (error instanceof InvalidSimulatorSignatureError) {
      console.warn("Simulator webhook rejected a signature.", { requestId });
      return respond(401, { error: "invalid_signature" }, requestId);
    }
    if (error instanceof MalformedSimulatedEventError) {
      console.warn("Simulator webhook received a malformed event.", { requestId });
      return respond(400, { error: "malformed_event" }, requestId);
    }
    console.error("Simulator webhook could not verify an event.", { requestId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }

  try {
    const outcome = await applyVerifiedPaymentEvent(event);
    await recordPaymentOutcome(event, outcome, requestId);
    return respond(200, { orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus }, requestId);
  } catch (error) {
    if (error instanceof PaymentEventRejectedError) {
      console.warn("Simulator webhook rejected an event.", { requestId, orderId: event.orderId, eventId: event.eventId });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("Simulator webhook failed.", { requestId, orderId: event.orderId, eventId: event.eventId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }
}
