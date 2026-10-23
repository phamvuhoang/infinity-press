import { z } from "zod";

// reader_aligned_passage's payload, checked on the server before it leaves and again in the compare
// panel before it renders.
export const alignedPassageSchema = z
  .object({
    targetPublicationId: z.guid(),
    targetEditionId: z.guid(),
    targetLanguageCode: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
    targetOrdinal: z.number().int().nonnegative(),
    // 1024 code points, as lib/epub/search-index.ts chunks; .max() would count UTF-16 units.
    text: z.string().min(1).refine((value) => [...value].length <= 1024),
    confidence: z.number().gt(0).lte(1),
  })
  .strict();

export type AlignedPassage = z.infer<typeof alignedPassageSchema>;
