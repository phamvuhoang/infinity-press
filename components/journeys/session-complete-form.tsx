"use client";

import { useActionState } from "react";

import type { JourneyActionState } from "@/app/[lang]/(account)/journeys/[slug]/sessions/[position]/actions";
import { SubmitButton } from "@/components/auth/submit-button";

const initial: JourneyActionState = { error: null };

export function SessionCompleteForm({
  action,
  copy,
  done,
}: {
  action: () => Promise<JourneyActionState>;
  copy: { markDone: string; done: string; pending: string };
  done: boolean;
}) {
  const [state, formAction] = useActionState(action, initial);
  if (done) return <p className="text-sm font-medium text-forest" role="status">{copy.done}</p>;

  return (
    <form action={formAction}>
      <SubmitButton className="min-h-11" pendingLabel={copy.pending}>
        {copy.markDone}
      </SubmitButton>
      {state.error ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
