"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { acquireFreeEdition, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth/session";
import type { BookActionErrorCode } from "@/lib/catalog/action-error";
import {
  AlreadyOwnedError,
  CurrencyNotPayableError,
  EditionRequiredError,
  NotPurchasableError,
  OfferChangedError,
  PaymentsDisabledError,
} from "@/lib/commerce/errors";
import { createEditionOrder } from "@/lib/commerce/orders";
import { getCurrentProfile } from "@/lib/data/profiles";
import { defaultLocale, isLocale, type Locale, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function, on purpose - see Task 2's "use server"
// hazard: a plain-object or non-function export from a "use server" module typechecks, lints,
// and builds cleanly while crashing the client at request time. Only type exports are safe
// alongside them.

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Bound arguments come back from the browser, so the slug is checked before it becomes a path.
function bookPath(locale: Locale, slug: string): string {
  return slugPattern.test(slug) ? getCatalogRoutes(locale).book(slug) : getLocaleRoutes(locale).books;
}

function bookErrorPath(locale: Locale, slug: string, code: BookActionErrorCode): string {
  return slugPattern.test(slug) ? getCommerceRoutes(locale).bookActionError(slug, code) : getLocaleRoutes(locale).books;
}

function buyErrorCode(error: unknown): BookActionErrorCode {
  if (error instanceof EmailNotVerifiedError) return "email-not-verified";
  if (error instanceof NoFreeOfferError) return "no-free-offer";
  if (error instanceof PaymentsDisabledError) return "payments-unavailable";
  if (error instanceof NotPurchasableError) return "not-purchasable";
  if (error instanceof CurrencyNotPayableError) return "currency-unavailable";
  if (error instanceof EditionRequiredError) return "choose-edition";
  if (error instanceof OfferChangedError) return "price-changed";
  return "unexpected";
}

// The signed-in Get free form (S3 spec 5.1), per edition: the reader gets THE edition they were
// looking at, never "the book". It always ends in a redirect: the reader on success, or the book page
// with a stable error code.
export async function getFreeEbookAction(locale: string, bookId: string, slug: string, editionId: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bookId) || !uuidPattern.test(editionId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bookPath(locale, slug));

  try {
    await acquireFreeEdition(locale, editionId);
    // The reader's library is stale the moment this returns; the customer-facing counterpart of the
    // admin mutations' revalidation.
    revalidatePath(withLocale(locale, "/library"));
  } catch (error) {
    const code = buyErrorCode(error);
    if (code === "unexpected") {
      console.error("Get free ebook failed.", { bookId, requestId: getRequestId(await headers()), error: String(error) });
    }
    redirect(bookErrorPath(locale, slug, code));
  }
  redirect(getCatalogRoutes(locale).readEdition(editionId));
}

// begin_checkout for an order that now exists (S5 spec 8.1). The order ID is the dedupe key, so the
// reuse of an open order by a second Buy click records nothing new. Not exported: a "use server"
// module's exports are callable from the browser, and this must only ever run after a real order.
// It cannot throw - the reader's checkout redirect must not depend on analytics.
async function recordBeginCheckout(locale: Locale, bookId: string, orderId: string): Promise<void> {
  try {
    const profile = await getCurrentProfile().catch(() => null);
    await trackEventBestEffort(
      {
        eventName: "begin_checkout",
        dedupeKey: `checkout/${orderId}`,
        ...(profile ? { profileId: profile.id } : {}),
        bookId,
        orderId,
        locale,
      },
      { requestId: getRequestId(await headers()) },
    );
  } catch {
    // trackEventBestEffort already logs its own failures; anything else here is lost analytics only.
  }
}

// The signed-in Buy form (S3 spec 5.2), per edition. The edition and the offer are named by the page
// the reader was looking at, together with the price they saw: the database validates the whole chain
// and refuses (OfferChangedError) a price that moved, so the reader sees the new price and decides
// again. redirect() stays outside the try block, because it throws a control-flow value Next.js must
// see.
export async function buyEbookAction(
  locale: string,
  bookId: string,
  slug: string,
  editionId: string,
  offerId: string,
  expectedMinor: number,
): Promise<void> {
  if (
    !isLocale(locale) ||
    !uuidPattern.test(bookId) ||
    !uuidPattern.test(editionId) ||
    !uuidPattern.test(offerId) ||
    !Number.isSafeInteger(expectedMinor) ||
    expectedMinor < 0
  ) {
    redirect(withLocale(defaultLocale, "/"));
  }
  await requireUser(locale, bookPath(locale, slug));

  let destination: string;
  let orderId: string | null = null;
  try {
    ({ orderId } = await createEditionOrder(locale, editionId, offerId, expectedMinor));
    destination = getCommerceRoutes(locale).checkout(orderId);
  } catch (error) {
    if (error instanceof AlreadyOwnedError) {
      destination = getCatalogRoutes(locale).readEdition(editionId);
    } else {
      const code = buyErrorCode(error);
      if (code === "unexpected") {
        console.error("Buy ebook failed.", { bookId, requestId: getRequestId(await headers()), error: String(error) });
      }
      destination = bookErrorPath(locale, slug, code);
    }
  }
  // After the order exists and outside the try block above, so an analytics fault can never be
  // mistaken for a failed purchase and turned into an error redirect.
  if (orderId) await recordBeginCheckout(locale, bookId, orderId);
  redirect(destination);
}
