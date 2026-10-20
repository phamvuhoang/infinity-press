import { z } from "zod";

import { isCouponCode, normalizeCouponCode } from "@/lib/commerce/coupon";
import { knowledgeBlocksSchema } from "@/lib/knowledge/blocks";
import { locales } from "@/lib/i18n/config";

// kebab-case, lowercase ascii letters/digits, single hyphens between segments -
// shared by canonical_key (books) and slug (book_localizations), which both
// carry the same "url-safe identifier" shape but are otherwise independent
// values (a book's canonical key never appears in a URL; its localized slug
// does).
const kebabCase = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens.");

// A content language is a registry code (content_languages), not a UI locale: a French original is
// neither vi, en nor ja. The database foreign key decides which codes exist; this only rejects
// malformed input early.
export const contentLanguageSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, "Choose a valid language code.");

// Locale is the UI language the localization is written in; language is the
// book's own language (original_language / editions.language_code). They are
// deliberately independent - a Vietnamese-locale page can describe an
// English-language book, and vice versa - so neither is derived from the
// other anywhere in this schema.
export const createBookSchema = z
  .object({
    canonicalKey: kebabCase,
    authorId: z.uuid({ error: "Choose a valid author." }).nullable().default(null),
    authorName: z.string().trim(),
    locale: z.enum(locales),
    language: contentLanguageSchema,
    title: z.string().trim().min(1, "Enter a title."),
    slug: kebabCase,
    market: z
      .string()
      .regex(/^[A-Z]{2}$/, "Use a two-letter uppercase market code, e.g. VN."),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, e.g. VND."),
    priceMinor: z.number().int().min(0, "Price cannot be negative."),
  })
  .superRefine((value, context) => {
    if (value.authorId === null && value.authorName.length === 0) {
      context.addIssue({ code: "custom", message: "Enter a new author name or choose an existing author.", path: ["authorName"] });
    }
  });

export type CreateBookInput = z.infer<typeof createBookSchema>;

const localeSchema = z.enum(locales);
const nullableText = (max: number) => z.string().trim().max(max).nullable();

export const MAX_COVER_SIZE_BYTES = 5 * 1024 * 1024;
export const COVER_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const contentStatusSchema = z.enum(["draft", "published", "archived"]);

export const entityBaseSchema = z.object({
  canonicalSlug: kebabCase,
  name: z.string().trim().min(1, "Enter a name.").max(200),
  status: contentStatusSchema,
  // Authors only: whether readers may ask this author questions. Series and topics ignore it.
  acceptsQuestions: z.boolean().default(true),
});

export const entityLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  name: z.string().trim().min(1, "Enter a name.").max(200),
  description: nullableText(5000),
  // Authors only - board 1e sets one pull quote above the description. The database drops it for
  // series and topics, so the shared form can always post the field, and a form that omits it
  // (every non-author editor before this change) still parses.
  quote: nullableText(500).default(null),
});

// The author portrait from board 1e, uploaded like a book cover.
export const authorImageSchema = z.object({
  mimeType: z.enum(COVER_MIME_TYPES, { error: "Upload a JPEG, PNG, or WebP image." }),
  sizeBytes: z
    .number()
    .int()
    .positive("The selected file is empty.")
    .max(MAX_COVER_SIZE_BYTES, "Portraits must be 5 MB or smaller."),
});

export const authorImageAltTextSchema = z.string().trim().min(1, "Describe the portrait for screen readers.").max(300);

const keyIdeaSchema = z.object({
  title: z.string().trim().min(1, "Each key idea needs a title.").max(200),
  summary: z.string().trim().max(1000),
});

const faqItemSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(2000),
});

