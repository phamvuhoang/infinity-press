import { catalogEntityTypes, type CatalogEntityType } from "@/lib/catalog/entity-types";

export function isCatalogEntityType(value: unknown): value is CatalogEntityType {
  return typeof value === "string" && (catalogEntityTypes as readonly string[]).includes(value);
}
