"use client";

import { useActionState } from "react";
import { localeRegistry, locales } from "@/lib/i18n/config";

import { createBundleAction } from "@/app/admin/bundles/actions";
import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState } from "@/lib/catalog/form";

// Creating a bundle is creating its first localization; everything else is set in the editor, so
// this form is deliberately three fields. It sits beside book-form.tsx rather than under
// bundle-editor/, which holds the sections of an existing bundle.
export function BundleForm() {
  const [state, formAction] = useActionState(createBundleAction, initialAdminFormState);

  return (
    <form action={formAction} className="space-y-5">
      <div className="min-w-0 space-y-2">
        <Label htmlFor="bundle-locale">Locale</Label>
        <NativeSelect defaultValue="vi" id="bundle-locale" name="locale">
          {locales.map((code) => (
<option key={code} value={code}>{`${localeRegistry[code].englishName} (${code})`}</option>
))}
        </NativeSelect>
        <FieldError id="bundle-locale-error" message={state.fieldErrors.locale} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="bundle-title">Title</Label>
        <Input
          aria-describedby={state.fieldErrors.title ? "bundle-title-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.title)}
          id="bundle-title"
          name="title"
          required
        />
        <FieldError id="bundle-title-error" message={state.fieldErrors.title} />
      </div>
      <div className="min-w-0 space-y-2">
        <Label htmlFor="bundle-slug">Slug</Label>
        <Input
          aria-describedby={state.fieldErrors.slug ? "bundle-slug-error" : undefined}
          aria-invalid={Boolean(state.fieldErrors.slug)}
          id="bundle-slug"
          name="slug"
          required
        />
        <FieldError id="bundle-slug-error" message={state.fieldErrors.slug} />
      </div>
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Creating…">Create bundle</SubmitButton>
    </form>
  );
}