export const bookLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  title: z.string().trim().min(1, "Enter a title.").max(300),
  subtitle: nullableText(300),
  shortDescription: nullableText(500),
  description: nullableText(10000),
  audience: nullableText(2000),
  keyIdeas: z.array(keyIdeaSchema).max(12, "Use at most 12 key ideas."),
  faq: z.array(faqItemSchema).max(20, "Use at most 20 questions."),
  seoTitle: z.string().trim().max(70, "Keep the SEO title to 70 characters.").nullable(),
  seoDescription: z.string().trim().max(160, "Keep the SEO description to 160 characters.").nullable(),
});

export const bookDetailsSchema = z.object({
  canonicalKey: kebabCase,
  originalLanguage: contentLanguageSchema,
  primaryAuthorId: z.uuid({ error: "Choose an author." }),
});

// A credit on an edition: who did what (translator, editor, illustrator...).
const contributorSchema = z.object({
  role: z.string().trim().min(1, "Enter a role.").max(40),
  name: z.string().trim().min(1, "Enter a name.").max(120),
});

export const editionSchema = z.object({
  languageCode: contentLanguageSchema,
  isbn: z
    .string()
    .trim()
    .regex(/^(97[89]\d{10}|\d{9}[\dX])$/, "Use a 10 or 13 digit ISBN without dashes.")
    .nullable(),
  editionNumber: z.number({ error: "Enter the edition number." }).int().min(1),
  publicationDate: z.iso.date({ error: "Use a date like 2026-09-13." }).nullable(),
  introduction: z.string().trim().max(5000, "Keep the introduction to 5000 characters.").nullable().default(null),
  contributors: z.array(contributorSchema).max(20, "Use at most 20 credits.").default([]),
});

// Where the text and its translation come from, and the rights evidence an approver looks at. Notes,
// not a legal determination.
const provenanceNote = z.string().trim().max(2000, "Keep each note to 2000 characters.").nullable();
export const provenanceSchema = z.object({
  textSourceNote: provenanceNote,
  translationSource: provenanceNote,
  rightsNote: provenanceNote,
  territoryNote: provenanceNote,
});

export const editionReviewSchema = z.object({
  state: z.enum(["unreviewed", "approved", "blocked"]),
  note: provenanceNote,
});

// A new edition of an existing work. The number defaults to the next free one for that language.
export const createEditionSchema = z.object({
  languageCode: contentLanguageSchema,
  editionNumber: z.number().int().min(1, "Edition numbers start at 1.").nullable(),
});

// A new offer on an edition. The price is required: an unset price must never become a free offer
// (free is an explicit 0).
export const createOfferSchema = z.object({
  marketCode: z.string().regex(/^[A-Z]{2}$/, "Use a two-letter uppercase market code, e.g. JP."),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, e.g. JPY."),
  priceMinor: z.number({ error: "Enter a price." }).int().min(0, "Price cannot be negative."),
});

// The price fields every offer form shares. A bundle offer is exactly these (no sale, S19 spec 2).
const offerPriceSchema = z.object({
  marketCode: z.string().regex(/^[A-Z]{2}$/, "Use a two-letter uppercase market code, e.g. VN."),
  currency: z.string().regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code, e.g. VND."),
  priceMinor: z.number({ error: "Enter a price." }).int().min(0, "Price cannot be negative."),
  active: z.boolean(),
});

// A datetime-local value, "YYYY-MM-DDTHH:mm", entered and stored as UTC (the "(UTC)" labels say
// so), made explicit here so the database never reads it in its session time zone.
const utcMinute = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a date and time.")
  .transform((value) => `${value}:00Z`)
  .nullable();

// S19: the sale fields mirror the offers_sale_* CHECK constraints, so a mistake is a field error
// rather than a database refusal. The database stays the authority. Fields the chosen kind does not
// use are nulled before validation, so a stale value left in a hidden field cannot block the save:
// no sale clears all five, and each kind keeps only its own value.
type SaleFieldsInput = { saleKind?: unknown; salePercentOff?: unknown; saleAmountOffMinor?: unknown; saleStartsAt?: unknown; saleEndsAt?: unknown };
const dropUnusedSaleFields = (value: unknown) => {
  if (typeof value !== "object" || value === null) return value;
  const sale = value as SaleFieldsInput;
  return {
    ...sale,
    ...(sale.saleKind !== "percent" && { salePercentOff: null }),
    ...(sale.saleKind !== "fixed" && { saleAmountOffMinor: null }),
    ...(sale.saleKind === "none" && { saleStartsAt: null, saleEndsAt: null }),
  };
};

