"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import { fieldErrorsFrom, readText, type AdminFormState } from "@/lib/catalog/form";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { platformSettingsSchema } from "@/lib/catalog/schemas";
import { savePlatformSettings } from "@/lib/i18n/settings";
import { getRequestId } from "@/lib/observability/request-id";

const genericFailure = "Something went wrong saving. Try again.";

export async function savePlatformSettingsAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: "/admin/settings" });

  const parsed = platformSettingsSchema.safeParse({
    defaultUiLocale: readText(formData, "defaultUiLocale"),
    defaultContentLanguage: readText(formData, "defaultContentLanguage"),
    defaultMetadataLocale: readText(formData, "defaultMetadataLocale"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await savePlatformSettings(parsed.data);
  } catch (error) {
    console.error("Save platform settings failed.", { requestId: getRequestId(await headers()), error: String(error) });
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath("/admin/settings");
  // The defaults decide which language every public page, the sitemap and llms.txt fall back to.
  revalidateStorefront();
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
