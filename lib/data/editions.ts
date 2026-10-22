import "server-only";

import { z } from "zod";

import type { CatalogEditionOption } from "@/lib/catalog/public-types";
import type { Locale } from "@/lib/i18n/config";
import { createPublicClient } from "@/lib/supabase/public";

// The editions of one work a reader may choose between, as catalog_book_editions answers them. The
// payload is parsed per row: a malformed edition drops that edition, not the page.
const optionRow = z.object({
  editionId: z.string(),
  languageCode: z.string(),
  epubLanguage: z.string().nullable().catch(null),
  isDefault: z.boolean(),
  offerId: z.string().nullable(),
  priceMinor: z.number().nullable(),
  currency: z.string().nullable(),
  listPriceMinor: z.number().nullable().catch(null),
  saleEndsAt: z.string().nullable().catch(null),
  hasSample: z.boolean(),
  // A malformed record hides the block, not the edition.
  record: z
    .object({
      textSourceNote: z.string().nullable(),
      translationSource: z.string().nullable(),
      rightsNote: z.string().nullable(),
      territoryNote: z.string().nullable(),
      textKind: z.enum(["literal", "adapted", "commentary"]).nullable(),
      reviewScope: z.enum(["full", "sample", "none"]),
      reviewedAt: z.string().nullable(),
      reviewNote: z.string().nullable(),
    })
    .nullable()
    .catch(null),
});

export function toEditionOption(row: z.infer<typeof optionRow>): CatalogEditionOption {
  return {
    editionId: row.editionId,
    languageCode: row.languageCode,
    epubLanguage: row.epubLanguage,
    isDefault: row.isDefault,
    offer:
      row.offerId === null || row.priceMinor === null || row.currency === null
        ? null
        : {
            offerId: row.offerId,
            priceMinor: row.priceMinor,
            currency: row.currency,
            listPriceMinor: row.listPriceMinor,
            saleEndsAt: row.saleEndsAt,
          },
    hasSample: row.hasSample,
    record: row.record,
  };
}

export const editionOptionsSchema = z
  .array(optionRow.nullable().catch(null))
  .catch([])
  .transform((rows) => rows.flatMap((row) => (row ? [toEditionOption(row)] : [])));

export async function getBookEditions(bookId: string, locale: Locale): Promise<CatalogEditionOption[]> {
  const { data, error } = await createPublicClient().rpc("catalog_book_editions", { p_book_id: bookId, p_locale: locale });
  if (error) throw new Error(`getBookEditions failed: ${error.message}`);
  return editionOptionsSchema.parse(data ?? []);
}

// An explicit edition must be one of the work's readable editions, or there is no answer: an
// unknown or unreadable id never falls through to the default edition.
export async function findBookEdition(
  bookId: string,
  locale: Locale,
  editionId: string,
): Promise<CatalogEditionOption | null> {
  return (await getBookEditions(bookId, locale)).find((edition) => edition.editionId === editionId) ?? null;
}
