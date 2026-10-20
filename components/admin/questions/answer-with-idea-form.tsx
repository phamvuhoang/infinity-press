"use client";

import { useActionState } from "react";
import { localeRegistry, locales } from "@/lib/i18n/config";

import { answerWithIdeaAction } from "@/app/admin/questions/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState } from "@/lib/catalog/form";
import type { AdminQuestionDTO } from "@/lib/data/admin-questions";

// An idea's question is capped at 300 characters, a reader's at 500: the prefill is cut to fit and
// the admin edits it down to a proper idea question anyway.
const IDEA_QUESTION_MAX = 300;

// Creates the answering idea and marks the question answered in one step, then lands in the idea
// editor. Field ids derive from the question id so several open rows never share a label target.
export function AnswerWithIdeaForm({ question }: { question: AdminQuestionDTO }) {
  const [state, formAction] = useActionState(answerWithIdeaAction.bind(null, question.id), initialAdminFormState);
  const base = `answer-${question.id}`;
  const describe = (name: string) => (state.fieldErrors[name] ? `${base}-${name}-error` : undefined);
  const invalid = (name: string) => Boolean(state.fieldErrors[name]);

  return (
    <form action={formAction} className="mt-3 w-full max-w-md space-y-3">
      <div className="space-y-2">
        <Label htmlFor={`${base}-locale`}>Locale</Label>
        <NativeSelect defaultValue={question.locale} id={`${base}-locale`} name="locale">
          {locales.map((code) => (
<option key={code} value={code}>{`${localeRegistry[code].englishName} (${code})`}</option>
))}
        </NativeSelect>
        <FieldError id={`${base}-locale-error`} message={state.fieldErrors.locale} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${base}-slug`}>Slug</Label>
        <Input aria-describedby={describe("slug")} aria-invalid={invalid("slug")} id={`${base}-slug`} name="slug" required />
        <FieldError id={`${base}-slug-error`} message={state.fieldErrors.slug} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${base}-question`}>Question</Label>
        <Input
          aria-describedby={describe("question")}
          aria-invalid={invalid("question")}
          defaultValue={question.body.slice(0, IDEA_QUESTION_MAX)}
          id={`${base}-question`}
          maxLength={IDEA_QUESTION_MAX}
          name="question"
          required
        />
        <FieldError id={`${base}-question-error`} message={state.fieldErrors.question} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${base}-shortAnswer`}>Short answer</Label>
        <Textarea
          aria-describedby={describe("shortAnswer")}
          aria-invalid={invalid("shortAnswer")}
          id={`${base}-shortAnswer`}
          name="shortAnswer"
          required
          rows={3}
        />
        <FieldError id={`${base}-shortAnswer-error`} message={state.fieldErrors.shortAnswer} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11" pendingLabel="Creating…" size="sm">
        Create idea
      </SubmitButton>
    </form>
  );
}
