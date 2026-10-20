import { KnowledgeNewPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewArticlePage() {
  await requireAdmin({ next: "/admin/articles/new" });
  return <KnowledgeNewPage kind="article" />;
}
