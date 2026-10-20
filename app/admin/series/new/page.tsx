import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewSeriesPage() {
  await requireAdmin({ next: "/admin/series/new" });
  return <EntityNewPage type="series" />;
}
