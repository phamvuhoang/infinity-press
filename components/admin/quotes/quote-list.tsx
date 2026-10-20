"use client";

import Link from "next/link";

import { removeSharedQuoteAction } from "@/app/admin/quotes/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import type { AdminSharedQuote } from "@/lib/data/admin-shared-quotes";
import { formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes } from "@/lib/i18n/routes";

export function QuoteList({ items }: { items: AdminSharedQuote[] }) {
  if (items.length === 0) return <p className="text-sage-text">No shared quotes.</p>;
  return (
    <div aria-label="Shared quotes" className="max-w-full overflow-x-auto" role="region" tabIndex={0}>
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">Shared quotes</caption>
        <thead>
          <tr className="border-b border-sand text-sage-text">
            <th className="py-2 pr-3 font-medium" scope="col">Book</th>
            <th className="py-2 pr-3 font-medium" scope="col">Quote</th>
            <th className="py-2 pr-3 font-medium" scope="col">Owner</th>
            <th className="py-2 pr-3 font-medium" scope="col">Views</th>
            <th className="py-2 pr-3 font-medium" scope="col">Card</th>
            <th className="py-2 pr-3 font-medium" scope="col">Date</th>
            <th className="py-2 font-medium" scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr className="border-b border-sand align-top" key={item.id}>
              <th className="py-3 pr-3 font-normal" scope="row">
                <Link className="font-medium text-forest underline decoration-sand underline-offset-4" href={`/admin/books/${item.bookId}`}>
                  {item.bookTitle}
                </Link>
              </th>
              <td className="max-w-[24rem] py-3 pr-3 whitespace-pre-wrap">{item.quote}</td>
              <td className="py-3 pr-3">{item.ownerEmail ?? "—"}</td>
              <td className="py-3 pr-3">{item.viewCount}</td>
              <td className="py-3 pr-3">
                <Link className="underline decoration-sand underline-offset-4" href={getCatalogRoutes(item.locale).quoteCard(item.code)}>
                  {item.code}
                </Link>
              </td>
              <td className="py-3 pr-3 whitespace-nowrap">{formatDate(item.createdAt, "en")}</td>
              <td className="py-3">
                <form action={removeSharedQuoteAction.bind(null, item.code)}>
                  <SubmitButton className="min-h-11" pendingLabel="Removing…" size="sm" variant="outline">
                    Remove
                  </SubmitButton>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
