import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { searchAdminOrders } from "@/lib/data/admin-orders";
import { formatDate } from "@/lib/i18n/format";

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/orders" });
  const { q: rawQuery } = await searchParams;
  const q = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const orders = await searchAdminOrders(q);

  return (
    <div className="min-w-0 max-w-[64rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="Orders">
        Find an order by customer email or order ID. Without a search, the 50 newest orders are shown.
      </AdminPageHeader>
      <form className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="order-search">Email or order ID</Label>
          <Input className="min-h-11" defaultValue={q ?? ""} id="order-search" name="q" type="search" />
        </div>
        <Button className="min-h-11" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {orders.length === 0 ? (
        <p className="text-sage-text">No orders match this search.</p>
      ) : (
        <div aria-label="Orders" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">Orders</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Book</th>
                <th className="py-2 pr-3 font-medium" scope="col">Customer</th>
                <th className="py-2 pr-3 font-medium" scope="col">Placed</th>
                <th className="py-2 pr-3 font-medium" scope="col">Total</th>
                <th className="py-2 pr-3 font-medium" scope="col">Order</th>
                <th className="py-2 font-medium" scope="col">Payment</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr className="border-b border-sand" key={order.id}>
                  <th className="py-2 pr-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
                      href={`/admin/orders/${order.id}`}
                    >
                      {order.title || order.id}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">{order.email ?? "—"}</td>
                  <td className="py-2 pr-3">{formatDate(order.createdAt, "en", { withTime: true })}</td>
                  <td className="py-2 pr-3">{formatPrice(order.totalMinor, order.currency, "en")}</td>
                  <td className="py-2 pr-3">{order.status}</td>
                  <td className="py-2">{order.paymentStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
