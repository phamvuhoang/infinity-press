"use client";

import { useActionState } from "react";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import type { ContentLanguageOption } from "@/lib/i18n/settings";

export function DetailsForm({
  action,
  authors,
  languages,
  defaults,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  authors: { id: string; name: string; canonicalSlug: string }[];
  languages: ContentLanguageOption[];
  defaults: { canonicalKey: string; originalLanguage: string; primaryAuthorId: string };
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  return (
    <form action={formAction} onReset={(event) => event.preventDefault()} className="space-y-5">
      <div className="grid min-w-0 gap-5 sm:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <Label htmlFor="details-canonicalKey">Canonical key</Label>
          <Input defaultValue={defaults.canonicalKey} aria-invalid={Boolean(state.fieldErrors.canonicalKey)} aria-describedby={state.fieldErrors.canonicalKey ? "details-canonicalKey-error" : undefined} id="details-canonicalKey" name="canonicalKey" required />
          <FieldError id="details-canonicalKey-error" message={state.fieldErrors.canonicalKey} />
        </div>
        <div className="min-w-0 space-y-2">
          <Label htmlFor="details-originalLanguage">Book language</Label>
          <NativeSelect defaultValue={defaults.originalLanguage} aria-invalid={Boolean(state.fieldErrors.originalLanguage)} aria-describedby={state.fieldErrors.originalLanguage ? "details-originalLanguage-error" : undefined} id="details-originalLanguage" name="originalLanguage">
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {`${language.name} (${language.code})`}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="details-originalLanguage-error" message={state.fieldErrors.originalLanguage} />
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="details-primaryAuthorId">Primary author</Label>
        <NativeSelect defaultValue={defaults.primaryAuthorId} aria-invalid={Boolean(state.fieldErrors.primaryAuthorId)} aria-describedby={state.fieldErrors.primaryAuthorId ? "details-primaryAuthorId-error" : undefined} id="details-primaryAuthorId" name="primaryAuthorId">
          {authors.map((author) => (
            <option key={author.id} value={author.id}>
              {author.name} ({author.canonicalSlug})
            </option>
          ))}
        </NativeSelect>
        <FieldError id="details-primaryAuthorId-error" message={state.fieldErrors.primaryAuthorId} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save details</SubmitButton>
    </form>
  );
}
