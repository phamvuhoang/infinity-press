import "server-only";

import { cache } from "react";

import { requireAdmin } from "@/lib/auth/admin";
import type { PlatformSettingsInput } from "@/lib/catalog/schemas";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

export type PlatformSettings = {
  defaultUiLocale: Locale;
  defaultContentLanguage: string;
  defaultMetadataLocale: Locale;
};

export type ContentLanguageOption = { code: string; name: string };

function failure(operation: string): Error {
  return new Error(`${operation} failed.`);
}

// The settings and registries hold nothing private, but only the admin screen reads them: public
// pages resolve language through the SQL functions, so this has no public caller.
export const getPlatformSettings = cache(async (): Promise<PlatformSettings> => {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("platform_settings")
    .select("default_ui_locale, default_content_language, default_metadata_locale")
    .single();
  if (error || !data) throw failure("getPlatformSettings");
  if (!isLocale(data.default_ui_locale) || !isLocale(data.default_metadata_locale)) {
    throw failure("getPlatformSettings");
  }
  return {
    defaultUiLocale: data.default_ui_locale,
    defaultContentLanguage: data.default_content_language,
    defaultMetadataLocale: data.default_metadata_locale,
  };
});

export async function listContentLanguages(): Promise<ContentLanguageOption[]> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("content_languages").select("code, name").order("name");
  if (error) throw failure("listContentLanguages");
  return data ?? [];
}

export async function savePlatformSettings(input: PlatformSettingsInput): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_platform_settings", {
    p_default_ui_locale: input.defaultUiLocale,
    p_default_content_language: input.defaultContentLanguage,
    p_default_metadata_locale: input.defaultMetadataLocale,
  });
  if (error) throw failure("savePlatformSettings");
}
