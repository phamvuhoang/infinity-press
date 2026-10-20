"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { readHrefOf, singleBookOf } from "@/lib/commerce/checkout-view";
import {
  CouponRateLimitedError,
  CouponRejectedError,
  OrderNotCouponableError,
  applyCouponToOrder,
  removeCouponFromOrder,
} from "@/lib/commerce/coupon-order";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function: a non-function export from a "use server" module
// builds cleanly and then crashes the client at request time.

// One state per message the checkout page can show (S8 spec 7.1). "invalid" covers every reason a
// code was refused, because saying which one is how a code space gets searched.
export type CouponFormState =
  | { status: "idle" }
  | { status: "applied" }
  | { status: "invalid" }
  | { status: "rateLimited" }
  | { status: "unavailable" };

// The discriminating reason goes here and nowhere else (spec 5.5).
async function logRejection(operation: string, orderId: string, detail: string | null): Promise<void> {
  console.warn("Coupon rejected.", { operation, orderId, detail, requestId: getRequestId(await headers()) });
}

export async function applyCouponAction(
  locale: string,
  orderId: string,
  _previous: CouponFormState,
  formData: FormData,
): Promise<CouponFormState> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkout(orderId));

  const code = String(formData.get("code") ?? "");

  let result;
  try {
    result = await applyCouponToOrder(locale, orderId, code);
  } catch (error) {
    if (error instanceof CouponRateLimitedError) return { status: "rateLimited" };
    if (error instanceof CouponRejectedError) {
      await logRejection("applyCouponAction", orderId, error.detail);
      return { status: "invalid" };
    }
    if (error instanceof OrderNotCouponableError) return { status: "unavailable" };
    throw error;
  }

  revalidatePath(commerce.checkout(orderId));

  // A fully discounted order completed inside the RPC (S8 spec 5.4), so there is nothing left to
  // pay and every book of the order is already in the reader's library. An order holding one book
  // opens it; a bundle has no single book to open, so it goes to the library where all of them now
  // are. The subjects come from the order rather than from the RPC, which returns entitlements.
  if (result.completed) {
    const order = await getCustomerOrder(orderId);
    const singleBook = order ? singleBookOf(order) : null;
    if (singleBook) redirect(readHrefOf(locale, singleBook));
    if (order) redirect(getLocaleRoutes(locale).library);
    redirect(commerce.checkoutStatus(orderId));
  }

  return { status: "applied" };
}

export async function removeCouponAction(
  locale: string,
  orderId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _previous: CouponFormState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- required by useActionState
  _formData: FormData,
): Promise<CouponFormState> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkout(orderId));

  try {
    await removeCouponFromOrder(locale, orderId);
  } catch (error) {
    if (error instanceof OrderNotCouponableError) return { status: "unavailable" };
    throw error;
  }

  revalidatePath(commerce.checkout(orderId));
  return { status: "idle" };
}
