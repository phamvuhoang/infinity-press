import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { listAdminCoupons } from "@/lib/data/coupons";
import { formatDate } from "@/lib/i18n/format";

// The operator's coupon list (S8 spec 7.2), following app/admin/payments/page.tsx's table
// conventions column for column rather than inventing new ones.
export default async function AdminCouponsPage() {
  await requireAdmin({ next: "/admin/coupons" });
  const coupons = await listAdminCoupons();

  return (
    <div className="min-w-0 max-w-[64rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="Coupons">
        Create, scope, and retire promotion codes.
      </AdminPageHeader>
      <div className="mb-8">
        <Button render={<Link href="/admin/coupons/new" />}>New coupon</Button>
      </div>
      {coupons.length === 0 ? (
        <p className="text-sage-text">No coupons yet.</p>
      ) : (
        <div aria-label="Coupons" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">Coupons</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Code</th>
                <th className="py-2 pr-3 font-medium" scope="col">Value</th>
                <th className="py-2 pr-3 font-medium" scope="col">Window</th>
                <th className="py-2 pr-3 font-medium" scope="col">Active</th>
                <th className="py-2 pr-3 font-medium" scope="col">Reserved</th>
                <th className="py-2 pr-3 font-medium" scope="col">Redeemed</th>
                <th className="py-2 font-medium" scope="col">Scope</th>
              </tr>
            </thead>
            <tbody>
              {coupons.map((coupon) => (
                <tr className="border-b border-sand" key={coupon.id}>
                  <th className="py-2 pr-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-mono font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
                      href={`/admin/coupons/${coupon.id}`}
                    >
                      {coupon.code}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">
                    {coupon.kind === "percent" ? `${coupon.percentOff}%` : formatPrice(coupon.amountOffMinor ?? 0, coupon.currency ?? "VND", "en")}
                  </td>
                  <td className="py-2 pr-3">
                    {coupon.startsAt || coupon.endsAt
                      ? `${coupon.startsAt ? formatDate(coupon.startsAt, "en", { withTime: true }) : "…"} – ${coupon.endsAt ? formatDate(coupon.endsAt, "en", { withTime: true }) : "…"}`
                      : "Always"}
                  </td>
                  <td className="py-2 pr-3">{coupon.active ? "Yes" : "No"}</td>
                  <td className="py-2 pr-3">{coupon.reservedCount}</td>
                  <td className="py-2 pr-3">{coupon.redeemedCount}</td>
                  <td className="py-2">{coupon.bookIds.length === 0 ? "All books" : `${coupon.bookIds.length} books`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
