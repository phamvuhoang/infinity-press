import "server-only";
import { type Locale, locales } from "@/lib/i18n/config";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { coverPublicUrl } from "@/lib/catalog/covers";
import type { Retailer, RetailLinkInput } from "@/lib/catalog/retail";
import { checkBookReadiness, parseReadinessError, type ReadinessIssueCode } from "@/lib/catalog/readiness";
import type {
  BookDetailsInput,
  BookLocalizationInput,
  BookRelationsInput,
  CreateBookInput,
  OfferInput,
} from "@/lib/catalog/schemas";
import { isOfferLive, offerColumns, type OfferRow } from "@/lib/data/admin-editions";
import { createClient } from "@/lib/supabase/server";

// Every function here runs requireAdmin() before building a client, then uses the session client:
// the catalog RPCs check is_admin() through auth.uid(), which is null under the service role, and
// direct writes rely on the is_admin() RLS policies from 20260913100000.

export class DuplicateCanonicalKeyError extends Error {
  constructor() {
    super("A book with this canonical key already exists.");
    this.name = "DuplicateCanonicalKeyError";
  }
}

export class DuplicateSlugError extends Error {
  constructor() {
    super("A book with this locale and slug already exists.");
    this.name = "DuplicateSlugError";
  }
}

export class SeriesPositionTakenError extends Error {
  constructor() {
    super("Another book already holds this position in the series.");
    this.name = "SeriesPositionTakenError";
  }
}

export class BookNotReadyError extends Error {
  readonly issues: ReadinessIssueCode[];

  constructor(issues: ReadinessIssueCode[]) {
    super("This book is not ready to publish.");
    this.name = "BookNotReadyError";
    this.issues = issues;
  }
}

export class BookNotFoundError extends Error {
  constructor() {
    super("This book no longer exists.");
    this.name = "BookNotFoundError";
  }
}

type DatabaseError = { code?: string; message: string };

// A unique_violation names its constraint only in the message; map the constraints an admin can
// actually cause to typed errors and keep everything else generic and server-side.
function mapUniqueViolation(error: DatabaseError): Error | null {
  if (error.code !== "23505") return null;
  if (error.message.includes("books_canonical_key_key")) return new DuplicateCanonicalKeyError();
  if (error.message.includes("book_localizations_locale_slug_key")) return new DuplicateSlugError();
  if (error.message.includes("book_series_series_id_position_key")) return new SeriesPositionTakenError();
  return null;
}

function failure(operation: string, error: DatabaseError): Error {
  if (error.code === "P0002") return new BookNotFoundError();
  return mapUniqueViolation(error) ?? new Error(`${operation} failed.`);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string) {
  if (!uuidPattern.test(value)) throw new BookNotFoundError();
}

export async function createBook(input: CreateBookInput): Promise<{ bookId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_create_book", {
    p_canonical_key: input.canonicalKey,
    p_author_id: input.authorId,
    p_author_name: input.authorName,
    p_locale: input.locale,
    p_language: input.language,
    p_title: input.title,
    p_slug: input.slug,
    p_market: input.market,
    p_currency: input.currency,
    p_price_minor: input.priceMinor,
  });

  if (error) throw failure("createBook: admin_create_book", error);
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createBook: admin_create_book returned no book id");
  }
  return { bookId: data };
}

export type BookLocalizationDTO = {
  id: string;
  locale: Locale;
  slug: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  description: string | null;
  audience: string | null;
  keyIdeas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seoTitle: string | null;
  seoDescription: string | null;
};

export type AdminRetailLinkDTO = {
  id: string;
  retailer: Retailer;
  label: string | null;
  url: string;
  priceMinor: number | null;
  currency: string | null;
  active: boolean;
};

// What the work page shows about an edition: enough to see its state and reach its own page.
export type AdminEditionSummaryDTO = {
  id: string;
  languageCode: string;
  editionNumber: number;
  status: "draft" | "published" | "archived";
  isDefault: boolean;
  activePublicationId: string | null;
  offerCount: number;
  hasLiveOffer: boolean;
};

