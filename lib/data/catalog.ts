import "server-only";
import { alternateSlugsSchema } from "@/lib/i18n/alternates";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import { retailers } from "@/lib/analytics/browser";
import { type BookAction, resolveBookAction } from "@/lib/catalog/book-action";
import { booksForEntity } from "@/lib/catalog/browse";
import { coverPublicUrl } from "@/lib/catalog/covers";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import type {
  CatalogBookCard,
  CatalogBookPage,
  CatalogEntityKind,
  CatalogEntityPage,
  CatalogHomeHero,
  CatalogHomeTopic,
} from "@/lib/catalog/public-types";
import {
  groupSearchHits,
  type SearchHit,
  searchHitKinds,
} from "@/lib/catalog/search";
import { getServerEnv } from "@/lib/config/server-env";
import { editionOptionsSchema } from "@/lib/data/editions";
import { getCurrentProfile } from "@/lib/data/profiles";
import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import { resolveSamplePublicationId } from "@/lib/reader/session";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// Public catalog reads. Everything except entitlements goes through the read functions in
// 20260915100000 and 20260915110000 with the cookie-less public client. Those functions filter to
// published rows themselves. Entitlements use the session client and an explicit profile filter,
// because admins can read every entitlement under RLS.

const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function currentRequestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    // Outside a request scope (for example a build-time render) there is no request ID.
    return null;
  }
}

// Callers and pages only see the generic message. The database or parse error stays on `cause` and
// goes to the server log once, with the request ID the proxy set.
async function failure(operation: string, cause: unknown): Promise<Error> {
  const detail =
    cause instanceof z.ZodError
      ? { code: "invalid_response", message: cause.message }
      : {
          code: (cause as { code?: string } | null)?.code ?? null,
          message:
            (cause as { message?: string } | null)?.message ?? String(cause),
        };
  console.error("Catalog read failed.", {
    operation,
    ...detail,
    requestId: await currentRequestId(),
  });
  return new Error(`${operation} failed.`, { cause });
}

// Generated types mark every returned column as non-null. These are the real shapes.
type CardRow = {
  book_id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  short_description: string | null;
  author_name: string;
  author_slug: string | null;
  cover_path: string | null;
  cover_alt: string | null;
  price_minor: number | null;
  currency: string | null;
  has_active_publication: boolean;
  has_sample: boolean;
  series_slug: string | null;
  series_name: string | null;
  series_position: number | null;
  topics: unknown;
  featured: boolean;
  shelf_position: number | null;
  created_at: string;
  list_price_minor: number | null;
  sale_ends_at: string | null;
  edition_id: string;
  language_code: string;
  is_language_fallback: boolean;
  metadata_locale: string;
};

const topicsSchema = z
  .array(z.object({ slug: z.string(), name: z.string() }))
  .catch([]);

function toCard(row: CardRow): CatalogBookCard {
  return {
    bookId: row.book_id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    shortDescription: row.short_description,
    author: { name: row.author_name, slug: row.author_slug },
    cover: row.cover_path
      ? { url: coverPublicUrl(row.cover_path), alt: row.cover_alt ?? row.title }
      : null,
    offer:
      row.price_minor === null || row.currency === null
        ? null
        : {
            priceMinor: Number(row.price_minor),
            currency: row.currency,
            listPriceMinor: row.list_price_minor === null ? null : Number(row.list_price_minor),
            saleEndsAt: row.sale_ends_at,
          },
    hasActivePublication: row.has_active_publication,
    hasSample: row.has_sample,
    editionId: row.edition_id,
    languageCode: row.language_code,
    isLanguageFallback: row.is_language_fallback,
    metadataLocale: row.metadata_locale,
    series:
      row.series_slug && row.series_name && row.series_position !== null
        ? {
            slug: row.series_slug,
            name: row.series_name,
            position: row.series_position,
          }
        : null,
    topics: topicsSchema.parse(row.topics),
    featured: row.featured,
    shelfPosition: row.shelf_position,
    createdAt: row.created_at,
  };
}

export const getBookCards = cache(
  async (locale: Locale): Promise<CatalogBookCard[]> => {
    const { data, error } = await createPublicClient().rpc(
      "catalog_book_cards",
      { p_locale: locale },
    );
    if (error) throw await failure("getBookCards", error);
    return ((data ?? []) as unknown as CardRow[]).map(toCard);
  },
);

// The targeted equivalent of getBookCards for the one caller that only wants one book: the
// action-state route handler. Mirrors getPublicBundleById in lib/data/public-bundles.ts - a single
// row by id instead of scanning the whole published catalog on every anonymous page view.
export const getBookCardById = cache(
  async (locale: Locale, bookId: string): Promise<CatalogBookCard | null> => {
    const { data, error } = await createPublicClient().rpc(
      "catalog_book_card_by_id",
      { p_locale: locale, p_book_id: bookId },
    );
    if (error) throw await failure("getBookCardById", error);
    const [row] = (data ?? []) as unknown as CardRow[];
    return row ? toCard(row) : null;
  },
);

