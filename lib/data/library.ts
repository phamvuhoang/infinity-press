import "server-only";

import { requireUser } from "@/lib/auth/session";
import { getBookAcceptsQuestions, getBookCards } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getServerEnv } from "@/lib/config/server-env";
import { type Locale, locales, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { FINISHED_TOTAL_PROGRESSION } from "@/lib/reader/completion";
import { isReaderLocator, parseReaderLocator } from "@/lib/reader/engine";
import type { ReaderLocator } from "@/lib/reader/types";
import { absoluteUrl } from "@/lib/seo/metadata";
import { createClient } from "@/lib/supabase/server";
import type { CatalogBookCard } from "@/lib/catalog/public-types";

// The reader's own library. Everything here reads through the authenticated session client, and
// deliberately never constructs the service-role client: every row this page needs is already
// covered by an owner-scoped or published-catalog RLS policy (library_items and reading_progress
// by owner, books/book_localizations by 'published', and media_assets by this task's new
// cover-only policy). Ruling AP's standing rule - reach for service_role only when a read is
// genuinely inexpressible as a policy - so a library render carries no privileged client at all.
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
  // Public cover URL from the catalog's own card projection (media_assets -> the public `covers`
  // bucket). Read through getBookCards rather than media_assets directly: storage_key is withheld
  // from the browser roles at the column grant (migration 20260911200000), so the catalog RPC is
  // the only path that can turn a cover into a URL. Null when the book has no cover row.
  coverUrl: string | null;
  state: LibraryState;
  // Whole percent, 0-100, derived from reading_progress.total_progression (a 0-1 numeric giving
  // the reader's position in the WHOLE BOOK) for the edition's currently active publication, falling
  // back to `progression` for rows written before migration 20260916100000. A book with no
  // progress row reads 0. Pinned to 100 whenever `state` is 'completed', even if the raw figure
  // (0.99 and up) would otherwise round down to 99 - see deriveLibraryState and its caller.
  progressPercent: number;
  continueReadingUrl: string;
};

type LibraryRow = {
  book_id: string;
  edition_id: string;
  added_at: string;
  // Written by save_reading_progress (migration 20260916100000) and never downgraded from
  // 'completed'. Read here so that guarantee is actually visible to a reader - see getLibrary.
  state: LibraryState;
  entitlements: { status: "active" | "revoked" } | null;
  editions: { id: string; language_code: string; status: string; active_publication_id: string | null } | null;
  books: {
    id: string;
    book_localizations: { locale: string; slug: string; title: string }[];
  } | null;
};

// PostgREST returns embedded rows in no guaranteed order, so the caller's locale is selected
// explicitly rather than by taking [0]. A book with no localization in the requested locale
// falls back to whichever one exists (MVP books carry one), so a missing translation shows the
// book under its other title instead of dropping it out of the reader's library entirely.
function pickLocalization(
  localizations: { locale: string; slug: string; title: string }[],
  locale: Locale,
): { slug: string; title: string } | null {
  return localizations.find((entry) => entry.locale === locale) ?? localizations[0] ?? null;
}

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


type ReadableEditionRow = {
  id: string;
  book_id: string;
  language_code: string;
  status: string;
  active_publication_id: string | null;
  books: {
    id: string;
    status: string;
    author: { display_name: string; author_localizations: { locale: string; name: string }[] } | null;
    book_localizations: { locale: string; slug: string; title: string }[];
  } | null;
};

