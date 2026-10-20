import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SubmitButton } from "@/components/auth/submit-button";
import { CoverImage } from "@/components/catalog/cover-image";
import { CouponForm } from "@/components/commerce/coupon-form";
import { GiftForm } from "@/components/commerce/gift-form";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { checkoutAmounts, singleBookOf } from "@/lib/commerce/checkout-view";
import { getMyOrderGift } from "@/lib/commerce/gifts";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate, fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

import { payOrderAction } from "./actions";
import { applyCouponAction, removeCouponAction } from "./coupon-actions";
import { removeGiftAction, saveGiftAction } from "./gift-actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

// Checkout for one pending ebook order (S3 spec 5.2 step 2). There are no shipping fields. The total
// is the order's server-side snapshot.
export default async function CheckoutPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  const user = await requireUser(locale, commerce.checkout(orderId));
  const env = getServerEnv();
  if (!arePaymentsEnabled(env)) notFound();

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));
  // Pay refuses an order booked under another provider, so rendering the button here would leave it
  // existing only to bounce the reader. The same redirect the action makes, made one step earlier -
  // and the status page is where that order is explained. The already-owned branch below keeps its
  // precedence: a reader who holds the book should be told so, not told about the provider.
  if (!order.hasAllActiveEntitlements && order.provider !== env.paymentProvider) {
    redirect(commerce.checkoutStatus(order.id));
  }

  // The gift read goes through get_my_order_gift, which answers from public.gift_summaries - a view
  // with no claim_token_hash column at all. There is no direct `gifts` select anywhere on this page.
  const [dictionary, cards, gift] = await Promise.all([getDictionary(locale), getBookCards(locale), getMyOrderGift(locale, order.id)]);
  const copy = dictionary.checkout;
  const bundleCopy = dictionary.catalog.bundle;
  const singleBook = singleBookOf(order);
  // Only ever consulted on the single-book branch below, which is the only one that renders a
  // cover: a bundle is named by its own snapshot, not by one member's card.
  const card = singleBook ? cards.find((candidate) => candidate.bookId === singleBook.bookId) : undefined;
  // The charged amount is the order's own snapshot. Re-resolving an offer here could quote a price
  // the reader will not be charged: the public bundle page picks the cheapest offer while
  // create_bundle_order picks the alphabetically-first market, and for a multi-market bundle those
  // two disagree.
  const amounts = checkoutAmounts(order);
  const ownedCount = order.items.filter((item) => item.hasActiveEntitlement).length;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[48rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-10 text-[0.9375rem] text-ink-soft">{copy.description}</p>

        {order.bundleId ? (
          // A bundle is bought as one thing, so it is shown as one thing: its own name, how many
          // books it holds, and a compact ordered list of them in the order the shop sells them in.
          // Every member is named - the reader is paying for all of them.
          <section aria-labelledby="checkout-subject" className="border-y border-hairline py-6">
            <h2 className="font-serif text-2xl leading-tight" id="checkout-subject">
              {order.title}
            </h2>
            <p className="mt-1 text-sm text-sage-text">
              {fillCountTemplate(locale, order.items.length, {
                one: bundleCopy.itemCountOne,
                other: bundleCopy.itemCountOther,
              })}
            </p>
            <ol aria-label={bundleCopy.includes} className="mt-4 space-y-1.5">
              {order.items.map((item) => (
                <li className="min-w-0 text-[0.9375rem] [overflow-wrap:anywhere]" key={item.bookId}>
                  {item.title}
                </li>
              ))}
            </ol>
            {/* Partial ownership is stated, never acted on: a bundle price is not prorated (spec 5),
                so the reader still pays what the bundle costs and still gains the rest. */}
            {ownedCount > 0 && !order.hasAllActiveEntitlements ? (
              <p className="mt-4 text-sm text-sage-text">
                {fillTemplate(bundleCopy.ownedSome, { owned: ownedCount, total: order.items.length })}
              </p>
            ) : null}
          </section>
        ) : (
          <section aria-label={order.title} className="grid grid-cols-[5rem_1fr] gap-6 border-y border-hairline py-6 sm:grid-cols-[7rem_1fr]">
            <CoverImage
              card={card ?? { bookId: order.items[0].bookId, title: order.title, author: { name: "", slug: null }, cover: null }}
              decorative
              size="sm"
              sizes="7rem"
            />
            <div className="min-w-0 space-y-2">
              <p className="font-serif text-2xl leading-tight">{order.title}</p>
              {card ? <p className="text-sm text-ink-soft">{card.author.name}</p> : null}
              <p className="text-sm text-sage-text">{dictionary.catalog.book.format}</p>
            </div>
          </section>
        )}

        <dl className="mt-6 space-y-3 text-[0.9375rem]">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="text-ink-soft">{copy.account}</dt>
            <dd className="min-w-0 break-all">{user.email}</dd>
          </div>
          {amounts.hasDiscount ? (
            <>
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-hairline pt-3">
                <dt className="text-ink-soft">{copy.coupon.subtotal}</dt>
                <dd>{formatPrice(amounts.subtotalMinor, order.currency, locale)}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                <dt className="text-ink-soft">{copy.coupon.discount}</dt>
                <dd>−{formatPrice(amounts.discountMinor, order.currency, locale)}</dd>
              </div>
            </>
          ) : null}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline pt-3">
            <dt className="font-medium">{copy.total}</dt>
            <dd className="text-xl font-medium">{formatPrice(amounts.totalMinor, order.currency, locale)}</dd>
          </div>
        </dl>

        {order.hasAllActiveEntitlements ? null : (
          <>
            {/* Before the coupon and before Pay, deliberately: a 100% coupon completes the order
                the moment it is applied (S8 spec 5.4), so a gift arranged after that point would be
                arranged on an order that has already finished. */}
            <GiftForm
              copy={copy.gift}
              gift={gift}
              // A reported transfer is the point of no return for the purchaser's own edits:
              // configure_gift and remove_gift both refuse the order from there on.
              locked={order.claimedAt !== null}
              removeAction={removeGiftAction.bind(null, locale, order.id)}
              saveAction={saveGiftAction.bind(null, locale, order.id)}
            />
            <CouponForm
              appliedCode={amounts.couponCode}
              applyAction={applyCouponAction.bind(null, locale, order.id)}
              copy={copy.coupon}
              removeAction={removeCouponAction.bind(null, locale, order.id)}
            />
          </>
        )}

        <div className="mt-8 space-y-4">
          {/* hasAllActiveEntitlements, never items[0]: owning one book of three leaves two to buy,
              and a reader in that position must still see Pay. Only owning the whole order replaces
              it - with the library, because a bundle has no single book to open. */}
          {order.hasAllActiveEntitlements ? (
            <>
              <p role="status">{order.bundleId ? bundleCopy.ownedAll : copy.alreadyOwned}</p>
              <Button
                render={
                  <Link href={singleBook ? getCatalogRoutes(locale).read(singleBook.bookId) : getLocaleRoutes(locale).library} />
                }
                size="lg"
              >
                {singleBook ? copy.readNow : bundleCopy.library}
              </Button>
            </>
          ) : (
            <>
              {order.paymentStatus === "failed" ? (
                <p className="text-sm text-error" role="alert">
                  {copy.previousFailed}
                </p>
              ) : null}
              <form action={payOrderAction.bind(null, locale, order.id)}>
                <SubmitButton className="w-full sm:w-auto" pendingLabel={copy.paying} size="lg">
                  {copy.pay}
                </SubmitButton>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
