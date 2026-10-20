"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { claimManualTransfer } from "@/lib/commerce/manual-payment";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

// Every runtime export below is an async function: a non-function export from a "use server" module
// builds cleanly and then crashes the client at request time.

// The reader reports a transfer (spec 5.5) from the transfer page. It re-checks ownership and
// pending state before writing anything, exactly as payOrderAction does for a fresh checkout.
export async function claimTransferAction(locale: string, orderId: string, formData: FormData): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutTransfer(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(getLocaleRoutes(locale).orders);
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));
  // The reader already has the book - an admin grant, or another order, landed after this one was
  // created. Reporting a transfer against it would have them pay for access they hold, so send them
  // to the checkout page, which is where "you already own this book" and Read now already live.
  // The order itself stays pending: cancelling it is an admin act, and a reader who has already
  // transferred needs the order to survive so that money has somewhere to be recorded.
  if (order.hasAllActiveEntitlements) redirect(commerce.checkout(order.id));
  // This page belongs to the manual provider. An order booked under another one cannot be claimed -
  // claim_manual_transfer raises EB020 for it - so the status page answers instead of a 500.
  if (order.provider !== "manual") redirect(commerce.checkoutStatus(order.id));

  const note = String(formData.get("note") ?? "").trim();
  await claimManualTransfer(locale, order.id, note === "" ? null : note);

  revalidatePath(commerce.checkoutTransfer(order.id));
}