export const offerSchema = z.preprocess(dropUnusedSaleFields, offerPriceSchema
  .extend({
    saleKind: z.enum(["none", "percent", "fixed"]),
    salePercentOff: z.number().int().min(1, "Use 1–99%.").max(99, "Use 1–99%.").nullable(),
    saleAmountOffMinor: z.number().int().positive("Enter an amount above 0.").nullable(),
    saleStartsAt: utcMinute,
    saleEndsAt: utcMinute,
  })
  .superRefine((value, ctx) => {
    if (value.saleKind === "none") return;
    if (value.priceMinor === 0) ctx.addIssue({ code: "custom", message: "A free book cannot be on sale.", path: ["saleKind"] });
    if (value.saleKind === "percent" && value.salePercentOff === null) {
      ctx.addIssue({ code: "custom", message: "Enter a percentage.", path: ["salePercentOff"] });
    }
    if (value.saleKind === "fixed" && (value.saleAmountOffMinor === null || value.saleAmountOffMinor >= value.priceMinor)) {
      ctx.addIssue({ code: "custom", message: "Enter an amount below the price.", path: ["saleAmountOffMinor"] });
    }
    if (value.saleStartsAt && value.saleEndsAt && Date.parse(value.saleEndsAt) <= Date.parse(value.saleStartsAt)) {
      ctx.addIssue({ code: "custom", message: "The sale must end after it starts.", path: ["saleEndsAt"] });
    }
  })
  .transform(({ saleKind, salePercentOff, saleAmountOffMinor, saleStartsAt, saleEndsAt, ...offer }) => ({
    ...offer,
    sale:
      saleKind === "none"
        ? null
        : {
            kind: saleKind,
            percentOff: salePercentOff,
            amountOffMinor: saleAmountOffMinor,
            startsAt: saleStartsAt,
            endsAt: saleEndsAt,
          },
  })));

export const bookRelationsSchema = z
  .object({
    topicIds: z.array(z.uuid()),
    seriesId: z.uuid().nullable(),
    seriesPosition: z.number().int().min(1, "Positions start at 1.").nullable(),
  })
  .refine((value) => value.seriesId === null || value.seriesPosition !== null, {
    message: "Enter the book's position in the series.",
    path: ["seriesPosition"],
  });

// S11 editorial pins. The submitted order IS the pin order: admin_set_related_books replaces the
// whole set and renumbers it 1..N, so the picker posts the complete list on every save rather than
// per-row positions that could disagree with each other. The relation is directed - pinning B
// under A says nothing about what A appears under.
// The duplicate rule is refined on the object, not on the array: a refinement attached to the
// field would report at ["relatedBookIds", "relatedBookIds"], and fieldErrorsFrom would key it
// "relatedBookIds.relatedBookIds" - out of reach of the picker's one error slot.
export const relatedBooksSchema = z
  .object({
    relatedBookIds: z.array(z.uuid()),
  })
  .refine((value) => new Set(value.relatedBookIds).size === value.relatedBookIds.length, {
    message: "Each related book can appear once.",
    path: ["relatedBookIds"],
  });

export const coverUploadSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.enum(COVER_MIME_TYPES, { error: "Upload a JPEG, PNG, or WebP image." }),
  sizeBytes: z
    .number()
    .int()
    .positive("The selected file is empty.")
    .max(MAX_COVER_SIZE_BYTES, "Cover images must be 5 MB or smaller."),
});

export const coverAltTextSchema = z.string().trim().min(1, "Describe the cover for screen readers.").max(300);

