"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { MySharedQuote } from "@/lib/data/shared-quotes";
import type { Locale } from "@/lib/i18n/config";
import { fillTemplate, formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

type Copy = { empty: string; copyLink: string; copied: string; remove: string; views: string };

export function SharedQuoteList({
  copy,
  items,
  locale,
  removeAction,
  siteUrl,
}: {
  copy: Copy;
  items: MySharedQuote[];
  locale: Locale;
  removeAction: (code: string) => Promise<void>;
  siteUrl: string;
}) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  if (items.length === 0) return <p className="text-ink-soft">{copy.empty}</p>;
  return (
    <ul className="divide-y divide-hairline">
      {items.map((item) => {
        // The card's own locale, which may differ from the page's.
        const path = getCatalogRoutes(item.locale).quoteCard(item.code);
        const url = new URL(path, siteUrl).toString();
        return (
          <li className="space-y-3 py-6" key={item.id}>
            <blockquote className="font-serif text-xl">{`“${item.quote}”`}</blockquote>
            <p className="text-[0.9375rem] text-ink-soft">
              {item.bookTitle} · {formatDate(item.createdAt, locale)} · {fillTemplate(copy.views, { count: item.viewCount })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link className="inline-flex min-h-11 items-center underline decoration-sand underline-offset-4" href={path}>
                {path}
              </Link>
              <Button
                onClick={() => {
                  void navigator.clipboard
                    .writeText(url)
                    .then(() => setCopiedCode(item.code))
                    .catch(() => undefined);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                {copiedCode === item.code ? copy.copied : copy.copyLink}
              </Button>
              {/* Bound like the admin row actions, so the form still posts without client JS. */}
              <form action={removeAction.bind(null, item.code)}>
                <Button size="sm" type="submit" variant="ghost">
                  {copy.remove}
                </Button>
              </form>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
