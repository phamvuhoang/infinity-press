// Authors, series, and topics share one admin shape: a base row with a canonical slug, a name, and
// a status, plus per-locale copy. This table is the only place their differences are written down.

export type CatalogEntityType = "author" | "series" | "topic";

export type CatalogEntityConfig = {
  table: "authors" | "series" | "topics";
  nameColumn: "display_name" | "name";
  localizationTable: "author_localizations" | "series_localizations" | "topic_localizations";
  foreignKey: "author_id" | "series_id" | "topic_id";
  adminPath: "/admin/authors" | "/admin/series" | "/admin/topics";
  singular: string;
  plural: string;
};

export const catalogEntityTypes: readonly CatalogEntityType[] = ["author", "series", "topic"];

export const catalogEntityConfig: Record<CatalogEntityType, CatalogEntityConfig> = {
  author: {
    table: "authors",
    nameColumn: "display_name",
    localizationTable: "author_localizations",
    foreignKey: "author_id",
    adminPath: "/admin/authors",
    singular: "Author",
    plural: "Authors",
  },
  series: {
    table: "series",
    nameColumn: "display_name",
    localizationTable: "series_localizations",
    foreignKey: "series_id",
    adminPath: "/admin/series",
    singular: "Series",
    plural: "Series",
  },
  topic: {
    table: "topics",
    nameColumn: "name",
    localizationTable: "topic_localizations",
    foreignKey: "topic_id",
    adminPath: "/admin/topics",
    singular: "Topic",
    plural: "Topics",
  },
};