// S10 home hero. The admin crops in the browser and uploads two WebP renditions - a wide one for
// desktop and a tall one for phones - so neither viewport downloads pixels it then crops away.
export const HERO_ASPECTS = { desktop: 16 / 9, mobile: 4 / 5 } as const;
export const HERO_TARGET_WIDTH = { desktop: 2000, mobile: 1200 } as const;
export const MAX_HERO_SIZE_BYTES = 8 * 1024 * 1024;

export const heroUploadSchema = z.object({
  variant: z.enum(["desktop", "mobile"]),
  mimeType: z.enum(COVER_MIME_TYPES, { error: "Upload a JPEG, PNG, or WebP image." }),
  sizeBytes: z
    .number()
    .int()
    .positive("The selected file is empty.")
    .max(MAX_HERO_SIZE_BYTES, "Hero images must be 8 MB or smaller."),
});

export const heroAltTextSchema = z.string().trim().min(1, "Describe the hero image for screen readers.").max(300);

export const merchandisingSchema = z
  .object({
    slotKey: z.enum(["home_featured", "home_shelf"]),
    bookIds: z.array(z.uuid()),
  })
  .refine((value) => value.slotKey !== "home_featured" || value.bookIds.length <= 1, {
    message: "The featured slot holds one book.",
    path: ["bookIds"],
  })
  .refine((value) => new Set(value.bookIds).size === value.bookIds.length, {
    message: "Each book can appear once.",
    path: ["bookIds"],
  });

// S8: the coupon editor (spec 7.2). A Server Action is a public POST endpoint, so every field
// arrives as untrusted text and is shaped here before it reaches the RPC.
export const couponSchema = z
  .object({
    code: z
      .string()
      .transform((value) => normalizeCouponCode(value))
      .refine((value) => isCouponCode(value), { message: "Use 3–32 letters, digits, or hyphens." }),
    kind: z.enum(["percent", "fixed"]),
    percentOff: z.number().int().min(1).max(100).nullable(),
    amountOffMinor: z.number().int().positive().nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/, { message: "Use a three-letter currency code." })
      .nullable(),
    startsAt: z.string().nullable(),
    endsAt: z.string().nullable(),
    active: z.boolean(),
    maxRedemptions: z.number().int().positive().nullable(),
    maxRedemptionsPerProfile: z.number().int().positive(),
    note: z.string().max(500).nullable(),
    // S9 (spec 8): two independent scopes. A bundle is a separately priced subject, so a coupon
    // scoped to one of its member books is not scoped to the bundle - bundleIds is never derived
    // from bookIds, here or anywhere below it.
    bookIds: z.array(z.uuid()),
    bundleIds: z.array(z.uuid()),
  })
  .refine((value) => value.kind !== "percent" || value.percentOff !== null, {
    message: "Enter a percentage.",
    path: ["percentOff"],
  })
  .refine((value) => value.kind !== "fixed" || (value.amountOffMinor !== null && value.currency !== null), {
    message: "Enter an amount and a currency.",
    path: ["amountOffMinor"],
  });

// S9: the bundle editor (spec 6.4). A bundle has no canonical key and no non-localized copy, so
// creating one is exactly "give the first locale a slug and a title"; everything else - members,
// price, cover, status - is set afterwards through its own audited RPC.
export const createBundleSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  title: z.string().trim().min(1, "Enter a title.").max(300),
});

export const bundleLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  title: z.string().trim().min(1, "Enter a title.").max(300),
  subtitle: nullableText(300),
  description: nullableText(10000),
});

// The submitted order IS the member order: admin_set_bundle_members numbers the list with
// `unnest(...) with ordinality`, so reordering in the editor means posting the complete list
// again rather than sending per-row positions that could disagree with each other.
export const bundleMembersSchema = z
  .object({
    editionIds: z.array(z.uuid()).min(1, "Add at least one edition."),
  })
  .refine((value) => new Set(value.editionIds).size === value.editionIds.length, {
    message: "Each edition can appear once.",
    path: ["editionIds"],
  });

