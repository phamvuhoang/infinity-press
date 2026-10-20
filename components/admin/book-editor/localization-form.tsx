"use client";

import { useActionState } from "react";
import { type Locale } from "@/lib/i18n/config";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatFaq, formatKeyIdeas, initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { BookLocalizationDTO } from "@/lib/data/books";

type TextField = { name: string; label: string; multiline?: boolean; hint?: string; value: string };

export function LocalizationForm({
  action,
  locale,
  localization,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  locale: Locale;
  localization: BookLocalizationDTO | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const fields: TextField[] = [
    { name: "title", label: "Title", value: localization?.title ?? "" },
    { name: "slug", label: "Slug", value: localization?.slug ?? "" },
    { name: "subtitle", label: "Subtitle", value: localization?.subtitle ?? "" },
    { name: "shortDescription", label: "Short description", multiline: true, value: localization?.shortDescription ?? "" },
    { name: "description", label: "Description", multiline: true, value: localization?.description ?? "" },
    { name: "audience", label: "Who it is for", multiline: true, value: localization?.audience ?? "" },
    {
      name: "keyIdeas",
      label: "Key ideas",
      multiline: true,
      hint: "One idea per line: Title | short summary",
      value: formatKeyIdeas(localization?.keyIdeas ?? []),
    },
    {
      name: "faq",
      label: "FAQ",
      multiline: true,
      hint: "Blocks separated by a blank line: Q: question, then A: answer",
      value: formatFaq(localization?.faq ?? []),
    },
    { name: "seoTitle", label: "SEO title", hint: "Up to 70 characters", value: localization?.seoTitle ?? "" },
    { name: "seoDescription", label: "SEO description", multiline: true, hint: "Up to 160 characters", value: localization?.seoDescription ?? "" },
  ];

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      {fields.map((field) => {
        const id = `${field.name}-${locale}`;
        const error = state.fieldErrors[field.name] ?? Object.entries(state.fieldErrors).find(([key]) => key.startsWith(`${field.name}.`))?.[1];
        const describedBy = [field.hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        return (
          <div className="space-y-2" key={field.name}>
            <Label htmlFor={id}>{`${field.label} (${locale})`}</Label>
            {field.multiline ? (
              <Textarea aria-describedby={describedBy} aria-invalid={Boolean(error)} defaultValue={field.value} id={id} name={field.name} rows={field.name === "description" ? 8 : 4} />
            ) : (
              <Input aria-describedby={describedBy} aria-invalid={Boolean(error)} defaultValue={field.value} id={id} name={field.name} required={field.name === "title" || field.name === "slug"} />
            )}
            {field.hint ? <p className="text-[0.8125rem] text-sage-text" id={`${id}-hint`}>{field.hint}</p> : null}
            <FieldError id={`${id}-error`} message={error} />
          </div>
        );
      })}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} copy`}</SubmitButton>
    </form>
  );
}
