import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SubmitButton } from "@/components/auth/submit-button";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { isSimulatorCheckoutEnabled } from "@/lib/commerce/simulator";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCommerceRoutes } from "@/lib/i18n/routes";

import { simulatePaymentAction } from "./actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ lang: string; orderId: string }> };

// The stand-in for a hosted provider page. It is 404 outside local, test, and staging, and for any
// order the viewer does not own or that is no longer pending.
export default async function SimulatePaymentPage({ params }: Props) {
  const { lang: locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, getCommerceRoutes(locale).checkoutSimulate(orderId));
  if (!isSimulatorCheckoutEnabled(getServerEnv())) notFound();

  const order = await getCustomerOrder(orderId);
  // The provider check is the order's own, not the environment's: a simulated event against an
  // order booked as manual is refused by apply_payment_event itself (EB016, 20260922180000), so
  // this page would offer four buttons that can only fail.
  if (!order || order.status !== "pending" || order.provider !== "simulator") notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.checkout.simulate;
  const buttons = [
    { outcome: "succeeded", label: copy.succeed, variant: "default" },
    { outcome: "failed", label: copy.fail, variant: "outline" },
    { outcome: "cancelled", label: copy.cancel, variant: "outline" },
    { outcome: "duplicate", label: copy.duplicate, variant: "outline" },
  ] as const;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
        <p className="border-y border-hairline py-4">
          <span className="font-serif text-xl">{order.title}</span>
          <span className="ml-3 font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</span>
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {buttons.map((button) => (
            <form action={simulatePaymentAction.bind(null, locale, order.id, button.outcome)} key={button.outcome}>
              <SubmitButton pendingLabel={copy.sending} variant={button.variant}>
                {button.label}
              </SubmitButton>
            </form>
          ))}
        </div>
      </main>
    </div>
  );
}
