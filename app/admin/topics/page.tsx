import { EntityListPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function TopicsPage() {
  await requireAdmin({ next: "/admin/topics" });
  return <EntityListPage type="topic" />;
}
