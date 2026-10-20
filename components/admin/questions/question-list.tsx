import Link from "next/link";

import { QuestionRow, type IdeaOption } from "@/components/admin/questions/question-row";
import type { AdminQuestionDTO, AdminQuestionStatus } from "@/lib/data/admin-questions";

export const QUESTION_STATUSES: readonly AdminQuestionStatus[] = ["new", "answered", "archived"];

const label = (status: AdminQuestionStatus) => status.charAt(0).toUpperCase() + status.slice(1);

export function QuestionList({
  questions,
  status,
  ideas,
}: {
  questions: AdminQuestionDTO[];
  status: AdminQuestionStatus;
  ideas: IdeaOption[];
}) {
  return (
    <div>
      <nav aria-label="Question status" className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-sm font-medium">
        {QUESTION_STATUSES.map((tab) => (
          <Link
            aria-current={tab === status ? "page" : undefined}
            className={`inline-flex min-h-11 items-center underline-offset-[6px] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${tab === status ? "text-forest underline" : "text-ink"}`}
            href={`/admin/questions?status=${tab}`}
            key={tab}
          >
            {label(tab)}
          </Link>
        ))}
      </nav>
      {questions.length === 0 ? (
        <p className="text-sage-text">{`No ${status} questions.`}</p>
      ) : (
        <div aria-label="Questions" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[56rem] text-left text-sm">
            <caption className="sr-only">{`${label(status)} questions`}</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">About</th>
                <th className="py-2 pr-3 font-medium" scope="col">Asker</th>
                <th className="py-2 pr-3 font-medium" scope="col">Question</th>
                <th className="py-2 pr-3 font-medium" scope="col">Date</th>
                <th className="py-2 font-medium" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {questions.map((question) => (
                <QuestionRow ideas={ideas} key={question.id} question={question} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
