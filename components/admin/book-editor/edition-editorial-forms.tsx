"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminEditionDTO } from "@/lib/data/admin-editions";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

const stateLabel: Record<AdminEditionDTO["editorial"]["state"], string> = {
  unreviewed: "Not reviewed",
  approved: "Approved",
  blocked: "Blocked",
};

// Where the text and the translation come from, and the rights evidence a reviewer looks at. This is
// a record of evidence, not a legal finding; changing it after approval withdraws the approval.
export function ProvenanceForm({ action, editorial }: { action: FormAction; editorial: AdminEditionDTO["editorial"] }) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const fields: { name: string; label: string; hint: string; value: string | null }[] = [
    { name: "textSourceNote", label: "Source of the original text", hint: "Edition, year, where the scan or text was obtained.", value: editorial.textSourceNote },
    { name: "translationSource", label: "Source of the translation", hint: "Translator, year, publisher or archive. Required to approve.", value: editorial.translationSource },
    { name: "rightsNote", label: "Rights note", hint: "Why this text may be republished, with a reference. Required to approve.", value: editorial.rightsNote },
    { name: "territoryNote", label: "Territories", hint: "Where it is intended to be sold. Required to approve.", value: editorial.territoryNote },
  ];
  return (
    <form action={formAction} className="space-y-5" onReset={(event) => event.preventDefault()}>
      {fields.map((field) => (
        <div className="min-w-0 space-y-2" key={field.name}>
          <Label htmlFor={`provenance-${field.name}`}>{field.label}</Label>
          <Textarea defaultValue={field.value ?? ""} id={`provenance-${field.name}`} name={field.name} rows={2} />
          <p className="text-[0.8125rem] text-sage-text">{field.hint}</p>
          <FieldError id={`provenance-${field.name}-error`} message={state.fieldErrors[field.name]} />
        </div>
      ))}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save provenance</SubmitButton>
    </form>
  );
}

// The decision. A new EPUB version of this edition can go live only while it is Approved.
export function ReviewForm({ action, editorial }: { action: FormAction; editorial: AdminEditionDTO["editorial"] }) {
  const [state, formAction, pending] = useActionState(action, initialAdminFormState);
  return (
    <form action={formAction} className="space-y-4" onReset={(event) => event.preventDefault()}>
      <p className="text-sm" data-testid="editorial-state">
        Status: <strong>{stateLabel[editorial.state]}</strong>
        {editorial.reviewedAt ? ` · ${new Date(editorial.reviewedAt).toISOString().slice(0, 10)}` : ""}
      </p>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="review-note">Note (required to block)</Label>
        <Textarea defaultValue={editorial.reviewNote ?? ""} id="review-note" name="note" rows={2} />
        <FieldError id="review-note-error" message={state.fieldErrors.note} />
      </div>
      <div className="flex flex-wrap gap-3">
        <Button disabled={pending} name="state" type="submit" value="approved">Approve</Button>
        <Button disabled={pending} name="state" type="submit" value="blocked" variant="outline">Block</Button>
        <Button disabled={pending} name="state" type="submit" value="unreviewed" variant="outline">Reset to not reviewed</Button>
      </div>
      <FormStatus state={state} />
    </form>
  );
}
