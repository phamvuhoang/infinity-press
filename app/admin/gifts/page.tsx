import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { GiftActions } from "@/components/admin/gift-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { searchAdminGifts, type AdminGiftDTO } from "@/lib/data/gifts";
import { formatDate } from "@/lib/i18n/format";

// The gift support surface (S9 spec 7.4). Admin copy is English-only and /admin carries no locale
// prefix, so nothing here reads a dictionary.
//
// The page never shows a claim link, because nothing it reads has one: admin_search_gifts returns
// no token, no hash, and no outbox payload.

// Enough titles to recognise the gift; beyond that a count, so one bundle cannot push the actions
// column off the screen.
const MAX_TITLES_SHOWN = 3;

function covers(gift: AdminGiftDTO): string {
  if (gift.itemTitles.length === 0) return `${gift.itemCount} books`;
  if (gift.itemTitles.length > MAX_TITLES_SHOWN) return `${gift.itemCount} books`;
  return gift.itemTitles.join(", ");
}

// What the operator needs before choosing between resend and reissue: whether the message went
// out, and whether delivery is failing.
function delivery(gift: AdminGiftDTO): string {
  if (gift.sentAt) return `Sent ${formatDate(gift.sentAt, "en", { withTime: true })}`;
  if (gift.attemptCount === null) return "—";
  const attempts = `${gift.attemptCount} attempts`;
  return gift.lastErrorCode ? `${attempts} · ${gift.lastErrorCode}` : attempts;
}

export default async function AdminGiftsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/gifts" });
  const { q: rawQuery } = await searchParams;
  const q = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const gifts = await searchAdminGifts(q);

  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="Gifts">
        Find a gift by order reference, purchaser email, or recipient email. Without a search, the 50 newest gifts are
        shown.
      </AdminPageHeader>
      <form className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="gift-search">Order reference, purchaser email, or recipient email</Label>
          <Input className="min-h-11" defaultValue={q ?? ""} id="gift-search" name="q" type="search" />
        </div>
        <Button className="min-h-11" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {gifts.length === 0 ? (
        <p className="text-sage-text">No gifts match this search.</p>
      ) : (
        <div
          aria-label="Gifts"
          className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest"
          role="region"
          tabIndex={0}
        >
          <table className="w-full min-w-[64rem] text-left text-sm">
            <caption className="sr-only">Gifts</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Order</th>
                <th className="py-2 pr-3 font-medium" scope="col">Purchaser</th>
                <th className="py-2 pr-3 font-medium" scope="col">Recipient</th>
                <th className="py-2 pr-3 font-medium" scope="col">Covers</th>
                <th className="py-2 pr-3 font-medium" scope="col">Status</th>
                <th className="py-2 pr-3 font-medium" scope="col">Delivery</th>
                <th className="py-2 font-medium" scope="col">Support</th>
              </tr>
            </thead>
            <tbody>
              {gifts.map((gift) => (
                <tr className="border-b border-sand align-top" key={gift.id}>
                  <th className="py-3 pr-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-mono font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
                      href={`/admin/orders/${gift.orderId}`}
                    >
                      {gift.referenceCode}
                    </Link>
                    <span className="block text-[0.8125rem] text-sage-text">
                      {formatDate(gift.createdAt, "en", { withTime: true })}
                    </span>
                  </th>
                  <td className="py-3 pr-3">{gift.purchaserEmail ?? "—"}</td>
                  <td className="py-3 pr-3">{gift.recipientEmail}</td>
                  <td className="py-3 pr-3">{covers(gift)}</td>
                  <td className="py-3 pr-3">
                    {gift.status}
                    {gift.claimedAt ? (
                      <span className="block text-[0.8125rem] text-sage-text">
                        {formatDate(gift.claimedAt, "en", { withTime: true })}
                      </span>
                    ) : null}
                    {gift.revokedAt ? (
                      <span className="block text-[0.8125rem] text-sage-text">
                        {formatDate(gift.revokedAt, "en", { withTime: true })}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-3 pr-3">{delivery(gift)}</td>
                  <td className="py-3">
                    <GiftActions
                      claimLocale={gift.claimLocale}
                      giftId={gift.id}
                      orderId={gift.orderId}
                      status={gift.status}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
