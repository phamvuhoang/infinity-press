import { KnowledgeEditPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AdminIdeaPage({ params }: { params: Promise<{ ideaId: string }> }) {
  const { ideaId } = await params;
  await requireAdmin({ next: `/admin/ideas/${ideaId}` });
  return <KnowledgeEditPage id={ideaId} kind="idea" />;
}