export type AdminBookDTO = {
  id: string;
  canonicalKey: string;
  originalLanguage: string;
  status: "draft" | "published" | "archived";
  primaryAuthorId: string;
  authorName: string;
  localization: { locale: string; slug: string; title: string } | null;
  localizations: BookLocalizationDTO[];
  // One entry per language edition, ordered by language then number. Each is managed on its own page.
  editions: AdminEditionSummaryDTO[];
  cover: { storageKey: string; altText: string; publicUrl: string } | null;
  topicIds: string[];
  // Editorial pins, in saved position order. The relation is directed: these are the books pinned
  // under this one, not the books this one is pinned under.
  relatedBookIds: string[];
  series: { seriesId: string; position: number } | null;
  // Paperback retailers in saved position order, inactive rows included (admins read them all).
  retailLinks: AdminRetailLinkDTO[];
  readinessIssues: ReadinessIssueCode[];
};

export type AdminBookListItemDTO = {
  id: string;
  canonicalKey: string;
  title: string;
  authorName: string;
  status: AdminBookDTO["status"];
  hasActivePublication: boolean;
  readinessIssues: ReadinessIssueCode[];
};

type LocalizationRow = {
  id: string;
  locale: Locale;
  slug: string;
  title: string;
  subtitle: string | null;
  short_description: string | null;
  description: string | null;
  audience: string | null;
  key_ideas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seo_title: string | null;
  seo_description: string | null;
};

type BookRow = {
  id: string;
  canonical_key: string;
  original_language: string;
  status: AdminBookDTO["status"];
  primary_author_id: string;
  author: { display_name: string; localizations: { id: string }[] } | null;
  localizations: LocalizationRow[];
  editions: {
    id: string;
    language_code: string;
    edition_number: number;
    status: AdminBookDTO["status"];
    active_publication_id: string | null;
    publication: { status: string } | { status: string }[] | null;
    skus: { id: string; active: boolean; offers: OfferRow[] }[];
  }[];
  defaults: { language_code: string; edition_id: string }[];
  topics: { topic_id: string }[];
  related: { related_book_id: string; position: number }[];
  retail_links: {
    id: string;
    retailer: string;
    label: string | null;
    url: string;
    price_minor: number | null;
    currency: string | null;
    position: number;
    active: boolean;
  }[];
  // One-to-one embeds arrive as an object or a one-element array depending on how PostgREST
  // resolves the relationship; oneOrNull() accepts both.
  series: { series_id: string; position: number } | { series_id: string; position: number }[] | null;
};

const bookSelect = `
  id,
  canonical_key,
  original_language,
  status,
  primary_author_id,
  author:authors ( display_name, localizations:author_localizations ( id ) ),
  localizations:book_localizations ( id, locale, slug, title, subtitle, short_description, description, audience, key_ideas, faq, seo_title, seo_description ),
  editions ( id, language_code, edition_number, status, active_publication_id, publication:ebook_publications!editions_active_publication_id_fkey ( status ), skus ( id, active, offers ( ${offerColumns} ) ) ),
  defaults:book_language_editions ( language_code, edition_id ),
  topics:book_topics ( topic_id ),
  related:related_books!related_books_book_id_fkey ( related_book_id, position ),
  retail_links:book_retail_links ( id, retailer, label, url, price_minor, currency, position, active ),
  series:book_series ( series_id, position )
`;

function oneOrNull<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

