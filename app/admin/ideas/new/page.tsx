import { KnowledgeNewPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function NewIdeaPage() {
  await requireAdmin({ next: "/admin/ideas/new" });
  return <KnowledgeNewPage kind="idea" />;
}
