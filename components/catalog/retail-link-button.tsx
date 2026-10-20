"use client";

import { type Retailer, sendAnalyticsEvent } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";

// The click is reported and the navigation proceeds: no preventDefault, no redirect route. A
// blocked beacon costs a data point, never a sale.
export function RetailLinkButton({ bookId, locale, retailer, href, label }: { bookId: string; locale: Locale; retailer: Retailer; href: string; label: string }) {
  return (
    <a
      className="inline-flex min-h-11 items-center rounded-md border border-ink px-4 text-sm font-medium text-ink hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
      href={href}
      onClick={() => sendAnalyticsEvent({ eventName: "click_external_store", bookId, retailer, locale })}
      rel="nofollow noopener sponsored"
      target="_blank"
    >
      {label}
    </a>
  );
}