// A bundle is priced through the same offers row shape as a sku (spec 6.1), so the offer form is
// the same form - with one rule of its own, which is where the two have now diverged.
//
// A book may legitimately be free: a free offer is how a book is given away, and resolveBookAction
// has a branch for it. A bundle may not. create_bundle_order sells only a price above 0, so an
// active free bundle offer produced a bundle that passed the publish gate and then answered
// `unavailable` on its own page. admin_set_bundle_offer refuses it too; this is the same refusal
// said early, as a field error the admin can act on rather than a raw 22023.
export const bundleOfferSchema = offerPriceSchema.refine(
  (value) => !(value.active && value.priceMinor === 0),
  { message: "An active bundle offer needs a price above 0.", path: ["priceMinor"] },
);

export const bundleCoverAltTextSchema = z
  .string()
  .trim()
  .min(1, "Describe the bundle cover for screen readers.")
  .max(300);

// S12: the knowledge-hub editors (spec 9). Every editorial text field refuses HTML-tag syntax with
// the same pattern the block schema uses; React escaping stays the second boundary for ordinary
// `<` and `>` that are not tags. Ideas and articles have no unlocalized name, so creating one is
// creating its first localization; blocks, relations, SEO, and publication follow in the editor.
const htmlTagPattern = /<\/?[a-z][^>]*>/i;
const noHtml = { error: "HTML is not allowed. Use plain text." } as const;

const editorialText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `Enter ${label}.`)
    .max(max)
    .refine((value) => !htmlTagPattern.test(value), noHtml);

const editorialOptionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .refine((value) => !htmlTagPattern.test(value), noHtml)
    .nullable();

// The editor posts the whole block list as one JSON string in a hidden field. A parse failure is an
// issue on `bodyBlocks` itself; a block failure keeps its own path (bodyBlocks.3.content.0.text), so
// the editor can show it beside the block that caused it.
const bodyBlocksField = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: "custom", message: "The content could not be read. Reload and try again." });
      return z.NEVER;
    }
  })
  .pipe(knowledgeBlocksSchema);

const ideaQuestion = editorialText("a question", 300);
const ideaShortAnswer = editorialText("a short answer", 1000);
const articleTitle = editorialText("a title", 300);
const articleExcerpt = editorialText("an excerpt", 1000);

export const ideaCreateSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  question: ideaQuestion,
  shortAnswer: ideaShortAnswer,
});

export const articleCreateSchema = z.object({
  authorId: z.uuid({ error: "Choose an author." }),
  locale: localeSchema,
  slug: kebabCase,
  title: articleTitle,
  excerpt: articleExcerpt,
});

export const articleDetailsSchema = z.object({
  authorId: z.uuid({ error: "Choose an author." }),
});

export const ideaLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  question: ideaQuestion,
  shortAnswer: ideaShortAnswer,
  bodyBlocks: bodyBlocksField,
});

export const articleLocalizationSchema = z.object({
  locale: localeSchema,
  slug: kebabCase,
  title: articleTitle,
  excerpt: articleExcerpt,
  bodyBlocks: bodyBlocksField,
});

export const knowledgeSeoSchema = z.object({
  locale: localeSchema,
  seoTitle: editorialOptionalText(70, "Keep the SEO title to 70 characters."),
  seoDescription: editorialOptionalText(160, "Keep the SEO description to 160 characters."),
});

// The submitted order IS the editorial order for books and ideas: the relation RPCs number each list
// with `with ordinality`. Topics are a set. A repeated id is refused by the RPC as 22023, so it is
// refused here first as a field error; refinements sit on the object so the error key is the field
// name itself, not "bookIds.bookIds".
const isUnique = (ids: string[]) => new Set(ids).size === ids.length;

