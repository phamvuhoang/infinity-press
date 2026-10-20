import "server-only";

import { requireUser } from "@/lib/auth/session";
import { getBookAcceptsQuestions, getBookCards } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getServerEnv } from "@/lib/config/server-env";
import { type Locale, withLocale } from "@/lib/i18n/config";
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
  // the reader's position in the WHOLE BOOK) for the book's currently active publication, falling
  // back to `progression` for rows written before migration 20260916100000. A book with no
  // progress row reads 0. Pinned to 100 whenever `state` is 'completed', even if the raw figure
  // (0.99 and up) would otherwise round down to 99 - see deriveLibraryState and its caller.
  progressPercent: number;
  continueReadingUrl: string;
};

type LibraryRow = {
  book_id: string;
  added_at: string;
  // Written by save_reading_progress (migration 20260916100000) and never downgraded from
  // 'completed'. Read here so that guarantee is actually visible to a reader - see getLibrary.
  state: LibraryState;
  entitlements: { status: "active" | "revoked" } | null;
  books: {
    id: string;
    active_publication_id: string | null;
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

// What the reader page needs to open one book: the active publication to read, and the title to
// render. Returns null when the caller holds no active entitlement, when the book or its
// localization is not publicly published, or when the book has no active publication - the page
// turns all of those into one notFound(), so an unentitled reader cannot distinguish "you do not
// own this" from "no such book", matching the API handlers' own 404 model.
//
// Reads through the session client only: entitlements are owner-scoped by RLS and books are
// gated on 'published', so an unentitled caller genuinely resolves no row rather than being
// filtered in application code.
export async function getReadableBook(
  locale: Locale,
  bookId: string,
): Promise<{
  bookId: string;
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
  await requireUser(locale, withLocale(locale, `/read/${bookId}`));

  // RLS is the floor here, not the filter. Every owner-scoped read below also filters on the
  // caller's own profile ID, the rule lib/data/orders.ts already states: an admin's session can
  // read EVERY row of entitlements (migration 20260913100000, "admin reads entitlements"), so an
  // un-scoped read is both a wrong answer and, through `maybeSingle()`, a crash. That is the
  // /read/[bookId] 500: once a second reader held an active entitlement to the same book, an
  // admin opening it selected two rows and PostgREST answered PGRST116.
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();

  const { data: entitlement, error: entitlementError } = await supabase
    .from("entitlements")
    .select("id")
    .eq("profile_id", profile.id)
    .eq("book_id", bookId)
    .eq("status", "active")
    .maybeSingle();

  if (entitlementError) {
    throw new Error(`getReadableBook: failed to load entitlement: ${entitlementError.message}`);
  }
  if (!entitlement) return null;

  const { data: book, error: bookError } = await supabase
    .from("books")
    .select("id, active_publication_id")
    .eq("id", bookId)
    .maybeSingle()
    .overrideTypes<
      { id: string; active_publication_id: string | null },
      { merge: false }
    >();

  if (bookError) {
    throw new Error(`getReadableBook: failed to load book: ${bookError.message}`);
  }
  if (!book || !book.active_publication_id) return null;

  // This is the same published, locale-specific card set that powers the catalog. It supplies
  // the localized book title, author localization with display-name fallback, and public cover
  // URL without projecting any private publication fields into the reader.
  const cards = await getBookCards(locale);
  const card = cards.find((candidate) => candidate.bookId === book.id);
  if (!card) return null;
  const acceptsQuestions = await getBookAcceptsQuestions(book.id);

  // Owner-scoped by RLS ("owner reads own reading progress"), so this stays on the session client
  // like every other read here - no privileged client is constructed to open a book. The explicit
  // profile filter is the same defence as above: no admin policy exposes this table today, and
  // the day one does it must not silently hand this reader someone else's position.
  const { data: progress, error: progressError } = await supabase
    .from("reading_progress")
    .select("locator_json")
    .eq("profile_id", profile.id)
    .eq("publication_id", book.active_publication_id)
    .maybeSingle();

  if (progressError) {
    throw new Error(`getReadableBook: failed to load reading progress: ${progressError.message}`);
  }

  return {
    bookId: book.id,
    title: card.title,
    authorName: card.author.name,
    acceptsQuestions,
    canonicalBookUrl: absoluteUrl(getServerEnv().siteUrl, getCatalogRoutes(locale).book(card.slug)),
    relatedBooks: relatedBooks(card, cards, locale),
    publicationId: book.active_publication_id,
    // Validated, not cast. locator_json is jsonb with no shape constraint, so a malformed row
    // degrades to "open at the beginning" rather than taking the whole reader page down - the
    // opposite of saveProgress, which throws, because there a bad value means a bad request
    // whereas here it only means this reader loses a position they can immediately re-establish.
    initialLocator: isReaderLocator(progress?.locator_json)
      ? parseReaderLocator(progress.locator_json)
      : null,
  };
}

export async function getLibrary(locale: Locale): Promise<LibraryItemDTO[]> {
  // The library-boundary guarantee this function makes on its own, independent of whatever the
  // calling page already did - matching every other DAL in this repo.
  await requireUser(locale, withLocale(locale, "/library"));

  // Same rule as getReadableBook: "admin reads library items" lets an admin's session read every
  // reader's shelf, so the caller's own profile ID does the scoping and RLS only backs it up.
  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();

  // `books!inner` drops any library item whose book is not publicly published: the "public read
  // published books" policy already hides those rows, and an inner join makes that filtering
  // explicit rather than leaving a null-book entry to be dropped later.
  const { data: rows, error } = await supabase
    .from("library_items")
    .select(
      `
      book_id,
      added_at,
      state,
      entitlements!inner ( status ),
      books!inner ( id, active_publication_id, book_localizations ( locale, slug, title ) )
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
    (row): row is LibraryRow & { books: NonNullable<LibraryRow["books"]> } =>
      row.entitlements?.status === "active" && Boolean(row.books),
  );

  if (items.length === 0) return [];

  const publicationIds = items
    .map((row) => row.books.active_publication_id)
    .filter((id): id is string => typeof id === "string");

  // The progress read is skipped entirely when it would have nothing to match: `.in()` with an
  // empty array is rejected by PostgREST as malformed rather than returning no rows (the same trap
  // lib/data/publications.ts documents).
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
  //
  // Ruling CQ's original point stands: the state and the percentage are two halves of one
  // sentence and must never disagree. The 0.99 threshold below is fixed at the raw figure to
  // match save_reading_progress's SQL exactly, which means a book can cross into 'completed' at,
  // say, 0.992 - a value that would otherwise round to "99%". Rather than let the threshold drift
  // from the SQL to chase the display, the display is reconciled to the state instead: once a book
  // is 'completed', the percentage rendered beside it is pinned to 100. See where progressPercent
  // is computed below.
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

  return items.flatMap((row) => {
    const localization = pickLocalization(row.books.book_localizations, locale);
    // A book with no localization at all has no title or slug to render and no honest URL to
    // link to, so it is omitted rather than shown as a blank card.
    if (!localization) return [];

    const activePublicationId = row.books.active_publication_id;
    // `undefined` when the book has no active publication, and when it has one but this reader
    // holds no progress row against it. Both mean "never opened", which deriveLibraryState reads
    // as 'unread'.
    const totalProgression = activePublicationId
      ? progressByPublication.get(activePublicationId)
      : undefined;
    // The stored column LEADS once it says 'completed', and the derivation only fills in behind it.
    // save_reading_progress refuses to downgrade `library_items.state` from 'completed', and that
    // promise is invisible unless something reads the column: a reader who finishes a book and then
    // pages back to chapter 2 saves total_progression 0.2, and a purely derived state would flip
    // their card from "Finished" to "In progress, 20%" while the database still, correctly, says
    // completed. The spec (§4.4) says a completed book stays completed.
    //
    // This also decides the post-republish case, and decides it the same way: progress is keyed on
    // books.active_publication_id, so a rollback or a republish leaves a reader who finished the
    // old publication with a stored 'completed' and no progress row against the new one. §4.4
    // again - the book stays finished rather than resetting to "Not started".
    //
    // The derivation is kept for every other row. Nothing wrote this column before migration
    // 20260916100000, so a reader with real pre-migration progress still has 'unread' stored beside
    // it; trusting the column in that direction would reset their card to "Not started".
    const state = row.state === "completed" ? "completed" : deriveLibraryState(totalProgression);
    // Reconciled to the state, not the other way around: deriveLibraryState's 0.99 threshold must
    // match the SQL exactly, so a book can be 'completed' at a raw figure that would otherwise
    // round down to "99%". Pinning the percentage to 100 once the state says 'completed' is what
    // keeps the two halves of the card's sentence from disagreeing.
    const progressPercent = state === "completed" ? 100 : toProgressPercent(totalProgression);

    return [
      {
        bookId: row.book_id,
        title: localization.title,
        slug: localization.slug,
        coverAltText: cardByBook.get(row.book_id)?.cover?.alt ?? null,
        coverUrl: cardByBook.get(row.book_id)?.cover?.url ?? null,
        state,
        progressPercent,
        // Keyed by book id, matching the existing /read/[bookId] route: the reader page resolves
        // the book's active publication itself, so a rollback between renders cannot leave this
        // URL pointing at a version that is no longer being served.
        continueReadingUrl: withLocale(locale, `/read/${row.book_id}`),
      },
    ];
  });
}