// Whether the book's author takes reader questions (admin toggle on the author). False for an
// unknown or unpublished book, so callers gate the ask link on this alone.
export const getBookAcceptsQuestions = cache(async (bookId: string): Promise<boolean> => {
  const { data, error } = await createPublicClient().rpc("catalog_book_accepts_questions", { p_book_id: bookId });
  if (error) throw await failure("getBookAcceptsQuestions", error);
  return data === true;
});

// Invalid JSON content is dropped, not rendered. Admin writes validate it with the same shapes.
const bookPageSchema = z.object({
  bookId: z.string(),
  description: z.string().nullable(),
  audience: z.string().nullable(),
  keyIdeas: z
    .array(z.object({ title: z.string(), summary: z.string() }))
    .catch([]),
  faq: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .catch([]),
  seoTitle: z.string().nullable(),
  seoDescription: z.string().nullable(),
  alternateSlugs: alternateSlugsSchema,
  isbn: z.string().nullable().catch(null),
  metadataLocale: z.string(),
  editions: editionOptionsSchema,
  // One malformed row drops that row, not the whole block: a paperback button must not vanish for
  // every retailer because one stored link fails the enum or the URL rule.
  retailLinks: z
    .array(
      z
        .object({
          id: z.string(),
          retailer: z.enum(retailers),
          label: z.string().nullable(),
          url: z.string().regex(/^https:\/\/\S+$/),
          priceMinor: z.number().nullable(),
          currency: z.string().nullable(),
        })
        .nullable()
        .catch(null),
    )
    .catch([])
    .transform((links) => links.filter((link) => link !== null)),
  // A malformed summary hides the rating, not the page.
  reviewSummary: z
    .object({ count: z.number().int(), average: z.coerce.number() })
    .nullable()
    .catch(null),
});

export const getBookPage = cache(
  async (locale: Locale, slug: string): Promise<CatalogBookPage | null> => {
    if (!slugPattern.test(slug)) return null;

    const [cards, { data, error }] = await Promise.all([
      getBookCards(locale),
      createPublicClient().rpc("catalog_book_page", {
        p_locale: locale,
        p_slug: slug,
      }),
    ]);
    if (error) throw await failure("getBookPage", error);
    if (data === null) return null;

    const parsed = bookPageSchema.safeParse(data);
    if (!parsed.success) throw await failure("getBookPage", parsed.error);

    const card = cards.find(
      (candidate) => candidate.bookId === parsed.data.bookId,
    );
    return card ? { ...card, ...parsed.data } : null;
  },
);

const homeHeroSchema = z.object({
  desktopPath: z.string(),
  mobilePath: z.string(),
  altText: z.string(),
});

// The home hero image. Null is the ordinary state: no operator has set one yet, and the hero falls
// back to the Sand ground from board 1e.
export const getHomeHero = cache(async (): Promise<CatalogHomeHero | null> => {
  const { data, error } = await createPublicClient().rpc("catalog_home_hero");
  if (error) throw await failure("getHomeHero", error);
  if (data === null) return null;

  const parsed = homeHeroSchema.safeParse(data);
  if (!parsed.success) throw await failure("getHomeHero", parsed.error);
  return {
    desktopUrl: coverPublicUrl(parsed.data.desktopPath),
    mobileUrl: coverPublicUrl(parsed.data.mobilePath),
    alt: parsed.data.altText,
  };
});

// Topic entry points for the home page. Every row already has at least one published book, so each
// card leads to a page with content.
export const getHomeTopics = cache(
  async (locale: Locale): Promise<CatalogHomeTopic[]> => {
    const { data, error } = await createPublicClient().rpc(
      "catalog_home_topics",
      { p_locale: locale },
    );
    if (error) throw await failure("getHomeTopics", error);
    return (
      (data ?? []) as {
        slug: string;
        name: string;
        description: string | null;
      }[]
    ).map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
    }));
  },
);

const entityPageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  alternateSlugs: alternateSlugsSchema,
  quote: z.string().nullable().catch(null),
  imagePath: z.string().nullable().catch(null),
  imageAlt: z.string().nullable().catch(null),
});

export const getEntityPage = cache(
  async (
    kind: CatalogEntityKind,
    locale: Locale,
    slug: string,
  ): Promise<CatalogEntityPage | null> => {
    if (!slugPattern.test(slug)) return null;

    const [cards, { data, error }] = await Promise.all([
      getBookCards(locale),
      createPublicClient().rpc("catalog_entity_page", {
        p_kind: kind,
        p_locale: locale,
        p_slug: slug,
      }),
    ]);
    if (error) throw await failure("getEntityPage", error);
    if (data === null) return null;

    const parsed = entityPageSchema.safeParse(data);
    if (!parsed.success) throw await failure("getEntityPage", parsed.error);

    const books = booksForEntity(cards, kind, slug, locale);
    if (books.length === 0) return null;
    const { imagePath, imageAlt, ...entity } = parsed.data;
    return {
      kind,
      ...entity,
      image: imagePath
        ? { url: coverPublicUrl(imagePath), alt: imageAlt ?? entity.name }
        : null,
      books,
    };
  },
);

