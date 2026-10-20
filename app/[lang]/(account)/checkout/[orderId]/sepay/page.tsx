import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { buildSepayCheckoutFields, sepayCheckoutUrl } from "@/lib/commerce/sepay";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCommerceRoutes } from "@/lib/i18n/routes";

import { AutoSubmitForm } from "./auto-submit-form";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

// The hand-off to SePay's hosted payment page (S18 spec 5.3). Everything posted is built here from
// the order row; nothing comes from the request. The form carries a signature and no secret.
//
// Any order this page cannot hand off goes to the status page, which explains it. The provider is
// checked on the order AND on the environment, as the transfer page does: an order booked under
// another provider cannot be settled by a SePay notification (EB016), and a deployment that has
// left SePay should start no new payments on it.
export default async function CheckoutSepayPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutSepay(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const env = getServerEnv();
  const status = commerce.checkoutStatus(order.id);
  if (order.status !== "pending" || order.hasAllActiveEntitlements) redirect(status);
  if (order.provider !== "sepay" || env.paymentProvider !== "sepay" || !env.sepay) redirect(status);

  const fields = buildSepayCheckoutFields({ order, locale, siteUrl: env.siteUrl, config: env.sepay });
  if (!fields) redirect(status);

  const dictionary = await getDictionary(locale);
  const copy = dictionary.checkout.sepay;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
        <p className="mb-8 border-y border-hairline py-4">
          <span className="font-serif text-xl">{order.title}</span>
          <span className="ml-3 font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</span>
        </p>
        <AutoSubmitForm action={sepayCheckoutUrl(env.sepay.env)} fields={fields}>
          <Button size="lg" type="submit">
            {copy.continue}
          </Button>
        </AutoSubmitForm>
      </main>
    </div>
  );
}
