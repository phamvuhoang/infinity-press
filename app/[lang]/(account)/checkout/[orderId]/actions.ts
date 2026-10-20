"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { arePaymentsEnabled, getPaymentProvider } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

// Every runtime export below is an async function: a non-function export from a "use server" module
// builds cleanly and then crashes the client at request time.

// Pay (S3 spec 5.2 step 3). It re-checks ownership, pending state, and existing access, then hands
// the reader to the provider. Returning from the provider never changes the order; only a verified
// payment event does.
export async function payOrderAction(locale: string, orderId: string): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  const ordersPath = getLocaleRoutes(locale).orders;
  await requireUser(locale, commerce.checkout(orderId));

  const env = getServerEnv();
  if (!arePaymentsEnabled(env)) redirect(ordersPath);

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(ordersPath);
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));
  if (order.hasAllActiveEntitlements) redirect(commerce.checkout(order.id));
  // The order's own provider, not just the environment's. An order is booked under the provider
  // that was active when it was created, and nothing moves it afterwards: create_ebook_order
  // cancels and replaces a mismatched pending order, but only for a reader who comes back through
  // Buy. One reaching this action from order history would otherwise be handed to a provider that
  // cannot settle their order - shown the company's bank account for an order no manual surface
  // will ever see, or sent to a simulator page for an order booked for a bank transfer. The status
  // page explains the order instead.
  if (order.provider !== env.paymentProvider) redirect(commerce.checkoutStatus(order.id));

  const { redirectUrl } = await getPaymentProvider(env).createSession({ orderId: order.id, locale });
  redirect(redirectUrl);
}
