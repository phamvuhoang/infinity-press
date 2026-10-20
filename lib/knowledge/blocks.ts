import { z } from "zod";

import { isWithinBookQuoteLimit } from "@/lib/reader/quote";

// S12 editorial content is typed JSON, never markup. This schema is the write-time contract for
// idea and article `body_blocks`, and the public DAL parses stored rows through it again before
// rendering. Nothing here sanitizes or converts HTML: markup-looking text is rejected outright,
// and React's escaping in BlockRenderer remains the second boundary for ordinary `<`/`>`.

export const MAX_KNOWLEDGE_BLOCKS = 100;
export const MAX_LIST_ITEMS = 50;
export const MAX_INLINE_RUN_LENGTH = 5000;

export const knowledgeEntityKinds = ["book", "idea", "article", "author", "series", "topic"] as const;
export type KnowledgeEntityKind = (typeof knowledgeEntityKinds)[number];

const htmlTagPattern = /<\/?[a-z][^>]*>/i;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const uuidSegment = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Matches the keys the server mints for knowledge images in the public `covers` bucket:
// knowledge/{ideas|articles}/{entityId}/{uuid}.{jpg|png|webp}
const imageStorageKeyPattern = new RegExp(`^knowledge/(ideas|articles)/${uuidSegment}/${uuidSegment}\\.(jpg|png|webp)$`);

function safeText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => /\S/.test(value), { error: "Enter some text." })
    .refine((value) => !htmlTagPattern.test(value), { error: "HTML is not allowed. Use plain text." });
}

function isSafeExternalHref(value: string): boolean {
  // Absolute http(s) only: no relative, protocol-relative, `javascript:`, `data:`, or other schemes.
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value) || !URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.length > 0;
}

const internalLinkSchema = z.strictObject({
  kind: z.literal("internal"),
  entity: z.enum(knowledgeEntityKinds),
  slug: z.string().max(200).regex(slugPattern, "Use lowercase letters, numbers, and single hyphens."),
});

const externalLinkSchema = z.strictObject({
  kind: z.literal("external"),
  href: z.string().max(2048).refine(isSafeExternalHref, { error: "Use an absolute https:// or http:// URL." }),
});

const inlineLinkSchema = z.discriminatedUnion("kind", [internalLinkSchema, externalLinkSchema]);

const marksSchema = z
  .array(z.enum(["emphasis", "strong"]))
  .max(2)
  .refine((marks) => new Set(marks).size === marks.length, { error: "Each mark may appear only once." });

export const inlineRunSchema = z.strictObject({
  text: safeText(MAX_INLINE_RUN_LENGTH),
  marks: marksSchema.optional(),
  link: inlineLinkSchema.optional(),
});

const inlineContentSchema = z.array(inlineRunSchema).min(1).max(200);

const paragraphBlockSchema = z.strictObject({
  type: z.literal("paragraph"),
  content: inlineContentSchema,
});

const headingBlockSchema = z.strictObject({
  type: z.literal("heading"),
  level: z.union([z.literal(2), z.literal(3)]),
  text: safeText(500),
});

const listBlockSchema = z.strictObject({
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(inlineContentSchema).min(1).max(MAX_LIST_ITEMS),
});

// A quote has exactly one attribution source: free text or a book. A book-backed quote obeys the
// same 300-grapheme book-quote rule as `book_quote` and reader quotes.
const quoteBlockSchema = z
  .strictObject({
    type: z.literal("quote"),
    text: safeText(MAX_INLINE_RUN_LENGTH),
    attribution: safeText(500).optional(),
    bookId: z.uuid().optional(),
  })
  .superRefine((block, context) => {
    const sources = (block.attribution === undefined ? 0 : 1) + (block.bookId === undefined ? 0 : 1);
    if (sources !== 1) {
      context.addIssue({
        code: "custom",
        message: "Attribute the quote to a person or to a book, not both.",
        path: ["attribution"],
      });
    }
    if (block.bookId !== undefined && !isWithinBookQuoteLimit(block.text)) {
      context.addIssue({ code: "custom", message: "A book quote is at most 300 characters.", path: ["text"] });
    }
  });

const bookQuoteBlockSchema = z
  .strictObject({
    type: z.literal("book_quote"),
    bookId: z.uuid(),
    text: safeText(MAX_INLINE_RUN_LENGTH),
    locatorLabel: safeText(200).optional(),
  })
  .superRefine((block, context) => {
    if (!isWithinBookQuoteLimit(block.text)) {
      context.addIssue({ code: "custom", message: "A book quote is at most 300 characters.", path: ["text"] });
    }
  });

const imageBlockSchema = z.strictObject({
  type: z.literal("image"),
  storageKey: z.string().regex(imageStorageKeyPattern, "Upload the image through the editor."),
  alt: safeText(1000),
  width: z.int().min(1).max(20000),
  height: z.int().min(1).max(20000),
});

const bookCardBlockSchema = z.strictObject({ type: z.literal("book_card"), bookId: z.uuid() });

const ideaCardBlockSchema = z.strictObject({ type: z.literal("idea_card"), ideaId: z.uuid() });

export const knowledgeBlockSchema = z.discriminatedUnion("type", [
  paragraphBlockSchema,
  headingBlockSchema,
  listBlockSchema,
  quoteBlockSchema,
  bookQuoteBlockSchema,
  imageBlockSchema,
  bookCardBlockSchema,
  ideaCardBlockSchema,
]);

// 100 blocks keeps a full body comfortably under Next.js's 1 MB Server Action body limit.
export const knowledgeBlocksSchema = z.array(knowledgeBlockSchema).max(MAX_KNOWLEDGE_BLOCKS);

export type KnowledgeBlock = z.infer<typeof knowledgeBlockSchema>;
export type InlineRun = z.infer<typeof inlineRunSchema>;
export type InlineLink = z.infer<typeof inlineLinkSchema>;

// The published, localized idea a renderer may show for an `idea_card` block. Resolved by the
// public DAL; BlockRenderer never queries.
export type KnowledgeIdeaReference = {
  ideaId: string;
  slug: string;
  question: string;
  shortAnswer: string;
};
