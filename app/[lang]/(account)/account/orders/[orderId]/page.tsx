import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { customerOrderStatus, singleBookOf } from "@/lib/commerce/checkout-view";
import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate, fillTemplate, formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

export default async function OrderPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.order(orderId));

  // Another reader's order is indistinguishable from a missing one.
  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.orders;
  // A manual order only has something to continue while the reader can still act: report a
  // transfer, or retry one we declined. Waiting on our confirmation has nothing left for them to do.
  const manualState =
    order.provider === "manual"
      ? resolveManualTransferState({
          orderStatus: order.status,
          paymentStatus: order.paymentStatus,
          claimedAt: order.claimedAt,
          declinedAt: order.declinedAt,
        })
      : null;
  const env = getServerEnv();
  // An order can only be continued through the provider it was booked under. Offering "continue" for
  // an order booked under the other one would link to a page that turns the reader straight around.
  const providerIsActive = arePaymentsEnabled(env) && order.provider === env.paymentProvider;
  const canContinue =
    order.provider === "manual"
      ? (manualState === "awaiting_transfer" || manualState === "declined") && providerIsActive
      : order.status === "pending" && providerIsActive;
  const continueHref = order.provider === "manual" ? commerce.checkoutTransfer(order.id) : commerce.checkout(order.id);
  // Every book of the order, not one of them: a bundle order opens nothing until the reader holds
  // all of it, and what it opens then is the library.
  const canRead = order.status === "completed" && order.hasAllActiveEntitlements;
  const singleBook = singleBookOf(order);
  // The reader's one navigable route to an order the active provider cannot settle. Without it the
  // status page's explanation was reachable only by redirect or a typed URL: this page has no
  // continue link for such an order, and every provider-specific page turns the reader away. The
  // status label above still says the order is waiting; this is where it says what that means now.
  const showStatusLink = order.status === "pending" && !canContinue;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="account" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "orders")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[40rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.detailEyebrow}</p>
          {/* The order's own name, and for a bundle the number of books under it. A bundle order is
              never named after its first member. */}
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{order.title}</h1>
          <p className="text-sm text-sage-text">
            {order.bundleId
              ? fillCountTemplate(locale, order.items.length, {
                  one: dictionary.catalog.bundle.itemCountOne,
                  other: dictionary.catalog.bundle.itemCountOther,
                })
              : dictionary.catalog.book.format}
          </p>
          <p className="mb-8 text-sm text-sage-text">{fillTemplate(copy.placedOn, { date: formatDate(order.createdAt, locale) })}</p>

          <dl className="space-y-3 border-y border-sand py-4 text-[0.9375rem]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">{copy.total}</dt>
              <dd className="font-medium">{order.totalMinor === 0 ? copy.free : formatPrice(order.totalMinor, order.currency, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">{copy.status}</dt>
              <dd>{copy.statuses[customerOrderStatus(order)]}</dd>
            </div>
          </dl>

          {/* Spec 6.2: order history carries the admin's own reason for a declined transfer, not
              just the "Payment failed" label above. Without it this page said a payment failed and
              left the reader with nothing to act on; with it, the reason and the way back to the
              transfer instructions sit together. */}
          {manualState === "declined" && order.declineReason ? (
            <div className="mt-6 border-b border-sand pb-4" role="alert">
              <p className="font-medium text-error">{copy.declinedTitle}</p>
              <p className="mt-1 text-[0.9375rem] text-ink-soft">
                {fillTemplate(copy.declinedBody, { reason: order.declineReason })}
              </p>
            </div>
          ) : null}

          <div className="mt-8 flex flex-wrap gap-4">
            {canContinue ? (
              <Button render={<Link href={continueHref} />} size="lg">
                {order.provider === "manual" ? copy.transferInstructions : copy.continueCheckout}
              </Button>
            ) : null}
            {showStatusLink ? (
              <Button render={<Link href={commerce.checkoutStatus(order.id)} />} size="lg" variant="outline">
                {copy.viewStatus}
              </Button>
            ) : null}
            {/* A bundle has no single book to open, so it is the library that is offered - and the
                label says so, rather than promising a reader a book it cannot take them to. */}
            {canRead ? (
              <Button
                render={<Link href={singleBook ? getCatalogRoutes(locale).read(singleBook.bookId) : getLocaleRoutes(locale).library} />}
                size="lg"
              >
                {singleBook ? copy.read : dictionary.catalog.bundle.library}
              </Button>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
