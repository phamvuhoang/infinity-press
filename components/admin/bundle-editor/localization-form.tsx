"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { AdminBundleLocalizationDTO } from "@/lib/data/bundles";

type TextField = { name: string; label: string; multiline?: boolean; hint?: string; value: string };

// A bundle's copy is the four localized fields of bundle_localizations. The locale is bound by the
// page into the action, so it is not a form field.
export function BundleLocalizationForm({
  action,
  locale,
  localization,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  locale: "vi" | "en";
  localization: AdminBundleLocalizationDTO | null;
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);
  const fields: TextField[] = [
    { name: "title", label: "Title", value: localization?.title ?? "" },
    { name: "slug", label: "Slug", value: localization?.slug ?? "" },
    { name: "subtitle", label: "Subtitle", value: localization?.subtitle ?? "" },
    {
      name: "description",
      label: "Description",
      multiline: true,
      hint: "A bundle needs a description in at least one locale before it can be published.",
      value: localization?.description ?? "",
    },
  ];

  return (
    <form action={formAction} className="space-y-5" onReset={(event) => event.preventDefault()}>
      {fields.map((field) => {
        const id = `bundle-${field.name}-${locale}`;
        const error = state.fieldErrors[field.name];
        const describedBy = [field.hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
        return (
          <div className="min-w-0 space-y-2" key={field.name}>
            <Label htmlFor={id}>{`${field.label} (${locale})`}</Label>
            {field.multiline ? (
              <Textarea
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                defaultValue={field.value}
                id={id}
                name={field.name}
                rows={6}
              />
            ) : (
              <Input
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                defaultValue={field.value}
                id={id}
                name={field.name}
                required={field.name === "title" || field.name === "slug"}
              />
            )}
            {field.hint ? (
              <p className="text-[0.8125rem] text-sage-text" id={`${id}-hint`}>
                {field.hint}
              </p>
            ) : null}
            <FieldError id={`${id}-error`} message={error} />
          </div>
        );
      })}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">{`Save ${locale} copy`}</SubmitButton>
    </form>
  );
}
