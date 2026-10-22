import "server-only";

import { requireUser } from "@/lib/auth/session";
import { getBookAcceptsQuestions, getBookCards } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getServerEnv } from "@/lib/config/server-env";
import { coverPublicUrl } from "@/lib/catalog/covers";
import { isLocale, type Locale, locales, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { chunkLocator } from "@/lib/reader/anchor";
import { FINISHED_TOTAL_PROGRESSION } from "@/lib/reader/completion";
import { isReaderLocator, parseReaderLocator } from "@/lib/reader/engine";
import { toReaderResourceHref } from "@/lib/reader/locator-paths";
import type { ReaderLocator } from "@/lib/reader/types";
import { absoluteUrl } from "@/lib/seo/metadata";
import { createClient } from "@/lib/supabase/server";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import type { Database } from "@/lib/supabase/database.types";

// The reader's own library. Everything here reads through the authenticated session client, and
// deliberately never constructs the service-role client: library_items and reading_progress are
// covered by owner RLS policies, and each edition's title, slug, author, cover and readable
// publication come from the my_library_editions RPC (migration 20261021110000), which is
// owner-scoped in SQL and returns an owned edition whatever its book or edition status - so an
// unpublished book stays in its owners' library. Ruling AP's standing rule - reach for
// service_role only when a read is genuinely inexpressible as a policy - so a library render
// carries no privileged client at all.
export type LibraryState = "unread" | "reading" | "completed";

// What crosses to the Client Component. Note what is absent, by contract: no storage keys, no
// publication id, no entitlement id, and no entitlement source details (source_type,
// source_order_id, actor, reason). A reader's library shows what they can read, never how they
// came to be entitled to it - and never anything addressable in the private bucket.
export type LibraryItemDTO = {
  bookId: string;
  // The edition (translation) this item is: ownership, progress and the reader are all per edition,
  // so owning English and Japanese of one work are two items that share a bookId.
  editionId: string;
  languageCode: string;
  title: string;
  slug: string;
  // Cover art comes from the existing marketing data in media_assets, not from inside the EPUB
  // (Task 1 review, Minor 4 - ProcessedPublication cannot identify a cover at all). Only the alt
  // text and the public cover URL are projected; nothing addressable in a private bucket is.
  coverAltText: string | null;
  // Public cover URL (media_assets -> the public `covers` bucket), built from the storage key
  // my_library_editions returns. storage_key is withheld from the browser roles at the column grant
  // (migration 20260911200000), so that RPC is the only session-client path to it; the key itself
  // stays in this module. Null when the book has no cover row.
  coverUrl: string | null;
  state: LibraryState;
  // Whole percent, 0-100, derived from reading_progress.total_progression (a 0-1 numeric giving
  // the reader's position in the WHOLE BOOK) for the edition's readable publication, falling
  // back to `progression` for rows written before migration 20260916100000. A book with no
  // progress row reads 0. Pinned to 100 whenever `state` is 'completed', even if the raw figure
  // (0.99 and up) would otherwise round down to 99 - see deriveLibraryState and its caller.
  progressPercent: number;
  continueReadingUrl: string;
  // False once an admin unpublishes the book. Catalog-gated pages (the review form) 404 for it, so
  // the library links to them only while this is true.
  inCatalog: boolean;
};

// The session client is untyped, so the RPC's row shape is pinned from the generated types here.
type OwnedEditionRow = Database["public"]["Functions"]["my_library_editions"]["Returns"][number];

type LibraryRow = {
  book_id: string;
  edition_id: string;
  added_at: string;
  // Written by save_reading_progress (migration 20260916100000) and never downgraded from
  // 'completed'. Read here so that guarantee is actually visible to a reader - see getLibrary.
  state: LibraryState;
  entitlements: { status: "active" | "revoked" } | null;
};

function toProgressPercent(progression: number | null | undefined): number {
  if (typeof progression !== "number" || !Number.isFinite(progression)) return 0;
  return Math.round(Math.min(1, Math.max(0, progression)) * 100);
}

// Ruling CQ, revisited by S4. This used to be derived from the rendered percentage because nothing
// in the application ever wrote `library_items.state`. Since migration 20260916100000,
// save_reading_progress writes it on every winning save, and both surfaces read the same figure:
// reading_progress.total_progression, the reader's position in the WHOLE BOOK.
//
// The threshold itself lives in lib/reader/completion.ts, which the reader client imports too - a
// third hand-written 0.99 was one too many, and the library and the reader's completion card must
// never disagree about whether a book is finished.
//
// It is still duplicated in SQL inside save_reading_progress. That duplication is deliberate and is
// the same arrangement reconcileProgress has with its RPC: SQL cannot call into TypeScript, so the
// rule is stated in both places and supabase/tests/020_reader_completion.sql is what proves they
// agree.
export function deriveLibraryState(totalProgression: number | null | undefined): LibraryState {
  // No progress row at all - the reader has never opened this book.
  if (typeof totalProgression !== "number" || !Number.isFinite(totalProgression)) return "unread";
  return totalProgression >= FINISHED_TOTAL_PROGRESSION ? "completed" : "reading";
}

export type ReaderRelatedBook = {
  title: string;
  authorName: string;
  href: string;
  coverUrl: string | null;
};

function relationRank(source: CatalogBookCard, candidate: CatalogBookCard): number | null {
  if (source.series?.slug && source.series.slug === candidate.series?.slug) return 0;
  if (source.author.slug && source.author.slug === candidate.author.slug) return 1;
  const sourceTopics = new Set(source.topics.map((topic) => topic.slug));
  return candidate.topics.some((topic) => sourceTopics.has(topic.slug)) ? 2 : null;
}

function relatedBooks(source: CatalogBookCard, cards: CatalogBookCard[], locale: Locale): ReaderRelatedBook[] {
  const collator = new Intl.Collator(locale);
  return cards
    .flatMap((candidate) => {
      // Catalog cards are locale-scoped and published by their RPC. Keep the active-publication
      // guard here too: a draft or retired edition must never become a completion recommendation
      // if that lower-level contract changes.
      if (candidate.bookId === source.bookId || !candidate.hasActivePublication) return [];
      const rank = relationRank(source, candidate);
      return rank === null ? [] : [{ candidate, rank }];
    })
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.rank === 0) {
        const seriesOrder = (left.candidate.series?.position ?? 0) - (right.candidate.series?.position ?? 0);
        if (seriesOrder !== 0) return seriesOrder;
      }
      return collator.compare(left.candidate.title, right.candidate.title) || left.candidate.bookId.localeCompare(right.candidate.bookId);
    })
    .slice(0, 3)
    .map(({ candidate }) => ({
      title: candidate.title,
      authorName: candidate.author.name,
      href: getCatalogRoutes(locale).book(candidate.slug),
      coverUrl: candidate.cover?.url ?? null,
    }));
}


