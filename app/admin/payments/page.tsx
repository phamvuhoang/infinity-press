import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { listManualPaymentQueue } from "@/lib/data/manual-payments";
import { formatDate } from "@/lib/i18n/format";

// The admin's manual-transfer review queue (spec 5.6): every pending order paid through the manual
// provider, claimed orders first. This is the screen an operator sits in front of every morning, so
// it follows app/admin/orders/page.tsx's table conventions exactly rather than inventing new ones.
export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/payments" });
  const { q: rawQuery } = await searchParams;
  const q = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const queue = await listManualPaymentQueue(q);

  return (
    <div className="min-w-0 max-w-[64rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="Payments">
        Review reported bank transfers. Search by order reference or customer email.
      </AdminPageHeader>
      <form className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="payments-search">Reference or email</Label>
          <Input className="min-h-11" defaultValue={q ?? ""} id="payments-search" name="q" type="search" />
        </div>
        <Button className="min-h-11" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {queue.length === 0 ? (
        <p className="text-sage-text">No manual payments are waiting for review.</p>
      ) : (
        <div aria-label="Payments" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">Payments</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Reference</th>
                <th className="py-2 pr-3 font-medium" scope="col">Book</th>
                <th className="py-2 pr-3 font-medium" scope="col">Customer</th>
                <th className="py-2 pr-3 font-medium" scope="col">Placed</th>
                <th className="py-2 pr-3 font-medium" scope="col">Total</th>
                <th className="py-2 font-medium" scope="col">Reported</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((item) => (
                <tr className="border-b border-sand" key={item.orderId}>
                  <th className="py-2 pr-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-mono font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
                      href={`/admin/orders/${item.orderId}`}
                    >
                      {item.referenceCode}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">{item.title || item.orderId}</td>
                  <td className="py-2 pr-3">{item.email ?? "—"}</td>
                  <td className="py-2 pr-3">{formatDate(item.createdAt, "en", { withTime: true })}</td>
                  <td className="py-2 pr-3">{formatPrice(item.totalMinor, item.currency, "en")}</td>
                  <td className="py-2">{item.claimedAt ? formatDate(item.claimedAt, "en", { withTime: true }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
