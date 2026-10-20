import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { SubmitButton } from "@/components/auth/submit-button";
import { CopyReference } from "@/components/commerce/copy-reference";
import { SiteHeader } from "@/components/site-header";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { buildVietQrImageUrl, MANUAL_TRANSFER_CURRENCIES } from "@/lib/commerce/manual";
import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCommerceRoutes } from "@/lib/i18n/routes";

import { claimTransferAction } from "./actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

// Bank transfer instructions for a pending manual-payment order (S7 spec 5.5). Everything a reader
// needs to complete the transfer by hand - bank details, amount, reference - is plain text, so the
// page still works if the VietQR image fails to load or scripts are off.
export default async function CheckoutTransferPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutTransfer(orderId));

  // The order is loaded BEFORE the provider is looked at, and that ordering is the whole point. A
  // reader reaches this page having already sent the money - it is the only place the account
  // number and the reference exist, and re-opening it is exactly what they do when the bank asks
  // for the reference again. Deciding on PAYMENT_PROVIDER first turned the ordinary case of ops
  // flipping that variable mid-transfer into a blank 404 for a reader with money in hand, and left
  // them no route at all: the order detail page offers no link for an order the active provider
  // cannot settle. Only a missing or foreign order 404s here, so ownership still does not leak.
  const order = await getCustomerOrder(orderId);
  if (!order) notFound();
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));
  // Telling a reader who already has the book to transfer money for it is the one outcome this
  // page must never produce. An admin grant, or another order for the same book, can land at any
  // point after this order was created, and the order stays pending when it does - cancelling it
  // is an admin act, and a reader who has already transferred needs it to survive. The checkout
  // page is where "you already own this book" and Read now live, so it answers instead.
  if (order.hasAllActiveEntitlements) redirect(commerce.checkout(order.id));
  // Both halves, and the same answer for either: the order's own provider, because an order booked
  // under the simulator has no bank transfer to make and claim_manual_transfer refuses it (EB020);
  // and this deployment's, because the bank details below come from ITS environment and a server
  // that has left the manual provider has none to show. The status page explains the order.
  const env = getServerEnv();
  if (order.provider !== "manual" || env.paymentProvider !== "manual") redirect(commerce.checkoutStatus(order.id));
  // Nor does a bank transfer settle any currency but dong. No order in another currency is created
  // (create_edition_order refuses it), so reaching here means data we did not write; show no account.
  if (!MANUAL_TRANSFER_CURRENCIES.includes(order.currency)) redirect(commerce.checkoutStatus(order.id));

  const dictionary = await getDictionary(locale);
  const copy = dictionary.checkout.transfer;
  const state = resolveManualTransferState({
    orderStatus: order.status,
    paymentStatus: order.paymentStatus,
    claimedAt: order.claimedAt,
    declinedAt: order.declinedAt,
  });
  const bankTransfer = env.bankTransfer;
  // Null for any currency whose minor units are not its major ones - see buildVietQrImageUrl. The
  // details below stand on their own, so the page simply loses the decoration.
  const qrImageUrl = bankTransfer
    ? buildVietQrImageUrl({
        accountHolder: bankTransfer.accountHolder,
        accountNumber: bankTransfer.accountNumber,
        amountMinor: order.totalMinor,
        bankCode: bankTransfer.bankCode,
        currency: order.currency,
        reference: order.referenceCode,
      })
    : null;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[48rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-10 text-[0.9375rem] text-ink-soft">{copy.description}</p>

        {!bankTransfer ? (
          <p className="border-y border-hairline py-6" role="alert">
            {copy.unavailable}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-8 border-y border-hairline py-6 sm:grid-cols-[1fr_auto]">
              <dl className="space-y-3 text-[0.9375rem]">
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <dt className="text-ink-soft">{copy.bankName}</dt>
                  <dd className="min-w-0 text-right">{bankTransfer.bankName}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <dt className="text-ink-soft">{copy.accountNumber}</dt>
                  <dd className="min-w-0 font-mono text-right select-all">{bankTransfer.accountNumber}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
                  <dt className="text-ink-soft">{copy.accountHolder}</dt>
                  <dd className="min-w-0 text-right">{bankTransfer.accountHolder}</dd>
                </div>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline pt-3">
                  <dt className="font-medium">{copy.amount}</dt>
                  <dd className="text-xl font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-hairline pt-3">
                  <dt className="text-ink-soft">{copy.reference}</dt>
                  <dd className="flex min-w-0 items-center gap-3">
                    <span className="font-mono font-medium select-all" data-testid="order-reference">
                      {order.referenceCode}
                    </span>
                    <CopyReference
                      copiedLabel={copy.copied}
                      copyAriaLabel={copy.copyAriaLabel}
                      copyLabel={copy.copy}
                      value={order.referenceCode}
                    />
                  </dd>
                </div>
              </dl>

              {/* Decoration only: the details above are already complete on their own if this fails to load, or if the order's currency has no VietQR at all. */}
              {qrImageUrl ? (
                <img
                  alt={fillTemplate(copy.qrAlt, { reference: order.referenceCode })}
                  className="size-40 self-start justify-self-center border border-hairline sm:justify-self-end"
                  height={160}
                  loading="lazy"
                  src={qrImageUrl}
                  width={160}
                />
              ) : null}
            </div>

            {state === "declined" ? (
              <div className="mt-8 border-y border-hairline py-4" role="alert">
                <p className="font-medium text-error">{copy.declinedTitle}</p>
                <p className="mt-1 text-[0.9375rem] text-ink-soft">
                  {fillTemplate(copy.declinedBody, { reason: order.declineReason ?? "" })}
                </p>
              </div>
            ) : null}

            {state === "awaiting_transfer" || state === "declined" ? (
              <form action={claimTransferAction.bind(null, locale, order.id)} className="mt-8 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="note">{copy.noteLabel}</Label>
                  <Textarea id="note" name="note" />
                </div>
                <SubmitButton className="w-full sm:w-auto" pendingLabel={copy.claiming} size="lg">
                  {copy.claim}
                </SubmitButton>
              </form>
            ) : null}

            {state === "awaiting_confirmation" ? (
              <div className="mt-8 border-y border-hairline py-4" role="status">
                <p className="font-medium">{copy.claimedTitle}</p>
                <p className="mt-1 text-[0.9375rem] text-ink-soft">{copy.claimedBody}</p>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}
