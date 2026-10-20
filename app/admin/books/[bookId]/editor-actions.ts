"use server";

import { requireAdmin } from "@/lib/auth/admin";
import {
  fieldErrorsFrom,
  parseFaq,
  parseKeyIdeas,
  readBoolean,
  readInteger,
  readList,
  readOptionalInteger,
  readOptionalText,
  readText,
  type AdminFormState,
} from "@/lib/catalog/form";
import { retailLinksSchema } from "@/lib/catalog/retail";
import { revalidateBookAdmin } from "@/lib/catalog/revalidate";
import {
  bookDetailsSchema,
  bookLocalizationSchema,
  bookRelationsSchema,
  editionSchema,
  offerSchema,
  relatedBooksSchema,
} from "@/lib/catalog/schemas";
import {
  BookNotFoundError,
  DuplicateCanonicalKeyError,
  DuplicateSlugError,
  saveBookLocalization,
  SeriesPositionTakenError,
  setBookRelations,
  setBookRetailLinks,
  setRelatedBooks,
  updateBookDetails,
  updateEdition,
  updateOffer,
} from "@/lib/data/books";

// Every runtime export of a "use server" module must be an async function. Each action calls
// requireAdmin() before parsing, never returns raw database text, and revalidates the book pages.

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const invalid = (error: Parameters<typeof fieldErrorsFrom>[0]): AdminFormState => ({
  fieldErrors: fieldErrorsFrom(error),
  formError: null,
  savedAt: null,
});

function knownFailure(error: unknown): AdminFormState {
  if (error instanceof DuplicateCanonicalKeyError) return { fieldErrors: { canonicalKey: error.message }, formError: null, savedAt: null };
  if (error instanceof DuplicateSlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
  if (error instanceof SeriesPositionTakenError) return { fieldErrors: { seriesPosition: error.message }, formError: null, savedAt: null };
  if (error instanceof BookNotFoundError) return { fieldErrors: {}, formError: error.message, savedAt: null };
  return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
}

export async function updateBookDetailsAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = bookDetailsSchema.safeParse({
    canonicalKey: readText(formData, "canonicalKey"),
    originalLanguage: readText(formData, "originalLanguage"),
    primaryAuthorId: readText(formData, "primaryAuthorId"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateBookDetails(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function saveBookLocalizationAction(
  bookId: string,
  locale: "vi" | "en",
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = bookLocalizationSchema.safeParse({
    locale,
    slug: readText(formData, "slug"),
    title: readText(formData, "title"),
    subtitle: readOptionalText(formData, "subtitle"),
    shortDescription: readOptionalText(formData, "shortDescription"),
    description: readOptionalText(formData, "description"),
    audience: readOptionalText(formData, "audience"),
    keyIdeas: parseKeyIdeas(readText(formData, "keyIdeas")),
    faq: parseFaq(readText(formData, "faq")),
    seoTitle: readOptionalText(formData, "seoTitle"),
    seoDescription: readOptionalText(formData, "seoDescription"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveBookLocalization(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function updateEditionAction(
  bookId: string,
  editionId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = editionSchema.safeParse({
    languageCode: readText(formData, "languageCode"),
    isbn: readOptionalText(formData, "isbn"),
    editionNumber: readInteger(formData, "editionNumber"),
    publicationDate: readOptionalText(formData, "publicationDate"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateEdition(editionId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function updateOfferAction(
  bookId: string,
  offerId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = offerSchema.safeParse({
    marketCode: readText(formData, "marketCode"),
    currency: readText(formData, "currency"),
    priceMinor: readInteger(formData, "priceMinor"),
    active: readBoolean(formData, "active"),
    saleKind: readText(formData, "saleKind") || "none",
    salePercentOff: readOptionalInteger(formData, "salePercentOff"),
    saleAmountOffMinor: readOptionalInteger(formData, "saleAmountOffMinor"),
    saleStartsAt: readOptionalText(formData, "saleStartsAt"),
    saleEndsAt: readOptionalText(formData, "saleEndsAt"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateOffer(offerId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

export async function setBookRelationsAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const seriesId = readOptionalText(formData, "seriesId");
  const parsed = bookRelationsSchema.safeParse({
    topicIds: readList(formData, "topicIds"),
    seriesId,
    seriesPosition: seriesId === null ? null : readOptionalInteger(formData, "seriesPosition"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setBookRelations(bookId, parsed.data);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

// The picker posts one relatedBookIds field per pin, in the order the admin arranged them, and
// admin_set_related_books renumbers that list 1..N. A missing source book or a pin that points at
// a book that no longer exists both arrive as P0002, which the DAL has already turned into
// BookNotFoundError; no database text reaches the browser.
export async function setRelatedBooksAction(
  bookId: string,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  const parsed = relatedBooksSchema.safeParse({ relatedBookIds: readList(formData, "relatedBookIds") });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setRelatedBooks(bookId, parsed.data.relatedBookIds);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}

// The form posts indexed rows (links[0].url, ...) plus linkCount, and the row order IS the stored
// position: admin_set_book_retail_links replaces the whole set and numbers it from the array order.
// linkCount is untrusted: a count above the ten-row cap is refused outright rather than truncated,
// because the RPC replaces the whole set and a truncated post would silently drop the tail; a
// checkbox posts "on" only when ticked, so an absent field is false. A row with no price drops its
// currency (the form pre-fills one, and a link without a price is valid), while a price with no
// currency still reaches the schema and fails there. Anything the schema accepts but the RPC still
// refuses (22023, 23514, 22P02) reaches knownFailure as an unknown error and becomes the generic
// form message.
const MAX_RETAIL_LINKS = 10;

function readRetailLinks(formData: FormData, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const field = (name: string) => readOptionalText(formData, `links[${index}].${name}`);
    const priceMinor = readOptionalInteger(formData, `links[${index}].priceMinor`);
    return {
      retailer: field("retailer") ?? "",
      label: field("label"),
      url: field("url") ?? "",
      priceMinor,
      currency: priceMinor === null ? null : field("currency"),
      active: readBoolean(formData, `links[${index}].active`),
    };
  });
}

export async function saveRetailLinksAction(bookId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `/admin/books/${bookId}` });
  // A missing or garbled count must not read as "no rows": the RPC replaces the whole set, so that
  // would silently delete every link. Only a literal 0 clears it.
  const count = readInteger(formData, "linkCount");
  if (count === undefined || !Number.isInteger(count) || count < 0) {
    return { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null };
  }
  if (count > MAX_RETAIL_LINKS) {
    return { fieldErrors: {}, formError: `At most ${MAX_RETAIL_LINKS} retailer links per book.`, savedAt: null };
  }
  const parsed = retailLinksSchema.safeParse({ links: readRetailLinks(formData, count) });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setBookRetailLinks(bookId, parsed.data.links);
  } catch (error) {
    return knownFailure(error);
  }
  revalidateBookAdmin(bookId);
  return saved();
}
