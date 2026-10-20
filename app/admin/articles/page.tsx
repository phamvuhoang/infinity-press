import { KnowledgeListPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AdminArticlesPage() {
  await requireAdmin({ next: "/admin/articles" });
  return <KnowledgeListPage kind="article" />;
}