// What the reader page needs to open ONE edition: its live publication to read, and the title to
// render. Returns null when the caller holds no active entitlement for THIS edition, when the work
// or edition is not readable, or when the edition has no live publication - the page turns all of
// those into one notFound(), so an unentitled reader cannot distinguish "you do not own this" from
// "no such edition", matching the API handlers' own 404 model. Owning English never opens Japanese:
// the entitlement lookup is by (profile, edition), and the publication comes from the edition.
//
// Nothing here depends on the interface locale. The title falls back across localizations rather
// than requiring one in `locale`, so a reader browsing in Japanese can open the English edition
// they own; the catalog cards only enrich it (related books) when they exist for the locale.
export async function getReadableEdition(
  locale: Locale,
  editionId: string,
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
  // Where this reader left off, or null to open at the beginning. Read here rather than fetched
  // by the client so the engine is handed its starting position at mount time - a locator applied
  // after mount would show the opening page first and then jump, which reads as a bug.
  initialLocator: ReaderLocator | null;
} | null> {
  await requireUser(locale, withLocale(locale, `/read/editions/${editionId}`));

  // RLS is the floor here, not the filter. Every owner-scoped read below also filters on the
  // caller's own profile ID: an admin's session can read EVERY row of entitlements ("admin reads
  // entitlements"), so an un-scoped read is both a wrong answer and, through `maybeSingle()`, a
  // crash once a second reader holds the same edition.
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();

  const { data: entitlement, error: entitlementError } = await supabase
    .from("entitlements")
    .select("id")
    .eq("profile_id", profile.id)
    .eq("edition_id", editionId)
    .eq("status", "active")
    .maybeSingle();

  if (entitlementError) {
    throw new Error(`getReadableEdition: failed to load entitlement: ${entitlementError.message}`);
  }
  if (!entitlement) return null;

  const { data: edition, error: editionError } = await supabase
    .from("editions")
    .select(
      `id, book_id, language_code, status, active_publication_id,
       books ( id, status, author:authors ( display_name, author_localizations ( locale, name ) ), book_localizations ( locale, slug, title ) )`,
    )
    .eq("id", editionId)
    .maybeSingle()
    .overrideTypes<ReadableEditionRow, { merge: false }>();

  if (editionError) {
    throw new Error(`getReadableEdition: failed to load edition: ${editionError.message}`);
  }
  // Published, or archived (an owner keeps an edition that is no longer sold): the same rule
  // reader_edition_for_publication enforces in SQL for every reader route.
  if (
    !edition ||
    !edition.books ||
    edition.books.status !== "published" ||
    !["published", "archived"].includes(edition.status) ||
    !edition.active_publication_id
  ) {
    return null;
  }

  const localization = pickLocalization(edition.books.book_localizations, locale);
  if (!localization) return null;
  const author = edition.books.author;
  const authorName =
    author?.author_localizations.find((entry) => entry.locale === locale)?.name ?? author?.display_name ?? "";

  // The same published, locale-specific card set that powers the catalog, used only for what the
  // reader shows beyond the title: recommendations. A work with no card in this locale simply has
  // none.
  const cards = await getBookCards(locale);
  const card = cards.find((candidate) => candidate.bookId === edition.book_id);
  const acceptsQuestions = await getBookAcceptsQuestions(edition.book_id);

  // Owner-scoped by RLS ("owner reads own reading progress"), keyed on THIS edition's publication.
  const { data: progress, error: progressError } = await supabase
    .from("reading_progress")
    .select("locator_json")
    .eq("profile_id", profile.id)
    .eq("publication_id", edition.active_publication_id)
    .maybeSingle();

  if (progressError) {
    throw new Error(`getReadableEdition: failed to load reading progress: ${progressError.message}`);
  }

  // The slug belongs to the localization's own locale, so its URL is built for that locale.
  const canonicalLocale = (
    edition.books.book_localizations.find((entry) => entry.slug === localization.slug)?.locale ?? locale
  ) as Locale;

  return {
    bookId: edition.book_id,
    editionId: edition.id,
    languageCode: edition.language_code,
    title: localization.title,
    authorName,
    acceptsQuestions,
    canonicalBookUrl: absoluteUrl(getServerEnv().siteUrl, getCatalogRoutes(canonicalLocale).book(localization.slug)),
    relatedBooks: card ? relatedBooks(card, cards, locale) : [],
    publicationId: edition.active_publication_id,
    // Validated, not cast. locator_json is jsonb with no shape constraint, so a malformed row
    // degrades to "open at the beginning" rather than taking the whole reader page down.
    initialLocator: isReaderLocator(progress?.locator_json)
      ? parseReaderLocator(progress.locator_json)
      : null,
  };
}

