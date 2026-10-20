import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BundleForm } from "@/components/admin/bundle-form";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewBundlePage() {
  await requireAdmin({ next: "/admin/bundles/new" });

  return (
    <div className="max-w-[42.5rem]">
      <AdminPageHeader eyebrow="Catalog" title="New bundle">
        Creates the bundle with one localization. Add its books, price, cover, and remaining copy in the editor, then publish.
      </AdminPageHeader>
      <div className="border-t border-ink pt-8">
        <BundleForm />
      </div>
    </div>
  );
}
