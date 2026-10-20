"use client";

import { useActionState } from "react";

import { FieldError, FormStatus } from "@/components/admin/form-feedback";
import { SubmitButton } from "@/components/auth/submit-button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { initialAdminFormState, type AdminFormState } from "@/lib/catalog/form";
import { localeRegistry, locales } from "@/lib/i18n/config";
import type { ContentLanguageOption, PlatformSettings } from "@/lib/i18n/settings";

type FormAction = (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;

export function PlatformSettingsForm({
  action,
  settings,
  contentLanguages,
}: {
  action: FormAction;
  settings: PlatformSettings;
  contentLanguages: ContentLanguageOption[];
}) {
  const [state, formAction] = useActionState(action, initialAdminFormState);

  const localeSelect = (id: string, name: keyof PlatformSettings, label: string, hint: string) => (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        aria-invalid={Boolean(state.fieldErrors[name])}
        defaultValue={settings[name]}
        id={id}
        name={name}
      >
        {locales.map((code) => (
          <option key={code} value={code}>
            {`${localeRegistry[code].englishName} (${code})`}
          </option>
        ))}
      </NativeSelect>
      <p className="text-[0.8125rem] text-sage-text">{hint}</p>
      <FieldError id={`${id}-error`} message={state.fieldErrors[name]} />
    </div>
  );

  return (
    <form action={formAction} className="space-y-6">
      {localeSelect(
        "default-ui-locale",
        "defaultUiLocale",
        "Default interface language",
        "Where the bare site address sends visitors.",
      )}
      <div className="min-w-0 space-y-2">
        <Label htmlFor="default-content-language">Default edition language</Label>
        <NativeSelect
          aria-invalid={Boolean(state.fieldErrors.defaultContentLanguage)}
          defaultValue={settings.defaultContentLanguage}
          id="default-content-language"
          name="defaultContentLanguage"
        >
          {contentLanguages.map((language) => (
            <option key={language.code} value={language.code}>
              {`${language.name} (${language.code})`}
            </option>
          ))}
        </NativeSelect>
        <p className="text-[0.8125rem] text-sage-text">
          The one fallback language when a reader&apos;s language has no published edition. A single work can override it.
        </p>
        <FieldError id="default-content-language-error" message={state.fieldErrors.defaultContentLanguage} />
      </div>
      {localeSelect(
        "default-metadata-locale",
        "defaultMetadataLocale",
        "Default metadata language",
        "Titles and descriptions fall back to this language when a page has no copy in the reader's language.",
      )}
      <FormStatus state={state} />
      <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
    </form>
  );
}
