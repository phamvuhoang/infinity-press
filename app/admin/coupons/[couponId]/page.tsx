import { notFound } from "next/navigation";

import { updateCouponAction } from "@/app/admin/coupons/actions";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { CouponForm } from "@/components/admin/coupon-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { listAdminBundles } from "@/lib/data/bundles";
import { getAdminCoupon } from "@/lib/data/coupons";

export default async function EditCouponPage({ params }: { params: Promise<{ couponId: string }> }) {
  const { couponId } = await params;
  await requireAdmin({ next: `/admin/coupons/${couponId}` });

  // Bundle options come from the protected admin data layer, which gates on requireAdmin of its
  // own - the gate above is this page's, not the data layer's.
  const [coupon, books, bundles] = await Promise.all([getAdminCoupon(couponId), listAdminBooks(), listAdminBundles()]);
  if (!coupon) notFound();

  return (
    <div className="min-w-0 max-w-[42.5rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title={coupon.code}>
        <p>
          Reserved {coupon.reservedCount} &middot; Redeemed {coupon.redeemedCount}
        </p>
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <CouponForm action={updateCouponAction.bind(null, coupon.id)} books={books} bundles={bundles} coupon={coupon} />
      </div>
    </div>
  );
}
