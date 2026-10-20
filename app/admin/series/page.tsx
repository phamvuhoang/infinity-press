import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function SeriesListPage() {
  await requireAdmin({ next: "/admin/series" });
  return <EntityListPage type="series" />;
}
