import "server-only";

import { unstable_rethrow } from "next/navigation";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getBookCards } from "@/lib/data/catalog";
import type { Locale } from "@/lib/i18n/config";
import { createPublicClient } from "@/lib/supabase/public";

// Public catalog reads. recommend_books is security definer and already filters to published
// books, active publications, and the requested localization - this module adds no filtering
// and no re-sorting of its own.

// Callers and pages only see the generic message. The database error stays on `cause` and goes
// to the server log once, with the request ID the caller supplied.
//
// This module never reads headers() itself. The topic and author pages that render a shelf are
// static and regenerate through revalidatePath, and reading headers() while rendering them marks
// the route dynamic even inside a try/catch - at build time that silently drops the prerender, and
// a runtime regeneration renders under the same static rules. A static render has no request to
// correlate anyway. Only a request-scoped caller (the library page) knows it may read headers(),
// so it passes the ID in.
function failure(operation: string, cause: unknown, requestId: string | null): Error {
  const detail = {
    code: (cause as { code?: string } | null)?.code ?? null,
    message: (cause as { message?: string } | null)?.message ?? String(cause),
  };
  console.error("Recommendation read failed.", { operation, ...detail, requestId });
  return new Error(`${operation} failed.`, { cause });
}

// Order preserves what recommend_books already computed (pins first, then score order); this
// dedupe keeps that order and only removes repeats.
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export async function getRecommendedBooks(input: {
  seedBookIds: string[];
  excludeBookIds?: string[];
  locale: Locale;
  limit?: number;
  // Set only by request-scoped callers; see failure().
  requestId?: string | null;
}): Promise<CatalogBookCard[]> {
  const seedBookIds = dedupe(input.seedBookIds);
  const excludeBookIds = dedupe(input.excludeBookIds ?? []);
  const boundedLimit = Math.max(0, Math.min(input.limit ?? 6, 6));

  if (seedBookIds.length === 0 || boundedLimit === 0) return [];

  const [cards, { data, error }] = await Promise.all([
    getBookCards(input.locale),
    createPublicClient().rpc("recommend_books", {
      p_seed_book_ids: seedBookIds,
      p_exclude_book_ids: excludeBookIds,
      p_locale: input.locale,
      p_limit: boundedLimit,
    }),
  ]);
  if (error) throw failure("getRecommendedBooks", error, input.requestId ?? null);

  const byId = new Map(cards.map((card) => [card.bookId, card]));
  return (data ?? []).flatMap((row) => byId.get(row.book_id) ?? []).slice(0, boundedLimit);
}

// A recommendation shelf is decoration: it sits below the content the page exists to show, and it
// already renders nothing when empty. Letting a failed shelf read propagate would trade a missing
// carousel for a broken library page, and on the prerendered topic/author routes it would abort
// the whole build export. getRecommendedBooks keeps throwing so that a caller which genuinely
// needs the rows still hears about it; by the time this catch runs, failure() has logged the
// database error once, so there is nothing further to report here.
export async function getShelfRecommendations(
  input: Parameters<typeof getRecommendedBooks>[0],
): Promise<CatalogBookCard[]> {
  try {
    return await getRecommendedBooks(input);
  } catch (error) {
    // notFound(), redirect(), forbidden() and dynamic-rendering bailouts are control flow that
    // Next.js throws through this stack; swallowing one would break the page it was meant to steer.
    unstable_rethrow(error);
    return [];
  }
}
