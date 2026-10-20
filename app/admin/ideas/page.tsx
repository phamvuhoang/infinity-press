import { KnowledgeListPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AdminIdeasPage() {
  await requireAdmin({ next: "/admin/ideas" });
  return <KnowledgeListPage kind="idea" />;
}
