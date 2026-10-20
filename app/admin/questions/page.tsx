import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { QUESTION_STATUSES, QuestionList } from "@/components/admin/questions/question-list";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminKnowledge } from "@/lib/data/admin-knowledge";
import { listAdminQuestions, type AdminQuestionStatus } from "@/lib/data/admin-questions";

export default async function AdminQuestionsPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/questions" });
  const { status: raw } = await searchParams;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const status: AdminQuestionStatus = QUESTION_STATUSES.find((s) => s === value) ?? "new";
  const [questions, ideas] = await Promise.all([listAdminQuestions(status), listAdminKnowledge("idea")]);
  // Drafts are linkable too: the asker is mailed when the idea is published. Archived ideas are not.
  const options = ideas
    .filter((idea) => idea.status !== "archived")
    .map((idea) => ({ id: idea.id, label: `${idea.title}${idea.status === "draft" ? " (draft)" : ""}` }));

  return (
    <div className="min-w-0 max-w-[72rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Readers" title="Questions">
        Answer reader questions with a new idea or an existing one. The 200 oldest in each status are shown.
      </AdminPageHeader>
      <QuestionList ideas={options} questions={questions} status={status} />
    </div>
  );
}
