"use client";

import Link from "next/link";

import { sendAnalyticsEvent } from "@/lib/analytics/browser";
import type { Locale } from "@/lib/i18n/config";

// "Continue reading from here" on a quote card. The click is reported and the navigation proceeds.
export function PassageLink({ bookId, className, href, label, locale, sharedQuoteId }: { bookId: string; className: string; href: string; label: string; locale: Locale; sharedQuoteId: string }) {
  return (
    <Link className={className} href={href} onClick={() => sendAnalyticsEvent({ eventName: "passage_opened", sharedQuoteId, bookId, locale })}>
      {label}
    </Link>
  );
}
