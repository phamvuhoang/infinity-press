"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { type Locale } from "@/lib/i18n/config";

import { requireAdmin } from "@/lib/auth/admin";
import { isCatalogEntityType } from "@/lib/catalog/entity-guards";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import { fieldErrorsFrom, readOptionalText, readText, type AdminFormState } from "@/lib/catalog/form";
import { revalidateStorefront } from "@/lib/catalog/revalidate";
import { entityBaseSchema, entityLocalizationSchema } from "@/lib/catalog/schemas";
import {
  createCatalogEntity,
  DuplicateCanonicalSlugError,
  DuplicateEntitySlugError,
  EntityNotReadyError,
  saveCatalogEntityLocalization,
  updateCatalogEntity,
} from "@/lib/data/catalog-entities";

// Every runtime export of a "use server" module must be an async function.

const unknownType: AdminFormState = { fieldErrors: {}, formError: "Unknown catalog type.", savedAt: null };
const genericFailure = "Something went wrong saving. Try again.";

export async function createEntityAction(
  type: CatalogEntityType,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: isCatalogEntityType(type) ? `${catalogEntityConfig[type].adminPath}/new` : "/admin" });
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];

  const parsed = entityBaseSchema
    .pick({ canonicalSlug: true, name: true })
    .safeParse({ canonicalSlug: readText(formData, "canonicalSlug"), name: readText(formData, "name") });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  let id: string;
  try {
    ({ id } = await createCatalogEntity(type, parsed.data));
  } catch (error) {
    if (error instanceof DuplicateCanonicalSlugError) {
      return { fieldErrors: { canonicalSlug: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(config.adminPath);
  revalidateStorefront();
  redirect(`${config.adminPath}/${id}`);
}

export async function updateEntityAction(
  type: CatalogEntityType,
  id: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: isCatalogEntityType(type) ? `${catalogEntityConfig[type].adminPath}/${id}` : "/admin" });
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];

  const parsed = entityBaseSchema.safeParse({
    canonicalSlug: readText(formData, "canonicalSlug"),
    name: readText(formData, "name"),
    status: readText(formData, "status"),
    // An unchecked checkbox is absent from the form data, so only the author editor (which renders
    // it) can turn it off.
    acceptsQuestions: type !== "author" || formData.get("acceptsQuestions") === "on",
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await updateCatalogEntity(type, id, parsed.data);
  } catch (error) {
    if (error instanceof DuplicateCanonicalSlugError) {
      return { fieldErrors: { canonicalSlug: error.message }, formError: null, savedAt: null };
    }
    if (error instanceof EntityNotReadyError) {
      return { fieldErrors: { status: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(config.adminPath);
  revalidateStorefront();
  revalidatePath(`${config.adminPath}/${id}`);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}

export async function saveEntityLocalizationAction(
  type: CatalogEntityType,
  id: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: isCatalogEntityType(type) ? `${catalogEntityConfig[type].adminPath}/${id}` : "/admin" });
  if (!isCatalogEntityType(type)) return unknownType;
  const config = catalogEntityConfig[type];

  const parsed = entityLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    name: readText(formData, "name"),
    description: readOptionalText(formData, "description"),
    quote: readOptionalText(formData, "quote"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsFrom(parsed.error), formError: null, savedAt: null };

  try {
    await saveCatalogEntityLocalization(type, id, parsed.data);
  } catch (error) {
    if (error instanceof DuplicateEntitySlugError) {
      return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
    }
    return { fieldErrors: {}, formError: genericFailure, savedAt: null };
  }

  revalidatePath(config.adminPath);
  revalidateStorefront();
  revalidatePath(`${config.adminPath}/${id}`);
  return { fieldErrors: {}, formError: null, savedAt: Date.now() };
}
