import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { BundleReadinessBadge } from "@/components/admin/bundle-editor/readiness-badge";
import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBundles } from "@/lib/data/bundles";

export default async function AdminBundlesPage() {
  await requireAdmin({ next: "/admin/bundles" });
  const bundles = await listAdminBundles();

  return (
    <div className="max-w-[64rem] min-w-0">
      <AdminPageHeader eyebrow="Catalog" title="Bundles">
        <div className="flex flex-wrap items-center gap-3">
          <Button render={<Link href="/admin/bundles/new" />}>New bundle</Button>
        </div>
      </AdminPageHeader>

      {bundles.length === 0 ? (
        <p className="text-sage-text">No bundles yet.</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[42rem] table-fixed border-t border-ink text-left text-xs sm:text-sm">
            <thead>
              <tr className="border-b border-sand text-[0.6875rem] tracking-[0.08em] text-sage-text uppercase">
                <th className="px-1 py-3 font-medium" scope="col">
                  Bundle
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Status
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Books
                </th>
                <th className="px-1 py-3 font-medium" scope="col">
                  Readiness
                </th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((bundle) => (
                <tr className="border-b border-sand" key={bundle.id}>
                  <th className="min-w-0 wrap-anywhere px-1 py-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center wrap-anywhere font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest"
                      href={`/admin/bundles/${bundle.id}`}
                    >
                      {bundle.title}
                    </Link>
                  </th>
                  <td className="wrap-anywhere px-1 py-3">{bundle.status}</td>
                  <td className="wrap-anywhere px-1 py-3">
                    {bundle.publishedMemberCount} of {bundle.memberCount} published
                  </td>
                  <td className="px-1 py-3">
                    <BundleReadinessBadge readiness={bundle.readiness} />
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
