import { KnowledgeEditPage } from "@/components/admin/knowledge/knowledge-pages";
import { requireAdmin } from "@/lib/auth/admin";

export default async function AdminArticlePage({ params }: { params: Promise<{ articleId: string }> }) {
  const { articleId } = await params;
  await requireAdmin({ next: `/admin/articles/${articleId}` });
  return <KnowledgeEditPage id={articleId} kind="article" />;
}
