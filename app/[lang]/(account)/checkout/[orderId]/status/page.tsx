import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusAutoRefresh } from "@/components/commerce/status-auto-refresh";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { checkoutStatusView, editionLanguageLabel, readHrefOf, singleBookOf } from "@/lib/commerce/checkout-view";
import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate, fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ lang: string; orderId: string }>;
};

// Order status after a payment attempt (S3 spec 5.2 step 5). Everything shown comes from the database.
export default async function CheckoutStatusPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutStatus(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const copy = dictionary.checkout.status;
  const catalog = getCatalogRoutes(locale);
  const routes = getLocaleRoutes(locale);
  // A single-book order's card, used for the cover-less "back to the book" link below. A bundle
  // order has no single book to go back to, so it keeps the books index.
  const singleBook = singleBookOf(order);
  const card = singleBook ? cards.find((candidate) => candidate.bookId === singleBook.bookId) : undefined;
  // This page is where every provider-specific surface sends a reader whose order it cannot serve,
  // so it is the one that has to explain a still-pending order the active provider cannot settle.
  // Nothing here links onward to such a provider's pages, which is what keeps the redirect into
  // this page from becoming a loop back out of it.
  //
  // Payments being off is a separate case from the order being booked under the other provider, and
  // must not borrow its copy: "start a new order from the book page" is advice nobody can act on
  // while payments are disabled, because create_edition_order refuses every order (EB011). Their
  // order is not stale, it is waiting on us.
  const env = getServerEnv();
  const paymentsOff = order.status === "pending" && !arePaymentsEnabled(env);
  const stale = order.status === "pending" && arePaymentsEnabled(env) && order.provider !== env.paymentProvider;
  // A manual order has no "processing" moment - it is either waiting on the reader, waiting on us,
  // or resolved - so it branches on resolveManualTransferState instead of checkoutStatusView. Every
  // other provider keeps the S3 view untouched. `declined` is its own view rather than the S3
  // `failed` one: spec 6.2 requires the admin's own reason here, and the generic "you can try
  // again" copy says nothing about a transfer we told the reader we could not find.
  const baseView = paymentsOff
    ? "paymentsOff"
    : stale
      ? "unavailable"
      : order.provider === "manual"
        ? (
          {
            confirmed: "success",
            cancelled: "cancelled",
            declined: "declined",
            awaiting_confirmation: "awaiting_confirmation",
            awaiting_transfer: "awaiting_transfer",
          } as const
        )[
          resolveManualTransferState({
            orderStatus: order.status,
            paymentStatus: order.paymentStatus,
            claimedAt: order.claimedAt,
            declinedAt: order.declinedAt,
          })
        ]
      : checkoutStatusView(order);
  const view = baseView;
  // S9. A gift purchaser deliberately receives no access: apply_payment_event routes a gift order
  // through activate_order_gift and grants the buyer nothing. So on a completed gift order the
  // reader owns none of its books, which is exactly what hasAllActiveEntitlements reports - no
  // gift query is needed to tell this case apart. Saying "your ebook is ready in your library"
  // here, and offering a library button, would both be false.
  //
  // This decides COPY only. The `Read now` gate below and /account/orders' `canRead` are the
  // access controls and stay as they are.
  const giftSuccess = order.status === "completed" && !order.hasAllActiveEntitlements;
  const content = {
    success: giftSuccess
      ? { title: copy.successGiftTitle, body: copy.successGiftBody }
      : { title: copy.successTitle, body: copy.successBody },
    failed: { title: copy.failedTitle, body: copy.failedBody },
    // A decline always carries a reason - reject_manual_payment requires a non-empty one - so the
    // fallback is for a row this page could not read, not for a decline made without one.
    declined: order.declineReason
      ? { title: copy.declinedTitle, body: fillTemplate(copy.declinedBody, { reason: order.declineReason }) }
      : { title: copy.failedTitle, body: copy.failedBody },
    unavailable: { title: copy.unavailableTitle, body: copy.unavailableBody },
    paymentsOff: { title: copy.paymentsOffTitle, body: copy.paymentsOffBody },
    processing: { title: copy.processingTitle, body: copy.processingBody },
    cancelled: { title: copy.cancelledTitle, body: copy.cancelledBody },
    awaiting_transfer: { title: copy.awaitingTransferTitle, body: copy.awaitingTransferBody },
    awaiting_confirmation: { title: copy.awaitingConfirmationTitle, body: copy.awaitingConfirmationBody },
  }[view];

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{content.title}</h1>
        <p
          className="text-[0.9375rem] text-ink-soft"
          role={view === "processing" || view === "awaiting_confirmation" ? "status" : undefined}
        >
          {content.body}
        </p>
        {/* The order's own name - the bundle snapshot for a bundle, the book's title for a book -
            and, for a bundle, how many books it holds. Never the first member's title standing in
            for the whole purchase. */}
        <div className="mt-6 border-y border-hairline py-4">
          <p className="font-serif text-xl">{order.title}</p>
          {!order.bundleId && editionLanguageLabel(order.items[0].languageCode) ? (
            <p className="mt-1 text-sm text-sage-text">{editionLanguageLabel(order.items[0].languageCode)}</p>
          ) : null}
          {order.bundleId ? (
            <p className="mt-1 text-sm text-sage-text">
              {fillCountTemplate(locale, order.items.length, {
                one: dictionary.catalog.bundle.itemCountOne,
                other: dictionary.catalog.bundle.itemCountOther,
              })}
            </p>
          ) : null}
        </div>

        <div className="mt-8 flex flex-wrap gap-4">
          {/* "Read now" needs one book to open, so it is offered only for a single-book order. A
              completed bundle order keeps the library button below, which is where all of its books
              now are. */}
          {view === "success" && singleBook && order.hasAllActiveEntitlements ? (
            <Button render={<Link href={readHrefOf(locale, singleBook)} />} size="lg">
              {dictionary.checkout.readNow}
            </Button>
          ) : null}
          {/* No library link on a gift order: the books are not there, and never will be. */}
          {view === "success" && !giftSuccess ? (
            <Button render={<Link href={routes.library} />} size="lg" variant="outline">
              {copy.library}
            </Button>
          ) : null}
          {view === "failed" || view === "declined" ? (
            <Button
              render={<Link href={order.provider === "manual" ? commerce.checkoutTransfer(order.id) : commerce.checkout(order.id)} />}
              size="lg"
            >
              {order.provider === "manual" ? copy.transferInstructions : copy.tryAgain}
            </Button>
          ) : null}
          {view === "processing" ? (
            <>
              <StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />
              <Button render={<Link href={commerce.checkoutStatus(order.id)} />} size="lg" variant="outline">
                {copy.checkAgain}
              </Button>
            </>
          ) : null}
          {view === "awaiting_transfer" ? (
            <Button render={<Link href={commerce.checkoutTransfer(order.id)} />} size="lg">
              {copy.transferInstructions}
            </Button>
          ) : null}
          {view === "awaiting_confirmation" ? (
            <>
              <StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />
              <Button render={<Link href={commerce.checkoutStatus(order.id)} />} size="lg" variant="outline">
                {copy.checkAgain}
              </Button>
            </>
          ) : null}
          {view === "cancelled" || view === "unavailable" || view === "paymentsOff" ? (
            <Button render={<Link href={card ? catalog.book(card.slug) : routes.books} />} size="lg" variant="outline">
              {copy.backToBook}
            </Button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