function toDto(row: BookRow, cover: { storage_key: string; alt_text: string } | null): AdminBookDTO {
  const localizations = [...row.localizations]
    .sort((a, b) => locales.indexOf(a.locale) - locales.indexOf(b.locale))
    .map((localization) => ({
      id: localization.id,
      locale: localization.locale,
      slug: localization.slug,
      title: localization.title,
      subtitle: localization.subtitle,
      shortDescription: localization.short_description,
      description: localization.description,
      audience: localization.audience,
      keyIdeas: localization.key_ideas ?? [],
      faq: localization.faq ?? [],
      seoTitle: localization.seo_title,
      seoDescription: localization.seo_description,
    }));

  const series = oneOrNull(row.series);
  const now = new Date();
  const defaultEditionIds = new Set(row.defaults.map((entry) => entry.edition_id));
  const editions: AdminEditionSummaryDTO[] = [...row.editions]
    .sort((a, b) => a.language_code.localeCompare(b.language_code) || a.edition_number - b.edition_number)
    .map((edition) => {
      const offers = edition.skus.filter((sku) => sku.active).flatMap((sku) => sku.offers);
      return {
        id: edition.id,
        languageCode: edition.language_code,
        editionNumber: edition.edition_number,
        status: edition.status,
        isDefault: defaultEditionIds.has(edition.id),
        activePublicationId: edition.active_publication_id,
        offerCount: offers.length,
        hasLiveOffer: offers.some((offer) => isOfferLive(offer, now)),
      };
    });

  const readinessIssues = checkBookReadiness({
    localizations,
    hasAuthor: Boolean(row.author?.localizations.length),
    hasCover: cover !== null,
    hasPublishedEdition: row.editions.some(
      (edition) => edition.status === "published" && oneOrNull(edition.publication)?.status === "published",
    ),
  });

  return {
    id: row.id,
    canonicalKey: row.canonical_key,
    originalLanguage: row.original_language,
    status: row.status,
    primaryAuthorId: row.primary_author_id,
    authorName: row.author?.display_name ?? "",
    localization: localizations[0]
      ? { locale: localizations[0].locale, slug: localizations[0].slug, title: localizations[0].title }
      : null,
    localizations,
    editions,
    cover: cover
      ? { storageKey: cover.storage_key, altText: cover.alt_text, publicUrl: coverPublicUrl(cover.storage_key) }
      : null,
    topicIds: row.topics.map((topic) => topic.topic_id),
    // PostgREST does not promise an embed order, so the saved position is the only order there is.
    relatedBookIds: [...row.related].sort((a, b) => a.position - b.position).map((pin) => pin.related_book_id),
    retailLinks: [...row.retail_links]
      .sort((a, b) => a.position - b.position)
      .map((link) => ({
        id: link.id,
        retailer: link.retailer as Retailer,
        label: link.label,
        url: link.url,
        priceMinor: link.price_minor === null ? null : Number(link.price_minor),
        currency: link.currency,
        active: link.active,
      })),
    series: series ? { seriesId: series.series_id, position: series.position } : null,
    readinessIssues,
  };
}

export async function getAdminBook(bookId: string): Promise<AdminBookDTO> {
  await requireAdmin();
  if (!uuidPattern.test(bookId)) notFound();

  const supabase = await createClient();
  const [{ data: row, error }, { data: cover, error: coverError }] = await Promise.all([
    supabase.from("books").select(bookSelect).eq("id", bookId).maybeSingle(),
    supabase.rpc("admin_get_book_cover", { p_book_id: bookId }),
  ]);

  if (error) throw failure("getAdminBook: load book", error);
  if (coverError) throw failure("getAdminBook: load cover", coverError);
  if (!row) notFound();

  return toDto(row as unknown as BookRow, cover?.[0] ?? null);
}