// What the reader page needs to open ONE edition: its readable publication, and the title to
// render. Returns null when the caller holds no active entitlement for THIS edition, or when the
// edition has no readable publication - the page turns both into one notFound(), so an unentitled
// reader cannot distinguish "you do not own this" from "no such edition", matching the API
// handlers' own 404 model. Owning English never opens Japanese: my_library_editions is keyed by
// (caller, edition), and the publication comes from the edition.
//
// An owned edition stays readable after an admin unpublishes its book: the title, author, slug and
// publication come from my_library_editions, which is owner-scoped in SQL (active entitlement for
// the caller) and ignores the book's and edition's status. The published catalog is consulted only
// for related books, so an unpublished book simply has none.
//
// Nothing here depends on the interface locale beyond the RPC's own title fallback, so a reader
// browsing in Japanese can open the English edition they own.
//
// `anchor` is a passage (?anchor=<chunk ordinal>). When reader_chunk_locator resolves it, the reader
// opens there instead of at the saved position; any refusal or failure keeps the saved position.
export async function getReadableEdition(
  locale: Locale,
  editionId: string,
  options: { anchor?: number | null } = {},
): Promise<{
  bookId: string;
  editionId: string;
  languageCode: string;
  title: string;
  authorName: string;
  acceptsQuestions: boolean;
  canonicalBookUrl: string;
  relatedBooks: ReaderRelatedBook[];
  publicationId: string;
  // Same meaning as LibraryItemDTO.inCatalog: the reader links to the review form only when true.
  inCatalog: boolean;
  // Where this reader left off (or the requested passage), or null to open at the beginning. Read here rather than fetched
  // by the client so the engine is handed its starting position at mount time - a locator applied
  // after mount would show the opening page first and then jump, which reads as a bug.
  initialLocator: ReaderLocator | null;
} | null> {
  await requireUser(locale, withLocale(locale, `/read/editions/${editionId}`));

  // The RPC scopes itself to auth.uid(), which is the whole entitlement check. The reading_progress
  // read below still filters on the caller's own profile ID: RLS is the floor, not the filter, and
  // an admin's session can read other readers' rows.
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();

  // Filtered in the query, not in JS: PostgREST caps every response at max_rows, so a reader who
  // owns more editions than that would otherwise get a 404 for any edition past the cap.
  const { data, error: ownedError } = await supabase
    .rpc("my_library_editions", { p_locale: locale })
    .eq("edition_id", editionId)
    .maybeSingle();
  if (ownedError) {
    throw new Error(`getReadableEdition: failed to load owned edition: ${ownedError.message}`);
  }
  const edition = data as unknown as OwnedEditionRow | null;
  if (!edition || !edition.publication_id) return null;
  const publicationId = edition.publication_id;

  // The published, locale-specific card set that powers the catalog, used only for what the reader
  // shows beyond the title: recommendations. A work with no card in this locale (or an unpublished
  // one) simply has none.
  const cards = await getBookCards(locale);
  const card = cards.find((candidate) => candidate.bookId === edition.book_id);
  const acceptsQuestions = await getBookAcceptsQuestions(edition.book_id);

  // Owner-scoped by RLS ("owner reads own reading progress"), keyed on THIS edition's readable publication.
  const { data: progress, error: progressError } = await supabase
    .from("reading_progress")
    .select("locator_json")
    .eq("profile_id", profile.id)
    .eq("publication_id", publicationId)
    .maybeSingle();

  if (progressError) {
    throw new Error(`getReadableEdition: failed to load reading progress: ${progressError.message}`);
  }

  let anchored: ReaderLocator | null = null;
  if (options.anchor !== undefined && options.anchor !== null) {
    const { data: chunk, error: chunkError } = await supabase.rpc("reader_chunk_locator", {
      p_publication_id: publicationId,
      p_ordinal: options.anchor,
    });
    if (!chunkError) anchored = chunkLocator(chunk, (href) => toReaderResourceHref(publicationId, href));
  }

  return {
    bookId: edition.book_id,
    editionId: edition.edition_id,
    languageCode: edition.language_code,
    title: edition.title,
    authorName: edition.author_name,
    acceptsQuestions,
    // Built from the owned slug, not the card: it must stay a non-empty URL (the reader's
    // highlight/notes toolbar renders only for a truthy one) even when the public page is gone.
    // The slug belongs to the localization's own locale (metadata_locale), so its URL is built for
    // that locale: catalog_book_page resolves a slug only under the locale it was taken from.
    canonicalBookUrl: absoluteUrl(
      getServerEnv().siteUrl,
      getCatalogRoutes(isLocale(edition.metadata_locale) ? edition.metadata_locale : locale).book(edition.slug),
    ),
    relatedBooks: card ? relatedBooks(card, cards, locale) : [],
    publicationId,
    inCatalog: edition.in_catalog,
    // Validated, not cast. locator_json is jsonb with no shape constraint, so a malformed row
    // degrades to "open at the beginning" rather than taking the whole reader page down.
    initialLocator:
      anchored ?? (isReaderLocator(progress?.locator_json) ? parseReaderLocator(progress.locator_json) : null),
  };
}

