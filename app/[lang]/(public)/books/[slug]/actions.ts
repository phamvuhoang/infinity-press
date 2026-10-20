"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { acquireFreeOffer, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth/session";
import type { BookActionErrorCode } from "@/lib/catalog/action-error";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createEbookOrder } from "@/lib/commerce/orders";
import { getCurrentProfile } from "@/lib/data/profiles";
import { defaultLocale, isLocale, type Locale, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function, on purpose - see Task 2's "use server"
// hazard: a plain-object or non-function export from a "use server" module typechecks, lints,
// and builds cleanly while crashing the client at request time. Only type exports are safe
// alongside them.

// Stable codes, not prose: this is a customer-facing surface (unlike the admin actions
// elsewhere in this task, which stay English-only by design), and the repo's established
// pattern (components/auth/auth-message.tsx, dictionary key auth.alerts.errors.<code>) maps a
// code to localized copy at render time. No page consumes this action yet, but returning an
// already-rendered English string here would make that string reachable from a page that just
// renders `result.error` directly - the exact failure mode a code makes impossible.
export type AcquireFreeEbookErrorCode = "invalid-locale" | "email-not-verified" | "no-free-offer" | "unexpected";

export type AcquireFreeEbookResult =
  | { ok: true; entitlementId: string }
  | { ok: false; error: AcquireFreeEbookErrorCode };

function toActionResult(error: unknown): Extract<AcquireFreeEbookResult, { ok: false }> {
  if (error instanceof EmailNotVerifiedError) return { ok: false, error: "email-not-verified" };
  if (error instanceof NoFreeOfferError) return { ok: false, error: "no-free-offer" };
  return { ok: false, error: "unexpected" };
}

// bookId, not the route's own slug: whichever page calls this action already resolved the slug
// to a book id (matching lib/data/publications.ts's asset-id/publication-id split), so this
// action never has to re-resolve it itself.
//
// requireUser() runs here, outside the try/catch, matching every admin action's own
// requireAdmin() call (e.g. app/admin/publications/[publicationId]/actions.ts): an anonymous
// visitor is redirected to sign in via next/navigation's redirect(), which throws a special
// NEXT_REDIRECT value Next.js itself has to see propagate uncaught - catching it below and
// mapping it through toActionResult() would silently swallow the redirect. acquireFreeOffer()
// still calls requireUser() again internally, as its own library-boundary guarantee independent
// of this caller; the second call is a cache() hit, not a second gate.
export async function acquireFreeEbookAction(locale: string, bookId: string): Promise<AcquireFreeEbookResult> {
  if (!isLocale(locale)) {
    return { ok: false, error: "invalid-locale" };
  }

  await requireUser(locale);

  try {
    const { entitlementId } = await acquireFreeOffer(locale, bookId);
    // Task 7 review, Minor 12: acquiring a book adds a library_items row, so the reader's library
    // is stale the moment this returns. Every admin mutation in this repo revalidates the page it
    // changed; this is the customer-facing equivalent, and it is only wireable now that
    // /[lang]/library actually renders that data.
    revalidatePath(withLocale(locale, "/library"));
    return { ok: true, entitlementId };
  } catch (error) {
    const result = toActionResult(error);
    if (result.error === "unexpected") {
      console.error("Get free ebook failed.", { bookId, requestId: getRequestId(await headers()), error: String(error) });
    }
    return result;
  }
}

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
  if (error instanceof PaymentsDisabledError) return "payments-unavailable";
  if (error instanceof NotPurchasableError) return "not-purchasable";
  return "unexpected";
}

// The signed-in Get free form (S3 spec 5.1). It always ends in a redirect: the reader on success, or
// the book page with a stable error code.
export async function getFreeEbookAction(locale: string, bookId: string, slug: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bookId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bookPath(locale, slug));

  const result = await acquireFreeEbookAction(locale, bookId);
  if (!result.ok) {
    redirect(bookErrorPath(locale, slug, result.error === "invalid-locale" ? "unexpected" : result.error));
  }
  redirect(getCatalogRoutes(locale).read(bookId));
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

// The signed-in Buy form (S3 spec 5.2). redirect() stays outside the try block, because it throws a
// control-flow value Next.js must see.
export async function buyEbookAction(locale: string, bookId: string, slug: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bookId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bookPath(locale, slug));

  let destination: string;
  let orderId: string | null = null;
  try {
    ({ orderId } = await createEbookOrder(locale, bookId));
    destination = getCommerceRoutes(locale).checkout(orderId);
  } catch (error) {
    if (error instanceof AlreadyOwnedError) {
      destination = getCatalogRoutes(locale).read(bookId);
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
