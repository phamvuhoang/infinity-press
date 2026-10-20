import "server-only";
import { type Locale, locales } from "@/lib/i18n/config";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { catalogEntityConfig, type CatalogEntityType } from "@/lib/catalog/entity-types";
import type { EntityBaseInput, EntityLocalizationInput } from "@/lib/catalog/schemas";
import { createClient } from "@/lib/supabase/server";

export class DuplicateEntitySlugError extends Error {
  constructor() {
    super("This slug is already used in this language.");
    this.name = "DuplicateEntitySlugError";
  }
}

export class DuplicateCanonicalSlugError extends Error {
  constructor() {
    super("This canonical slug is already used.");
    this.name = "DuplicateCanonicalSlugError";
  }
}

export class EntityNotReadyError extends Error {
  constructor() {
    super("Add copy in at least one language before publishing.");
    this.name = "EntityNotReadyError";
  }
}

type Status = "draft" | "published" | "archived";

export type CatalogEntityListItemDTO = {
  id: string;
  canonicalSlug: string;
  name: string;
  status: Status;
  locales: Locale[];
};

export type CatalogEntityDTO = CatalogEntityListItemDTO & {
  type: CatalogEntityType;
  // Authors only; true for the other types.
  acceptsQuestions: boolean;
  localizations: { locale: Locale; slug: string; name: string; description: string | null; quote: string | null }[];
};

type EntityRow = {
  id: string;
  canonical_slug: string;
  status: Status;
  display_name?: string;
  name?: string;
  accepts_questions?: boolean;
  localizations: { locale: Locale; slug: string; name: string; description: string | null; quote: string | null }[];
};

const localeOrder = Object.fromEntries(locales.map((locale, index) => [locale, index])) as Record<Locale, number>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function selectFor(type: CatalogEntityType) {
  const config = catalogEntityConfig[type];
  // `quote` is an author-only column, so it is only selected for authors; the DTO reports null for
  // the other types.
  const columns = `locale, slug, name, description${type === "author" ? ", quote" : ""}`;
  return `id, canonical_slug, ${config.nameColumn}, status${type === "author" ? ", accepts_questions" : ""}, localizations:${config.localizationTable} ( ${columns} )`;
}

function toDto(type: CatalogEntityType, row: EntityRow): CatalogEntityDTO {
  const localizations = [...row.localizations]
    .sort((a, b) => localeOrder[a.locale] - localeOrder[b.locale])
    .map((localization) => ({ ...localization, quote: localization.quote ?? null }));
  return {
    type,
    id: row.id,
    canonicalSlug: row.canonical_slug,
    name: row[catalogEntityConfig[type].nameColumn] ?? "",
    status: row.status,
    acceptsQuestions: row.accepts_questions ?? true,
    locales: localizations.map((localization) => localization.locale),
    localizations,
  };
}

function mapWriteError(error: { code?: string; message: string }): Error {
  if (error.code === "23505" && error.message.includes("_locale_slug_key")) return new DuplicateEntitySlugError();
  if (error.code === "23505" && error.message.includes("_canonical_slug_key")) return new DuplicateCanonicalSlugError();
  return new Error("Unable to save catalog entry.");
}

export async function listCatalogEntities(type: CatalogEntityType): Promise<CatalogEntityListItemDTO[]> {
  await requireAdmin();
  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase.from(config.table).select(selectFor(type)).order(config.nameColumn);
  if (error) throw new Error("Unable to load catalog entries.");

  return ((data ?? []) as unknown as EntityRow[]).map((row) => {
    const { id, canonicalSlug, name, status, locales } = toDto(type, row);
    return { id, canonicalSlug, name, status, locales };
  });
}

export async function listCatalogEntityOptions(type: CatalogEntityType): Promise<{ id: string; name: string; canonicalSlug: string }[]> {
  const entities = await listCatalogEntities(type);
  return entities.map((entity) => ({ id: entity.id, name: entity.name, canonicalSlug: entity.canonicalSlug }));
}

export async function getCatalogEntity(type: CatalogEntityType, id: string): Promise<CatalogEntityDTO> {
  await requireAdmin();
  if (!uuidPattern.test(id)) notFound();

  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase.from(config.table).select(selectFor(type)).eq("id", id).maybeSingle();
  if (error) throw new Error("Unable to load catalog entries.");
  if (!data) notFound();

  return toDto(type, data as unknown as EntityRow);
}

export async function createCatalogEntity(
  type: CatalogEntityType,
  input: Pick<EntityBaseInput, "canonicalSlug" | "name">,
): Promise<{ id: string }> {
  await requireAdmin();
  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from(config.table)
    .insert({ canonical_slug: input.canonicalSlug, [config.nameColumn]: input.name, status: "draft" })
    .select("id")
    .single();

  if (error) throw mapWriteError(error);
  return { id: (data as { id: string }).id };
}

export async function updateCatalogEntity(type: CatalogEntityType, id: string, input: EntityBaseInput): Promise<void> {
  const current = await getCatalogEntity(type, id);
  if (input.status === "published" && current.localizations.length === 0) {
    throw new EntityNotReadyError();
  }

  const config = catalogEntityConfig[type];
  const supabase = await createClient();
  const { error } = await supabase
    .from(config.table)
    .update({
      canonical_slug: input.canonicalSlug,
      [config.nameColumn]: input.name,
      status: input.status,
      ...(type === "author" ? { accepts_questions: input.acceptsQuestions } : {}),
    })
    .eq("id", id);

  if (error) throw mapWriteError(error);
}

export async function saveCatalogEntityLocalization(
  type: CatalogEntityType,
  id: string,
  input: EntityLocalizationInput,
): Promise<void> {
  await requireAdmin();
  if (!uuidPattern.test(id)) notFound();

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_entity_localization", {
    p_entity_type: type,
    p_entity_id: id,
    p_locale: input.locale,
    p_slug: input.slug,
    p_name: input.name,
    p_description: input.description,
    p_quote: input.quote,
  });

  if (error) throw mapWriteError(error);
}