// The editions of ONE work the caller owns, for the legacy `/read/{bookId}` deep link. One edition
// redirects, several open a chooser, none is a 404: the interface locale never picks a language,
// because switching it must not change which book a reader is reading.
export async function getOwnedEditionsOfBook(
  locale: Locale,
  bookId: string,
): Promise<{ editionId: string; languageCode: string; title: string }[]> {
  await requireUser(locale, withLocale(locale, `/read/${bookId}`));

  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("entitlements")
    .select("edition_id, editions!inner ( language_code, status, active_publication_id, books!inner ( status, book_localizations ( locale, slug, title ) ) )")
    .eq("profile_id", profile.id)
    .eq("book_id", bookId)
    .eq("status", "active")
    .overrideTypes<
      {
        edition_id: string | null;
        editions: {
          language_code: string;
          status: string;
          active_publication_id: string | null;
          books: { status: string; book_localizations: { locale: string; slug: string; title: string }[] } | null;
        } | null;
      }[],
      { merge: false }
    >();

  if (error) throw new Error(`getOwnedEditionsOfBook: failed to load entitlements: ${error.message}`);

  return (data ?? [])
    .flatMap((row) => {
      const edition = row.editions;
      if (!row.edition_id || !edition?.books || edition.books.status !== "published") return [];
      if (!["published", "archived"].includes(edition.status) || !edition.active_publication_id) return [];
      const localization = pickLocalization(edition.books.book_localizations, locale);
      return localization
        ? [{ editionId: row.edition_id, languageCode: edition.language_code, title: localization.title }]
        : [];
    })
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

  // One row per owned edition. `books!inner` drops any item whose work is not publicly published
  // (the policy already hides those rows; the inner join makes the filtering explicit). Every owned
  // edition is listed whatever the interface locale: switching language never hides a purchase.
  const { data: rows, error } = await supabase
    .from("library_items")
    .select(
      `
      book_id,
      edition_id,
      added_at,
      state,
      entitlements!inner ( status ),
      editions!inner ( id, language_code, status, active_publication_id ),
      books!inner ( id, book_localizations ( locale, slug, title ) )
      `,
    )
    .eq("profile_id", profile.id)
    .eq("entitlements.status", "active")
    .order("added_at", { ascending: false })
    .overrideTypes<LibraryRow[], { merge: false }>();

  if (error) {
    throw new Error(`getLibrary: failed to load library items: ${error.message}`);
  }

  const items = (rows ?? []).filter(
    (row): row is LibraryRow & {
      books: NonNullable<LibraryRow["books"]>;
      editions: NonNullable<LibraryRow["editions"]>;
    } =>
      row.entitlements?.status === "active" &&
      Boolean(row.books) &&
      Boolean(row.editions) &&
      // The edition is still offered to its owners (published, or archived after being sold).
      ["published", "archived"].includes(row.editions?.status ?? ""),
  );

  if (items.length === 0) return [];

  const publicationIds = items
    .map((row) => row.editions.active_publication_id)
    .filter((id): id is string => typeof id === "string");

  // The progress read is skipped entirely when it would have nothing to match: `.in()` with an
  // empty array is rejected by PostgREST as malformed rather than returning no rows.
  const [progressRows, cards] = await Promise.all([
    publicationIds.length > 0
      ? supabase
          .from("reading_progress")
          .select("publication_id, progression, total_progression")
          .eq("profile_id", profile.id)
          .in("publication_id", publicationIds)
      : Promise.resolve({ data: [], error: null }),
    getBookCards(locale),
  ]);

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
  const cardByBook = new Map(cards.map((card) => [card.bookId, card]));

  const dtos = items.flatMap((row): LibraryItemDTO[] => {
    const localization = pickLocalization(row.books.book_localizations, locale);
    // A work with no localization at all has no title or slug to render and no honest URL to
    // link to, so it is omitted rather than shown as a blank card.
    if (!localization) return [];

    const activePublicationId = row.editions.active_publication_id;
    // `undefined` when the edition has no live publication, and when it has one but this reader
    // holds no progress row against it. Both mean "never opened", which deriveLibraryState reads
    // as 'unread'.
    const totalProgression = activePublicationId ? progressByPublication.get(activePublicationId) : undefined;
    // The stored column LEADS once it says 'completed', and the derivation only fills in behind it.
    // save_reading_progress refuses to downgrade `library_items.state` from 'completed', and that
    // promise is invisible unless something reads the column: a reader who finishes a book and then
    // pages back to chapter 2 saves total_progression 0.2, and a purely derived state would flip
    // their card from "Finished" to "In progress, 20%" while the database still, correctly, says
    // completed. It also decides the post-republish case: progress is keyed on the edition's live
    // publication, so a rollback or republish leaves a stored 'completed' and no progress row
    // against the new one - the book stays finished rather than resetting to "Not started".
    const state = row.state === "completed" ? "completed" : deriveLibraryState(totalProgression);
    // Reconciled to the state, not the other way around: the 0.99 threshold must match the SQL
    // exactly, so an edition can be 'completed' at a raw figure that would otherwise round down to
    // "99%". Pinning the percentage to 100 once the state says 'completed' keeps the two halves of
    // the card's sentence from disagreeing.
    const progressPercent = state === "completed" ? 100 : toProgressPercent(totalProgression);

    return [
      {
        bookId: row.book_id,
        editionId: row.edition_id,
        languageCode: row.editions.language_code,
        title: localization.title,
        slug: localization.slug,
        coverAltText: cardByBook.get(row.book_id)?.cover?.alt ?? null,
        coverUrl: cardByBook.get(row.book_id)?.cover?.url ?? null,
        state,
        progressPercent,
        // Keyed by EDITION: the reader page resolves the edition's live publication itself, so a
        // rollback between renders cannot leave this URL pointing at a version no longer served.
        continueReadingUrl: withLocale(locale, `/read/editions/${row.edition_id}`),
      },
    ];
  });

  return groupLibraryByWork(dtos);
}
