"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

export function RelationsForm({
  action,
  topics,
  series,
  defaults,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  topics: { id: string; name: string }[];
  series: { id: string; name: string }[];
  defaults: { topicIds: string[]; seriesId: string | null; seriesPosition: number | null };
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  const topicError = state.fieldErrors.topicIds ?? Object.entries(state.fieldErrors).find(([key]) => key.startsWith("topicIds."))?.[1];

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-6">
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-[0.8125rem] font-medium">Topics</legend>
        {topics.length === 0 ? <p className="text-sm text-sage-text">No topics yet. Create them under Topics.</p> : null}
        <div className="grid gap-x-6 sm:grid-cols-2">
          {topics.map((topic) => (
            <label className="flex min-h-11 items-center gap-3 text-sm" key={topic.id}>
              <input className="size-4 shrink-0 accent-forest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest" defaultChecked={defaults.topicIds.includes(topic.id)} aria-invalid={Boolean(topicError)} aria-describedby={topicError ? "relations-topicIds-error" : undefined} name="topicIds" type="checkbox" value={topic.id} />
              <span className="min-w-0 [overflow-wrap:anywhere]">{topic.name}</span>
            </label>
          ))}
        </div>
        <FieldError id="relations-topicIds-error" message={topicError} />
      </fieldset>
      <div className="grid min-w-0 gap-5 sm:grid-cols-[1fr_10rem]">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="relations-seriesId">Series</Label>
          <NativeSelect defaultValue={defaults.seriesId ?? ""} aria-invalid={Boolean(state.fieldErrors.seriesId)} aria-describedby={state.fieldErrors.seriesId ? "relations-seriesId-error" : undefined} id="relations-seriesId" name="seriesId">
            <option value="">Not in a series</option>
            {series.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="relations-seriesId-error" message={state.fieldErrors.seriesId} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="relations-seriesPosition">Series position</Label>
          <Input defaultValue={defaults.seriesPosition ?? ""} aria-invalid={Boolean(state.fieldErrors.seriesPosition)} aria-describedby={state.fieldErrors.seriesPosition ? "relations-seriesPosition-error" : undefined} id="relations-seriesPosition" min={1} name="seriesPosition" type="number" />
          <FieldError id="relations-seriesPosition-error" message={state.fieldErrors.seriesPosition} />
        </div>
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save relations</SubmitButton>
    </form>
  );
}