// The chunk ordinal a journey session's start locator falls in, for the session's `?anchor=` link.
// Null when the caller does not own the edition, it has nothing readable, or the href is not in its
// current publication (an EPUB re-upload): the page then links to the plain reader URL.
export async function getPassageAnchor(
  locale: Locale,
  editionId: string,
  locator: { href: string; progression: number },
): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("my_library_editions", { p_locale: locale })
    .eq("edition_id", editionId)
    .maybeSingle();
  const publicationId = error ? null : (data as unknown as OwnedEditionRow | null)?.publication_id;
  if (!publicationId) return null;
  const { data: ordinal, error: ordinalError } = await supabase.rpc("reader_chunk_for_locator", {
    p_publication_id: publicationId,
    p_href: locator.href,
    p_progression: locator.progression,
  });
  return ordinalError || typeof ordinal !== "number" ? null : ordinal;
}

// The editions of ONE work the caller owns, for the legacy `/read/{bookId}` deep link. One edition
// redirects, several open a chooser, none is a 404: the interface locale never picks a language,
// because switching it must not change which book a reader is reading. An edition with nothing
// readable is skipped; an unpublished book's editions are not.
export async function getOwnedEditionsOfBook(
  locale: Locale,
  bookId: string,
): Promise<{ editionId: string; languageCode: string; title: string }[]> {
  await requireUser(locale, withLocale(locale, `/read/${bookId}`));

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("my_library_editions", { p_locale: locale }).eq("book_id", bookId);

  if (error) throw new Error(`getOwnedEditionsOfBook: failed to load owned editions: ${error.message}`);

  return ((data ?? []) as unknown as OwnedEditionRow[])
    .filter((row) => row.publication_id)
    .map((row) => ({ editionId: row.edition_id, languageCode: row.language_code, title: row.title }))
    .sort((left, right) => left.languageCode.localeCompare(right.languageCode));
}