export async function listAdminBooks(search?: string): Promise<AdminBookListItemDTO[]> {
  await requireAdmin();

  const supabase = await createClient();
  const [{ data: rows, error }, { data: covers, error: coverError }] = await Promise.all([
    supabase.from("books").select(bookSelect).order("updated_at", { ascending: false }),
    // The list only needs the presence of a cover for readiness. storage_key remains unavailable
    // to browser roles by design, so do not select it through this authenticated session client.
    supabase.from("media_assets").select("owner_id, alt_text").eq("owner_type", "book").eq("kind", "cover"),
  ]);

  if (error) throw failure("listAdminBooks", error);
  if (coverError) throw failure("listAdminBooks: covers", coverError);

  const coverByBook = new Map(
    ((covers ?? []) as { owner_id: string; storage_key?: string; alt_text?: string }[]).map((cover) => [
      cover.owner_id,
      { storage_key: cover.storage_key ?? "", alt_text: cover.alt_text ?? "" },
    ]),
  );
  const needle = search?.trim().toLocaleLowerCase("vi") ?? "";

  return ((rows ?? []) as unknown as BookRow[])
    .map((row) => toDto(row, coverByBook.get(row.id) ?? null))
    .filter(
      (book) =>
        needle === "" ||
        book.canonicalKey.includes(needle) ||
        book.localizations.some((localization) => localization.title.toLocaleLowerCase("vi").includes(needle)),
    )
    .map((book) => ({
      id: book.id,
      canonicalKey: book.canonicalKey,
      title: book.localization?.title ?? book.canonicalKey,
      authorName: book.authorName,
      status: book.status,
      hasActivePublication: book.editions.some((edition) => edition.activePublicationId !== null),
      readinessIssues: book.readinessIssues,
    }));
}

export async function updateBookDetails(bookId: string, input: BookDetailsInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .update({
      canonical_key: input.canonicalKey,
      original_language: input.originalLanguage,
      primary_author_id: input.primaryAuthorId,
    })
    .eq("id", bookId)
    .select("id");

  if (error) throw failure("updateBookDetails", error);
  if (!data || data.length === 0) throw new BookNotFoundError();
}

export async function saveBookLocalization(bookId: string, input: BookLocalizationInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_save_book_localization", {
    p_book_id: bookId,
    p_locale: input.locale,
    p_slug: input.slug,
    p_title: input.title,
    p_subtitle: input.subtitle,
    p_short_description: input.shortDescription,
    p_description: input.description,
    p_audience: input.audience,
    p_key_ideas: input.keyIdeas,
    p_faq: input.faq,
    p_seo_title: input.seoTitle,
    p_seo_description: input.seoDescription,
  });

  if (error) throw failure("saveBookLocalization", error);
}

export async function updateOffer(offerId: string, input: OfferInput): Promise<void> {
  await requireAdmin();
  assertUuid(offerId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("offers")
    .update({
      market_code: input.marketCode,
      currency: input.currency,
      price_minor: input.priceMinor,
      active: input.active,
      sale_kind: input.sale?.kind ?? null,
      sale_percent_off: input.sale?.percentOff ?? null,
      sale_amount_off_minor: input.sale?.amountOffMinor ?? null,
      sale_starts_at: input.sale?.startsAt ?? null,
      sale_ends_at: input.sale?.endsAt ?? null,
    })
    .eq("id", offerId)
    .select("id");

  if (error) throw failure("updateOffer", error);
  if (!data || data.length === 0) throw new BookNotFoundError();
}

export async function setBookRelations(bookId: string, input: BookRelationsInput): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_relations", {
    p_book_id: bookId,
    p_topic_ids: input.topicIds,
    p_series_id: input.seriesId,
    p_series_position: input.seriesPosition,
  });

  if (error) throw failure("setBookRelations", error);
}

export async function setRelatedBooks(bookId: string, relatedBookIds: string[]): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_related_books", {
    p_book_id: bookId,
    p_related_book_ids: relatedBookIds,
  });

  if (error) throw failure("setRelatedBooks", error);
}

export async function setBookRetailLinks(bookId: string, links: RetailLinkInput[]): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_set_book_retail_links", { p_book_id: bookId, p_links: links });

  if (error) throw failure("setBookRetailLinks", error);
}

export async function publishBook(bookId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("publish_book", { p_book_id: bookId });
  if (!error) return;
  if (error.code === "EB010") throw new BookNotReadyError(parseReadinessError(error.message) ?? []);
  throw failure("publishBook", error);
}

export async function unpublishBook(bookId: string): Promise<void> {
  await requireAdmin();
  assertUuid(bookId);

  const supabase = await createClient();
  const { error } = await supabase.rpc("unpublish_book", { p_book_id: bookId });
  if (error) throw failure("unpublishBook", error);
}
