import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { customerOrderStatus } from "@/lib/commerce/checkout-view";
import { listCustomerOrders } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate, fillTemplate, formatDate } from "@/lib/i18n/format";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function OrdersPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  const routes = getLocaleRoutes(locale);
  await requireUser(locale, routes.orders);

  const [dictionary, orders] = await Promise.all([getDictionary(locale), listCustomerOrders()]);
  const copy = dictionary.orders;
  const commerce = getCommerceRoutes(locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="account" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "orders")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[48rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">{copy.title}</h1>
          <p className="mb-10 text-[0.9375rem] text-ink-soft">{copy.description}</p>

          {orders.length === 0 ? (
            <div className="space-y-4 border-y border-sand py-8">
              <h2 className="font-serif text-2xl font-normal">{copy.emptyTitle}</h2>
              <p className="text-[0.9375rem] text-ink-soft">{copy.emptyBody}</p>
              <Button render={<Link href={routes.books} />} variant="outline">
                {copy.browse}
              </Button>
            </div>
          ) : (
            <ul aria-label={copy.listLabel} className="border-t border-ink">
              {orders.map((order) => (
                <li className="grid gap-2 border-b border-sand py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6" key={order.id}>
                  <div className="min-w-0">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
                      href={commerce.order(order.id)}
                    >
                      {order.title}
                    </Link>
                    {/* A bundle order is sized as well as named: "The Starter Bundle" and "A Book"
                        would otherwise be indistinguishable rows for two very different purchases. */}
                    {order.bundleId ? (
                      <p className="text-sm text-sage-text">
                        {fillCountTemplate(locale, order.items.length, {
                          one: dictionary.catalog.bundle.itemCountOne,
                          other: dictionary.catalog.bundle.itemCountOther,
                        })}
                      </p>
                    ) : null}
                    <p className="text-sm text-sage-text">{fillTemplate(copy.placedOn, { date: formatDate(order.createdAt, locale) })}</p>
                  </div>
                  <div className="text-sm sm:text-right">
                    <p className="font-medium">{order.totalMinor === 0 ? copy.free : formatPrice(order.totalMinor, order.currency, locale)}</p>
                    <p className="text-sage-text">{copy.statuses[customerOrderStatus(order)]}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}
