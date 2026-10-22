"use client";

import { useActionState } from "react";

import type { JourneyActionState } from "@/app/[lang]/(account)/journeys/[slug]/sessions/[position]/actions";
import { SubmitButton } from "@/components/auth/submit-button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initial: JourneyActionState = { error: null };

// Shown on the last session. Submitting again after completion updates the reflection. The length
// limit is checked on the server in code points, as the RPC counts, not by a UTF-16 maxLength.
export function JourneyReflectionForm({
  action,
  completed,
  copy,
  reflection,
}: {
  action: (state: JourneyActionState, formData: FormData) => Promise<JourneyActionState>;
  completed: boolean;
  copy: { reflectionLabel: string; reflectionSubmit: string; completedTitle: string; pending: string };
  reflection: string | null;
}) {
  const [state, formAction] = useActionState(action, initial);

  return (
    <form action={formAction} className="space-y-3">
      {completed ? (
        <p className="font-serif text-xl" role="status">
          {copy.completedTitle}
        </p>
      ) : null}
      <Label htmlFor="journey-reflection">{copy.reflectionLabel}</Label>
      <Textarea defaultValue={reflection ?? ""} id="journey-reflection" name="reflection" rows={5} />
      <SubmitButton className="min-h-11" pendingLabel={copy.pending}>
        {copy.reflectionSubmit}
      </SubmitButton>
      {state.error ? (
        <p className="text-sm text-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
