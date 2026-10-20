"use client";

import { useActionState } from "react";
import { type Locale } from "@/lib/i18n/config";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";

// Optional search-result overrides for one language. Blank fields save as no override, and the
// public page falls back to the question or title and the short answer or excerpt.
export function KnowledgeSeoForm({
  locale,
  defaults,
  hasLocalization,
  action,
}: {
  locale: Locale;
  defaults: { seoTitle: string | null; seoDescription: string | null };
  hasLocalization: boolean;
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const titleId = `knowledge-seoTitle-${locale}`;
  const descriptionId = `knowledge-seoDescription-${locale}`;

  return (
    <form action={formAction} className="min-w-0 space-y-5" onReset={(event) => event.preventDefault()}>
      {hasLocalization ? null : (
        <p className="text-sm text-sage-text">{`Save the ${locale} content first; SEO belongs to an existing localization.`}</p>
      )}
      <div className="min-w-0 space-y-2">
        <Label htmlFor={titleId}>{`SEO title (${locale})`}</Label>
        <Input
          aria-describedby={state.fieldErrors.seoTitle ? `${titleId}-error` : undefined}
          aria-invalid={Boolean(state.fieldErrors.seoTitle)}
          defaultValue={defaults.seoTitle ?? ""}
          id={titleId}
          maxLength={70}
          name="seoTitle"
        />
        <FieldError id={`${titleId}-error`} message={state.fieldErrors.seoTitle} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor={descriptionId}>{`SEO description (${locale})`}</Label>
        <Textarea
          aria-describedby={state.fieldErrors.seoDescription ? `${descriptionId}-error` : undefined}
          aria-invalid={Boolean(state.fieldErrors.seoDescription)}
          defaultValue={defaults.seoDescription ?? ""}
          id={descriptionId}
          maxLength={160}
          name="seoDescription"
          rows={3}
        />
        <FieldError id={`${descriptionId}-error`} message={state.fieldErrors.seoDescription} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} SEO`}</SubmitButton>
    </form>
  );
}
