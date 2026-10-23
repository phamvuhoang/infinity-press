import "server-only";

import { headers } from "next/headers";
import { cache } from "react";
import { z } from "zod";

import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getBookCards } from "@/lib/data/catalog";
import type { Locale } from "@/lib/i18n/config";
import { getRequestId } from "@/lib/observability/request-id";
import { parseReaderLocator } from "@/lib/reader/engine";
import type { ReaderLocator } from "@/lib/reader/types";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

// S20 reading journeys (20261022100000). Content reads use the cookie-less public client: RLS
// shows published journeys only. Progress is read with the session client under the owner-only
// policies, and written only through the two definer RPCs.

export const JOURNEY_SLUG = /^[a-z0-9-]{3,64}$/;

// Every journey RPC refusal is EB047 in the migration. P0002 and 22023 are accepted too, as the
// plan names them, so a future RPC that raises the standard codes still reads as "not available".
const NOT_AVAILABLE = new Set(["EB047", "P0002", "22023"]);

export class JourneyNotAvailableError extends Error {
  constructor() {
    super("This journey is not available.");
    this.name = "JourneyNotAvailableError";
  }
}

// The RPC's own limit (journey_completions.reflection), checked first so a long text is not
// reported as an unavailable journey.
export const REFLECTION_MAX_LENGTH = 2000;

export class JourneyReflectionTooLongError extends Error {
  constructor() {
    super(`A reflection can be at most ${REFLECTION_MAX_LENGTH} characters.`);
    this.name = "JourneyReflectionTooLongError";
  }
}

const journeyIdSchema = z.string().uuid();
const positionSchema = z.number().int().min(1).max(60);

export type JourneySummaryDTO = {
  id: string;
  slug: string;
  title: string;
  summary: string;
  sessionCount: number;
  bookId: string;
  bookSlug: string;
  bookTitle: string;
  editionId: string;
  languageCode: string;
  coverUrl: string | null;
};

export type JourneySessionDTO = {
  position: number;
  title: string;
  guideMd: string;
  questions: string[];
  startLocator: ReaderLocator;
  endLocator: ReaderLocator | null;
};

export type JourneyProgressDTO = { completedPositions: number[]; completed: boolean; reflection: string | null };

type JourneyRow = {
  id: string;
  slug: string;
  book_id: string;
  edition_id: string;
  session_count: number;
  edition: { language_code: string } | null;
  localizations: { locale: string; title: string; summary: string | null }[];
  sessions?: {
    position: number;
    start_locator: unknown;
    end_locator: unknown;
    localizations: { locale: string; title: string; guide_md: string | null; questions: unknown }[];
  }[];
};

const summaryColumns =
  "id, slug, book_id, edition_id, session_count, edition:editions(language_code), localizations:journey_localizations(locale, title, summary)";
const sessionColumns =
  "sessions:journey_sessions(position, start_locator, end_locator, localizations:journey_session_localizations(locale, title, guide_md, questions))";

const questionsSchema = z.array(z.string()).catch([]);

async function currentRequestId(): Promise<string | null> {
  try {
    return getRequestId(await headers());
  } catch {
    return null;
  }
}

// Callers see the generic message; the database code goes to the log with the request ID.
async function failure(operation: string, cause: { code?: string; message?: string }): Promise<Error> {
  console.error("Journey operation failed.", { operation, code: cause.code ?? null, requestId: await currentRequestId() });
  return new Error(`${operation} failed.`, { cause });
}

// Requested locale, then the edition's language, then English: the press_metadata_fallback rule.
// Localization rows only exist for supported locales, so an edition language that is not one simply
// matches nothing.
function pickLocalization<T extends { locale: string }>(rows: T[], locale: Locale, editionLanguage: string): T | undefined {
  for (const code of [locale, editionLanguage, "en"]) {
    const hit = rows.find((row) => row.locale === code);
    if (hit) return hit;
  }
  return undefined;
}

// Null when the journey's book or edition is not public, or nothing is localized for the reader.
function toSummary(row: JourneyRow, locale: Locale, cards: CatalogBookCard[]): JourneySummaryDTO | null {
  const card = cards.find((candidate) => candidate.bookId === row.book_id);
  if (!card || !row.edition) return null;
  const localization = pickLocalization(row.localizations, locale, row.edition.language_code);
  if (!localization) return null;
  return {
    id: row.id,
    slug: row.slug,
    title: localization.title,
    summary: localization.summary ?? "",
    sessionCount: row.session_count,
    bookId: row.book_id,
    bookSlug: card.slug,
    bookTitle: card.title,
    editionId: row.edition_id,
    languageCode: row.edition.language_code,
    coverUrl: card.cover?.url ?? null,
  };
}

