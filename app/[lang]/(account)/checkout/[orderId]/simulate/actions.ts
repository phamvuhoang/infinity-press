"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import {
  buildSimulatedEventRequest,
  buildSimulatedEvents,
  isSimulatedOutcome,
  isSimulatorCheckoutEnabled,
} from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function (see the "use server" note in the checkout actions).

// One simulator button (S3 spec 5.2 step 4). It builds the signed events a provider would send and
// delivers them in-process through the webhook handler (spec 4.7). The status page then reads the
// outcome from the database; this action never sets order state itself.
export async function simulatePaymentAction(locale: string, orderId: string, outcome: string): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  const ordersPath = getLocaleRoutes(locale).orders;
  await requireUser(locale, commerce.checkoutSimulate(orderId));

  const env = getServerEnv();
  if (!isSimulatorCheckoutEnabled(env) || !env.simulatorSecret || !isSimulatedOutcome(outcome)) redirect(ordersPath);

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(ordersPath);

  // Matches the simulate page (404s for non-pending orders) and Pay (refuses owned books): a finished
  // or already-owned order gets no simulated event, only the status page. An order booked under
  // another provider is refused for a harder reason: apply_payment_event now raises EB016 for it
  // (20260922180000), and before that guard existed a simulator event against a manual order
  // created a second payments row and granted an entitlement sourced from the wrong provider.
  if (order.status !== "pending" || order.hasAllActiveEntitlements || order.provider !== "simulator") {
    redirect(commerce.checkoutStatus(order.id));
  }

  const requestId = getRequestId(await headers());
  const events = buildSimulatedEvents(order, outcome, `sim_evt_${crypto.randomUUID()}`, new Date());
  for (const event of events) {
    const response = await handleSimulatorWebhook(buildSimulatedEventRequest(event, env.simulatorSecret, requestId));
    if (!response.ok) {
      console.error("Simulated payment delivery failed.", { requestId, orderId: order.id, status: response.status });
      break;
    }
  }

  redirect(commerce.checkoutStatus(order.id));
}
