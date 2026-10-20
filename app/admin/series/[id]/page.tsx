import { EntityEditPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function SeriesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireAdmin({ next: `/admin/series/${id}` });
  return <EntityEditPage id={id} type="series" />;
}