function toSessions(row: JourneyRow, locale: Locale): JourneySessionDTO[] {
  const language = row.edition?.language_code ?? "en";
  return [...(row.sessions ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((session) => {
      const localization = pickLocalization(session.localizations, locale, language);
      return {
        position: session.position,
        title: localization?.title ?? "",
        guideMd: localization?.guide_md ?? "",
        questions: questionsSchema.parse(localization?.questions ?? []),
        startLocator: parseReaderLocator(session.start_locator),
        endLocator: session.end_locator === null ? null : parseReaderLocator(session.end_locator),
      };
    });
}

export const getPublishedJourney = cache(
  async (locale: Locale, slug: string): Promise<(JourneySummaryDTO & { sessions: JourneySessionDTO[] }) | null> => {
    if (!JOURNEY_SLUG.test(slug)) return null;
    const [{ data, error }, cards] = await Promise.all([
      createPublicClient()
        .from("reading_journeys")
        .select(`${summaryColumns}, ${sessionColumns}`)
        .eq("slug", slug)
        .eq("status", "published")
        .maybeSingle(),
      getBookCards(locale),
    ]);
    if (error) throw await failure("getPublishedJourney", error);
    if (!data) return null;
    const row = data as unknown as JourneyRow;
    const summary = toSummary(row, locale, cards);
    return summary ? { ...summary, sessions: toSessions(row, locale) } : null;
  },
);

export async function getPublishedJourneysForBook(locale: Locale, bookId: string): Promise<JourneySummaryDTO[]> {
  const [{ data, error }, cards] = await Promise.all([
    createPublicClient()
      .from("reading_journeys")
      .select(summaryColumns)
      .eq("book_id", bookId)
      .eq("status", "published")
      .order("created_at"),
    getBookCards(locale),
  ]);
  if (error) throw await failure("getPublishedJourneysForBook", error);
  return ((data ?? []) as unknown as JourneyRow[]).flatMap((row) => toSummary(row, locale, cards) ?? []);
}

export async function getMyJourneyProgress(journeyId: string): Promise<JourneyProgressDTO> {
  if (!journeyIdSchema.safeParse(journeyId).success) return { completedPositions: [], completed: false, reflection: null };
  const supabase = await createClient();
  const [progress, completion] = await Promise.all([
    supabase.from("journey_progress").select("position").eq("journey_id", journeyId),
    supabase.from("journey_completions").select("reflection").eq("journey_id", journeyId).maybeSingle(),
  ]);
  if (progress.error) throw await failure("getMyJourneyProgress", progress.error);
  if (completion.error) throw await failure("getMyJourneyProgress", completion.error);
  return {
    completedPositions: (progress.data ?? []).map((row) => row.position).sort((a, b) => a - b),
    completed: completion.data !== null,
    reflection: completion.data?.reflection ?? null,
  };
}

// Journeys the caller has completed at least one session of, or finished.
export async function getMyJourneys(locale: Locale): Promise<(JourneySummaryDTO & JourneyProgressDTO)[]> {
  const supabase = await createClient();
  const [progress, completions] = await Promise.all([
    supabase.from("journey_progress").select("journey_id, position"),
    supabase.from("journey_completions").select("journey_id, reflection"),
  ]);
  if (progress.error) throw await failure("getMyJourneys", progress.error);
  if (completions.error) throw await failure("getMyJourneys", completions.error);

  const ids = [...new Set([...(progress.data ?? []), ...(completions.data ?? [])].map((row) => row.journey_id))];
  if (ids.length === 0) return [];

  const [{ data, error }, cards] = await Promise.all([
    supabase.from("reading_journeys").select(summaryColumns).in("id", ids).eq("status", "published"),
    getBookCards(locale),
  ]);
  if (error) throw await failure("getMyJourneys", error);

  return ((data ?? []) as unknown as JourneyRow[]).flatMap((row) => {
    const summary = toSummary(row, locale, cards);
    if (!summary) return [];
    const completion = (completions.data ?? []).find((entry) => entry.journey_id === row.id);
    return {
      ...summary,
      completedPositions: (progress.data ?? [])
        .filter((entry) => entry.journey_id === row.id)
        .map((entry) => entry.position)
        .sort((a, b) => a - b),
      completed: completion !== undefined,
      reflection: completion?.reflection ?? null,
    };
  });
}

export async function markJourneySession(journeyId: string, position: number): Promise<void> {
  if (!journeyIdSchema.safeParse(journeyId).success || !positionSchema.safeParse(position).success) {
    throw new JourneyNotAvailableError();
  }
  const { error } = await (await createClient()).rpc("mark_journey_session", {
    p_journey_id: journeyId,
    p_position: position,
  });
  if (error && NOT_AVAILABLE.has(error.code)) throw new JourneyNotAvailableError();
  if (error) throw await failure("markJourneySession", error);
}

export async function completeJourney(journeyId: string, reflection: string | null): Promise<void> {
  if (!journeyIdSchema.safeParse(journeyId).success) throw new JourneyNotAvailableError();
  // Same measure as the RPC: btrim strips spaces only, char_length counts code points.
  if ([...(reflection ?? "").replace(/^ +| +$/g, "")].length > REFLECTION_MAX_LENGTH) {
    throw new JourneyReflectionTooLongError();
  }
  const { error } = await (await createClient()).rpc("complete_journey", {
    p_journey_id: journeyId,
    p_reflection: reflection ?? "",
  });
  if (error && NOT_AVAILABLE.has(error.code)) throw new JourneyNotAvailableError();
  if (error) throw await failure("completeJourney", error);
}