// Works together: a reader who owns English and Japanese of one work sees the two side by side,
// each tagged with its language, rather than scattered by the date each was added. Works keep
// their first-seen order; editions within a work follow the interface-locale registry order.
export function groupLibraryByWork(items: LibraryItemDTO[]): LibraryItemDTO[] {
  const order = new Map<string, number>();
  for (const item of items) if (!order.has(item.bookId)) order.set(item.bookId, order.size);
  const languageRank = (code: string) => {
    const rank = (locales as readonly string[]).indexOf(code);
    return rank === -1 ? locales.length : rank;
  };
  return [...items].sort(
    (left, right) =>
      (order.get(left.bookId) ?? 0) - (order.get(right.bookId) ?? 0) ||
      languageRank(left.languageCode) - languageRank(right.languageCode) ||
      left.languageCode.localeCompare(right.languageCode),
  );
}

export async function getLibrary(locale: Locale): Promise<LibraryItemDTO[]> {
  // The library-boundary guarantee this function makes on its own, independent of whatever the
  // calling page already did - matching every other DAL in this repo.
  await requireUser(locale, withLocale(locale, "/library"));

  // Same rule as getReadableEdition: "admin reads library items" lets an admin's session read every
  // reader's shelf, so the caller's own profile ID does the scoping and RLS only backs it up.
  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();

  // Library state and the owner's editions are read side by side: library_items carries the saved
  // state and ordering, and my_library_editions (owner-scoped, any book or edition status) carries
  // what to show. An unpublished book is therefore still listed, with its cover, as long as its
  // edition has a readable publication. Every owned edition is listed whatever the interface
  // locale: switching language never hides a purchase.
  const [libraryResult, ownedResult] = await Promise.all([
    supabase
      .from("library_items")
      .select(
        `
      book_id,
      edition_id,
      added_at,
      state,
      entitlements!inner ( status )
      `,
      )
      .eq("profile_id", profile.id)
      .eq("entitlements.status", "active")
      .order("added_at", { ascending: false })
      .overrideTypes<LibraryRow[], { merge: false }>(),
    supabase.rpc("my_library_editions", { p_locale: locale }),
  ]);

  if (libraryResult.error) {
    throw new Error(`getLibrary: failed to load library items: ${libraryResult.error.message}`);
  }
  if (ownedResult.error) {
    throw new Error(`getLibrary: failed to load owned editions: ${ownedResult.error.message}`);
  }

  const ownedByEdition = new Map(
    ((ownedResult.data ?? []) as unknown as OwnedEditionRow[]).map((edition) => [edition.edition_id, edition]),
  );
  // A row with no RPC counterpart has no title or slug to render and no honest URL to link to, so
  // it is omitted rather than shown as a blank card. So is an edition whose publication_id is
  // null: there is nothing to open, and its continue URL would only lead to the reader's 404.
  const items = (libraryResult.data ?? []).flatMap((row) => {
    const edition = ownedByEdition.get(row.edition_id);
    return row.entitlements?.status === "active" && edition?.publication_id
      ? [{ row, edition, publicationId: edition.publication_id }]
      : [];
  });

  if (items.length === 0) return [];

  // items is non-empty and every item has a publication, so `.in()` never gets the empty array
  // PostgREST rejects as malformed.
  const progressRows = await supabase
    .from("reading_progress")
    .select("publication_id, progression, total_progression")
    .eq("profile_id", profile.id)
    .in("publication_id", items.map(({ publicationId }) => publicationId));

  if (progressRows.error) {
    throw new Error(`getLibrary: failed to load reading progress: ${progressRows.error.message}`);
  }
  // total_progression is null for rows written before migration 20260916100000. Falling back to
  // `progression` keeps a reader's existing card roughly where it was rather than resetting it to
  // zero; the value corrects itself on their next save.
  const progressByPublication = new Map(
    (
      (progressRows.data ?? []) as {
        publication_id: string;
        progression: number;
        total_progression: number | null;
      }[]
    ).map((row) => [row.publication_id, row.total_progression ?? row.progression]),
  );

  const dtos = items.map(({ row, edition, publicationId }): LibraryItemDTO => {
    // `undefined` when this reader holds no progress row against the readable publication: "never
    // opened", which deriveLibraryState reads as 'unread'.
    const totalProgression = progressByPublication.get(publicationId);
    // The stored column LEADS once it says 'completed', and the derivation only fills in behind it.
    // save_reading_progress refuses to downgrade `library_items.state` from 'completed', and that
    // promise is invisible unless something reads the column: a reader who finishes a book and then
    // pages back to chapter 2 saves total_progression 0.2, and a purely derived state would flip
    // their card from "Finished" to "In progress, 20%" while the database still, correctly, says
    // completed. It also decides the post-republish case: progress is keyed on the edition's readable
    // publication, so a rollback or republish leaves a stored 'completed' and no progress row
    // against the new one - the book stays finished rather than resetting to "Not started".
    const state = row.state === "completed" ? "completed" : deriveLibraryState(totalProgression);
    // Reconciled to the state, not the other way around: the 0.99 threshold must match the SQL
    // exactly, so an edition can be 'completed' at a raw figure that would otherwise round down to
    // "99%". Pinning the percentage to 100 once the state says 'completed' keeps the two halves of
    // the card's sentence from disagreeing.
    const progressPercent = state === "completed" ? 100 : toProgressPercent(totalProgression);

    return {
      bookId: row.book_id,
      editionId: row.edition_id,
      languageCode: edition.language_code,
      title: edition.title,
      slug: edition.slug,
      coverAltText: edition.cover_alt_text,
      coverUrl: edition.cover_storage_key ? coverPublicUrl(edition.cover_storage_key) : null,
      state,
      progressPercent,
      // Keyed by EDITION: the reader page resolves the edition's readable publication itself, so a
      // rollback between renders cannot leave this URL pointing at a version no longer served.
      continueReadingUrl: withLocale(locale, `/read/editions/${row.edition_id}`),
      inCatalog: edition.in_catalog,
    };
  });

  return groupLibraryByWork(dtos);
}