export async function getActiveEntitlementBookIds(
  profileId: string,
): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("book_id")
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) throw await failure("getActiveEntitlementBookIds", error);
  return new Set((data ?? []).map((row) => row.book_id));
}

// Access is per edition. An order line that names an edition is owned only when THAT edition is held:
// owning the English edition says nothing about the Japanese one.
export async function getActiveEntitlementEditionIds(profileId: string): Promise<Set<string>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("edition_id")
    .eq("profile_id", profileId)
    .eq("status", "active");
  if (error) throw await failure("getActiveEntitlementEditionIds", error);
  return new Set((data ?? []).flatMap((row) => (row.edition_id ? [row.edition_id] : [])));
}

// What the viewer can do with ONE edition. Ownership is per edition: holding the English edition
// leaves the Japanese one to buy.
export async function getBookActionState(
  card: Pick<CatalogBookCard, "editionId" | "offer" | "hasActivePublication">,
): Promise<{ action: BookAction; signedIn: boolean }> {
  const profile = await getCurrentProfile();
  const owned = profile
    ? await getActiveEntitlementEditionIds(profile.id)
    : new Set<string>();

  const action = resolveBookAction({
    hasActiveEntitlement: owned.has(card.editionId),
    offer: card.offer
      ? { priceMinor: card.offer.priceMinor, active: true }
      : null,
    hasActivePublication: card.hasActivePublication,
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
  });
  return { action, signedIn: profile !== null };
}

// What an anonymous visitor could do with this book: the same rule as getBookActionState, minus
// the entitlement the viewer might hold. A page renders this so it can be prerendered; the viewer's
// own state arrives from /api/catalog/books/[bookId]/action-state.
export function publicBookAction(
  card: Pick<CatalogBookCard, "offer" | "hasActivePublication">,
): BookAction {
  return resolveBookAction({
    hasActiveEntitlement: false,
    offer: card.offer
      ? { priceMinor: card.offer.priceMinor, active: true }
      : null,
    hasActivePublication: card.hasActivePublication,
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
  });
}

// What the public sample reader page needs. Null means notFound(), for every reason: no
// localization in this locale, an unpublished book, no active publication, or no sample.
export async function getSampleReaderBook(
  locale: Locale,
  slug: string,
): Promise<{
  bookId: string;
  title: string;
  slug: string;
  publicationId: string;
  // The edition the sample belongs to, and the offer it is sold under: the end-of-sample control
  // buys or opens THIS edition.
  editionId: string;
  offer: { offerId: string; priceMinor: number } | null;
  action: BookAction;
  signedIn: boolean;
} | null> {
  const book = await getBookPage(locale, slug);
  if (!book || !book.hasSample) return null;

  const publicationId = await resolveSamplePublicationId(book.editionId);
  if (!publicationId) return null;

  // Reads the optional session, like the book page does: a signed-out visitor is the expected
  // caller here and must not be redirected. It only decides which control the sample ends with.
  const { action, signedIn } = await getBookActionState(book);

  const offer = book.editions.find((edition) => edition.editionId === book.editionId)?.offer ?? null;
  return {
    bookId: book.bookId,
    title: book.title,
    slug: book.slug,
    publicationId,
    editionId: book.editionId,
    offer: offer ? { offerId: offer.offerId, priceMinor: offer.priceMinor } : null,
    action,
    signedIn,
  };
}

export type CatalogSearchResults = {
  books: CatalogBookCard[];
  authors: SearchHit[];
  ideas: SearchHit[];
  articles: SearchHit[];
  series: SearchHit[];
  topics: SearchHit[];
};

// An unknown kind is an invalid response: the page could not route it, so it is not guessed at.
const searchHitsSchema = z.array(
  z.object({
    kind: z.enum(searchHitKinds),
    slug: z.string(),
    name: z.string(),
    score: z.number(),
  }),
);

// `query` must come from normalizeSearchQuery (lib/catalog/search.ts).
export async function searchCatalog(
  locale: Locale,
  query: string,
): Promise<CatalogSearchResults> {
  const [cards, { data, error }] = await Promise.all([
    getBookCards(locale),
    createPublicClient().rpc("search_catalog", {
      p_locale: locale,
      p_query: query,
    }),
  ]);
  if (error) throw await failure("searchCatalog", error);

  const parsed = searchHitsSchema.safeParse(data ?? []);
  if (!parsed.success) throw await failure("searchCatalog", parsed.error);

  const grouped = groupSearchHits(parsed.data, locale);
  const bySlug = new Map(cards.map((card) => [card.slug, card]));
  return {
    books: grouped.books.flatMap((hit) => bySlug.get(hit.slug) ?? []),
    authors: grouped.authors,
    // Ideas and articles link by slug under their own path segment; the matched question or title
    // is the link text, so the hits pass through unchanged.
    ideas: grouped.ideas,
    articles: grouped.articles,
    series: grouped.series,
    topics: grouped.topics,
  };
}