export const ideaRelationsSchema = z
  .object({ bookIds: z.array(z.uuid()), topicIds: z.array(z.uuid()), relatedIdeaIds: z.array(z.uuid()) })
  .refine((value) => isUnique(value.bookIds), { message: "Each book can appear once.", path: ["bookIds"] })
  .refine((value) => isUnique(value.topicIds), { message: "Each topic can appear once.", path: ["topicIds"] })
  .refine((value) => isUnique(value.relatedIdeaIds), { message: "Each idea can appear once.", path: ["relatedIdeaIds"] });

export const articleRelationsSchema = z
  .object({ bookIds: z.array(z.uuid()), ideaIds: z.array(z.uuid()), topicIds: z.array(z.uuid()) })
  .refine((value) => isUnique(value.bookIds), { message: "Each book can appear once.", path: ["bookIds"] })
  .refine((value) => isUnique(value.ideaIds), { message: "Each idea can appear once.", path: ["ideaIds"] })
  .refine((value) => isUnique(value.topicIds), { message: "Each topic can appear once.", path: ["topicIds"] });

// Knowledge images share the public covers bucket and the cover file rules.
export const knowledgeImageUploadSchema = z.object({
  mimeType: z.enum(COVER_MIME_TYPES, { error: "Upload a JPEG, PNG, or WebP image." }),
  sizeBytes: z
    .number()
    .int()
    .positive("The selected file is empty.")
    .max(MAX_COVER_SIZE_BYTES, "Images must be 5 MB or smaller."),
});

export type IdeaCreateInput = z.infer<typeof ideaCreateSchema>;
export type ArticleCreateInput = z.infer<typeof articleCreateSchema>;
export type ArticleDetailsInput = z.infer<typeof articleDetailsSchema>;
export type IdeaLocalizationInput = z.infer<typeof ideaLocalizationSchema>;
export type ArticleLocalizationInput = z.infer<typeof articleLocalizationSchema>;
export type KnowledgeSeoInput = z.infer<typeof knowledgeSeoSchema>;
export type IdeaRelationsInput = z.infer<typeof ideaRelationsSchema>;
export type ArticleRelationsInput = z.infer<typeof articleRelationsSchema>;
export type KnowledgeImageUploadInput = z.infer<typeof knowledgeImageUploadSchema>;

export type CreateBundleInput = z.infer<typeof createBundleSchema>;
export type BundleLocalizationInput = z.infer<typeof bundleLocalizationSchema>;
export type BundleMembersInput = z.infer<typeof bundleMembersSchema>;
export type BundleOfferInput = z.infer<typeof bundleOfferSchema>;

export type CouponInput = z.infer<typeof couponSchema>;

export type EntityBaseInput = z.infer<typeof entityBaseSchema>;
export type EntityLocalizationInput = z.infer<typeof entityLocalizationSchema>;
export type BookLocalizationInput = z.infer<typeof bookLocalizationSchema>;
export type BookDetailsInput = z.infer<typeof bookDetailsSchema>;
export type EditionInput = z.infer<typeof editionSchema>;
export type ProvenanceInput = z.infer<typeof provenanceSchema>;
export type EditionReviewInput = z.infer<typeof editionReviewSchema>;
export type CreateEditionInput = z.infer<typeof createEditionSchema>;
export type CreateOfferInput = z.infer<typeof createOfferSchema>;
export type OfferInput = z.output<typeof offerSchema>;
export type BookRelationsInput = z.infer<typeof bookRelationsSchema>;
export type RelatedBooksInput = z.infer<typeof relatedBooksSchema>;
export type CoverUploadInput = z.infer<typeof coverUploadSchema>;
export type HeroUploadInput = z.infer<typeof heroUploadSchema>;
export type AuthorImageInput = z.infer<typeof authorImageSchema>;
export type MerchandisingInput = z.infer<typeof merchandisingSchema>;

// The platform defaults (spec section 5). The RPC re-checks every code against the registries.
export const platformSettingsSchema = z.object({
  defaultUiLocale: localeSchema,
  defaultContentLanguage: contentLanguageSchema,
  defaultMetadataLocale: localeSchema,
});
export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;
