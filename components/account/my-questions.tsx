import Link from "next/link";

import type { MyQuestion } from "@/lib/data/questions";
import type { Locale } from "@/lib/i18n/config";
import { formatDate } from "@/lib/i18n/format";
import { getKnowledgeRoutes } from "@/lib/i18n/routes";

type Copy = {
  mineTitle: string;
  readAnswer: string;
  states: Record<MyQuestion["status"], string>;
};

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

export function MyQuestions({ questions, copy, locale }: { questions: MyQuestion[]; copy: Copy; locale: Locale }) {
  if (questions.length === 0) return null;
  // No aria-labelledby on the section: in vi the heading text equals the ask textarea's label, and a
  // labelled section would make getByLabel("Câu hỏi của bạn") match two elements.
  return (
    <section className="mt-12">
      <h2 className="font-serif text-2xl">{copy.mineTitle}</h2>
      <ul className="mt-4 divide-y divide-hairline">
        {questions.map((question) => (
          <li className="space-y-1 py-4" key={question.id}>
            <p className="text-sm text-sage-text">
              {question.target.title} · <time dateTime={question.createdAt}>{formatDate(question.createdAt, locale)}</time>
            </p>
            <p className="whitespace-pre-line">{question.body}</p>
            <p className="text-sm font-medium">{copy.states[question.status]}</p>
            {question.answer ? (
              <Link className={textLink} href={getKnowledgeRoutes(question.locale).idea(question.answer.slug)}>{copy.readAnswer}</Link>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
