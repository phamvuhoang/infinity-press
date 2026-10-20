"use client";

import { useActionState, useState } from "react";

import type { AskFormState } from "@/app/[lang]/(account)/ask/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Textarea } from "@/components/ui/textarea";
import { fillTemplate } from "@/lib/i18n/format";

const BODY_MAX_LENGTH = 500;

type Copy = {
  about: string;
  bodyLabel: string;
  counter: string;
  send: string;
  sent: string;
  errors: { tooMany: string; targetMissing: string; failed: string; body: string; target: string };
};

type Action = (state: AskFormState, formData: FormData) => Promise<AskFormState>;

const initialState: AskFormState = { fieldErrors: {}, formError: null, savedAt: null };

// Form errors arrive as keys, and field errors are keyed by field: the schema's messages are
// English, so only the keys are used and the customer copy comes from the dictionary.
function formErrorCopy(copy: Copy, formError: string | null): string | null {
  if (formError === null) return null;
  if (formError === "too_many") return copy.errors.tooMany;
  if (formError === "target_missing") return copy.errors.targetMissing;
  return copy.errors.failed;
}

export function AskForm({
  action,
  target,
  copy,
}: {
  action: Action;
  target: { kind: "book" | "idea"; id: string; title: string };
  copy: Copy;
}) {
  const [body, setBody] = useState("");
  // A controlled textarea survives the form reset React does after an action, so a sent question
  // has to be cleared explicitly; a failed one stays for the reader to retry.
  const [state, formAction] = useActionState(async (previous: AskFormState, formData: FormData) => {
    const next = await action(previous, formData);
    if (next.savedAt !== null) setBody("");
    return next;
  }, initialState);
  const formError = formErrorCopy(copy, state.formError);
  // The sent notice goes away as soon as the reader starts another question (the body was cleared on send).

  return (
    <form action={formAction} className="mt-6 space-y-6">
      <p className="font-medium">{fillTemplate(copy.about, { title: target.title })}</p>
      <input name={target.kind === "book" ? "bookId" : "ideaId"} type="hidden" value={target.id} />
      <div>
        <label className="mb-2 block text-sm font-medium" htmlFor="ask-body">{copy.bodyLabel}</label>
        <Textarea
          aria-invalid={state.fieldErrors.body ? true : undefined}
          id="ask-body"
          maxLength={BODY_MAX_LENGTH}
          name="body"
          onChange={(event) => setBody(event.target.value)}
          value={body}
        />
        <p className="mt-1 text-right text-xs text-sage-text">{fillTemplate(copy.counter, { count: body.length })}</p>
        {state.fieldErrors.body ? <p className="mt-1 text-sm text-error" role="alert">{copy.errors.body}</p> : null}
        {state.fieldErrors.target ? <p className="mt-1 text-sm text-error" role="alert">{copy.errors.target}</p> : null}
      </div>
      {formError ? <p className="text-sm text-error" role="alert">{formError}</p> : null}
      {state.savedAt !== null && !formError && body === "" ? <p className="text-sm text-forest" role="status">{copy.sent}</p> : null}
      <SubmitButton className="min-h-11" pendingLabel={copy.send}>{copy.send}</SubmitButton>
    </form>
  );
}
