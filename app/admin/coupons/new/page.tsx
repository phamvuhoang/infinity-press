import { createCouponAction } from "@/app/admin/coupons/actions";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { CouponForm } from "@/components/admin/coupon-form";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { listAdminBundles } from "@/lib/data/bundles";

export default async function NewCouponPage() {
  await requireAdmin({ next: "/admin/coupons/new" });
  const [books, bundles] = await Promise.all([listAdminBooks(), listAdminBundles()]);

  return (
    <div className="min-w-0 max-w-[42.5rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="New coupon">
        The code cannot be changed once the coupon is created.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <CouponForm action={createCouponAction} books={books} bundles={bundles} coupon={null} />
      </div>
    </div>
  );
}
