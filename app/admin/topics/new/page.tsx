import { EntityNewPage } from "@/components/admin/entity-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewTopicPage() {
  await requireAdmin({ next: "/admin/topics/new" });
  return <EntityNewPage type="topic" />;
}
