"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { answerQuestionAction, archiveQuestionAction } from "@/app/admin/questions/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { AnswerWithIdeaForm } from "@/components/admin/questions/answer-with-idea-form";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState } from "@/lib/catalog/form";
import type { AdminQuestionDTO } from "@/lib/data/admin-questions";
import { formatDate } from "@/lib/i18n/format";

export type IdeaOption = { id: string; label: string };

const linkClass =
  "inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

function LinkToIdeaForm({ question, ideas }: { question: AdminQuestionDTO; ideas: IdeaOption[] }) {
  const [state, formAction] = useActionState(answerQuestionAction.bind(null, question.id), initialAdminFormState);
  const fieldId = `link-${question.id}`;
  return (
    <form action={formAction} aria-label="Link to idea" className="mt-3 w-full max-w-md space-y-2">
      <Label htmlFor={fieldId}>Idea</Label>
      <NativeSelect
        aria-describedby={state.fieldErrors.ideaId ? `${fieldId}-error` : undefined}
        aria-invalid={Boolean(state.fieldErrors.ideaId)}
        defaultValue=""
        id={fieldId}
        name="ideaId"
        required
      >
        <option value="">Choose an idea</option>
        {ideas.map((idea) => (
          <option key={idea.id} value={idea.id}>
            {idea.label}
          </option>
        ))}
      </NativeSelect>
      <FieldError id={`${fieldId}-error`} message={state.fieldErrors.ideaId} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Linking…" size="sm" variant="outline">
        Link idea
      </SubmitButton>
    </form>
  );
}

function Target({ question }: { question: AdminQuestionDTO }) {
  if (question.bookId && question.bookTitle) {
    return (
      <Link className={linkClass} href={`/admin/books/${question.bookId}`}>
        {question.bookTitle}
      </Link>
    );
  }
  if (question.ideaId && question.ideaQuestion) {
    return (
      <Link className={linkClass} href={`/admin/ideas/${question.ideaId}`}>
        {question.ideaQuestion}
      </Link>
    );
  }
  // Both foreign keys are on delete set null: the book or idea may be gone by now.
  return <span className="text-sage-text">Deleted</span>;
}

// One inbox row. The new-idea disclosure lives inside the row so the row, found by its target,
// holds every control for that question.
export function QuestionRow({ question, ideas }: { question: AdminQuestionDTO; ideas: IdeaOption[] }) {
  const [answerOpen, setAnswerOpen] = useState(false);
  const panelId = `answer-panel-${question.id}`;

  return (
    <tr className="border-b border-sand align-top">
      <th className="py-3 pr-3 font-normal" scope="row">
        <Target question={question} />
      </th>
      <td className="py-3 pr-3">{question.askerName ?? "Reader"}</td>
      <td className="max-w-[28rem] py-3 pr-3">
        <p className="whitespace-pre-wrap">{question.body}</p>
      </td>
      <td className="py-3 pr-3 whitespace-nowrap">{formatDate(question.createdAt, "en")}</td>
      <td className="py-3">
        {question.status === "new" ? (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <form action={archiveQuestionAction.bind(null, question.id)}>
                <SubmitButton className="min-h-11" pendingLabel="Archiving…" size="sm" variant="outline">
                  Archive
                </SubmitButton>
              </form>
              <Button
                aria-controls={panelId}
                aria-expanded={answerOpen}
                className="min-h-11"
                onClick={() => setAnswerOpen((open) => !open)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Answer with a new idea
              </Button>
            </div>
            <div id={panelId}>{answerOpen ? <AnswerWithIdeaForm question={question} /> : null}</div>
            <LinkToIdeaForm ideas={ideas} question={question} />
          </>
        ) : question.status === "answered" && question.answerIdeaId ? (
          <Link className={linkClass} href={`/admin/ideas/${question.answerIdeaId}`}>
            View answer
          </Link>
        ) : null}
      </td>
    </tr>
  );
}
