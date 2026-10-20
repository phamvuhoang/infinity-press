"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import type { BookActionErrorCode } from "@/lib/catalog/action-error";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createBundleOrder } from "@/lib/commerce/orders";
import { defaultLocale, isLocale, type Locale, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export here is an async function: a "use server" module's non-function exports
// typecheck and build cleanly while crashing the client at request time.

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Bound arguments come back from the browser, so the slug is checked before it becomes a path.
function bundlePath(locale: Locale, slug: string): string {
  return slugPattern.test(slug) ? getCatalogRoutes(locale).bundle(slug) : getLocaleRoutes(locale).books;
}

function bundleErrorPath(locale: Locale, slug: string, code: BookActionErrorCode): string {
  return slugPattern.test(slug) ? getCommerceRoutes(locale).bundleActionError(slug, code) : getLocaleRoutes(locale).books;
}

// The same codes a book's Buy uses, so one dictionary block localizes both. EB027 arrives here as
// NotPurchasableError, which is exactly what it means for a reader.
function buyErrorCode(error: unknown): BookActionErrorCode {
  if (error instanceof EmailNotVerifiedError) return "email-not-verified";
  if (error instanceof PaymentsDisabledError) return "payments-unavailable";
  if (error instanceof NotPurchasableError) return "not-purchasable";
  return "unexpected";
}

// The signed-in Buy form on the bundle page (S9 spec 6.3). It always ends in a redirect: checkout
// on success, the library when there is nothing left to buy, or the bundle page with a stable error
// code. redirect() stays outside the try block, because it throws a control-flow value Next.js has
// to see propagate uncaught.
export async function buyBundleAction(locale: string, bundleId: string, slug: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bundleId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bundlePath(locale, slug));

  let destination: string;
  try {
    const { orderId } = await createBundleOrder(locale, bundleId);
    destination = getCommerceRoutes(locale).checkout(orderId);
  } catch (error) {
    if (error instanceof AlreadyOwnedError) {
      // A bundle is never opened - its books are - so owning all of it leads to the library rather
      // than to a reader route that has nothing to show for a bundle.
      destination = getLocaleRoutes(locale).library;
    } else {
      const code = buyErrorCode(error);
      if (code === "unexpected") {
        console.error("Buy bundle failed.", { bundleId, requestId: getRequestId(await headers()), error: String(error) });
      }
      destination = bundleErrorPath(locale, slug, code);
    }
  }
  redirect(destination);
}
