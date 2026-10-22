import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { requireAdmin } from "@/lib/auth/admin";
import { JOURNEY_SLUG } from "@/lib/data/journeys";
import { locales, type Locale } from "@/lib/i18n/config";
import { flattenToc, type FlatTocEntry } from "@/lib/reader/toc";
import type { ReaderLocator, ReaderTocEntry } from "@/lib/reader/types";
import { createAdminClient } from "@/lib/supabase/admin";

// S20 journey administration. Browser roles hold no write grant on the journey tables
// (20261022100000), so every function runs requireAdmin() and only then builds the service-role
// client. The database does not tie a journey's edition to its book; createJourney does.

export type JourneyStatus = "draft" | "published" | "archived";

export class JourneyEditionMismatchError extends Error {
  constructor() {
    super("This edition does not belong to the selected book.");
    this.name = "JourneyEditionMismatchError";
  }
}

export class JourneyNotReadyError extends Error {
  constructor() {
    super("Add at least one session and a title in the edition's language before publishing.");
    this.name = "JourneyNotReadyError";
  }
}

export class DuplicateJourneySlugError extends Error {
  constructor() {
    super("This slug is already used by another journey.");
    this.name = "DuplicateJourneySlugError";
  }
}

const uuid = z.string().uuid();
const localeSchema = z.enum(locales);

export const journeyCreateSchema = z.object({ bookId: uuid, editionId: uuid, slug: z.string().regex(JOURNEY_SLUG) });
export const journeyLocalizationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().max(1000),
});
export const journeySessionSchema = z.object({
  position: z.number().int().min(1).max(60),
  startHref: z.string().trim().min(1),
  endHref: z.string().trim().min(1).nullable(),
});
// Mirrors journey_questions_are_valid: at most three questions of at most 500 characters.
export const journeySessionLocalizationSchema = z.object({
  title: z.string().trim().min(1).max(200),
  guideMd: z.string().trim().max(10000),
  questions: z.array(z.string().trim().min(1).max(500)).max(3),
});
export const journeyStatusSchema = z.enum(["draft", "published", "archived"]);

export type AdminJourneyListItemDTO = {
  id: string;
  slug: string;
  status: JourneyStatus;
  title: string;
  sessionCount: number;
  bookId: string;
  bookTitle: string;
  editionId: string;
  languageCode: string;
  locales: string[];
  updatedAt: string;
};

export type AdminJourneySessionDTO = {
  id: string;
  position: number;
  startHref: string;
  endHref: string | null;
  localizations: { locale: string; title: string; guideMd: string; questions: string[] }[];
};

export type AdminJourneyDTO = {
  id: string;
  slug: string;
  status: JourneyStatus;
  sessionCount: number;
  bookId: string;
  editionId: string;
  languageCode: string;
  localizations: { locale: string; title: string; summary: string }[];
  sessions: AdminJourneySessionDTO[];
  // The edition's active publication toc, for the session href picker. Empty without one.
  toc: FlatTocEntry[];
};

type DatabaseError = { code?: string; message: string };

function failure(operation: string, error: DatabaseError): Error {
  if (error.code === "23505" && error.message.includes("slug")) return new DuplicateJourneySlugError();
  return new Error(`${operation} failed.`, { cause: error });
}

// Admins pick an href from the toc; the reader starts that document at its beginning.
function locatorFor(href: string): ReaderLocator {
  return { href, progression: 0, totalProgression: null, locations: {} };
}

// Edition language, then English, then whatever exists: an admin list always shows a name.
function adminTitle(rows: { locale: string; title: string }[], language: string): string | undefined {
  return (rows.find((row) => row.locale === language) ?? rows.find((row) => row.locale === "en") ?? rows[0])?.title;
}

type ListRow = {
  id: string;
  slug: string;
  status: JourneyStatus;
  session_count: number;
  book_id: string;
  edition_id: string;
  updated_at: string;
  edition: { language_code: string } | null;
  localizations: { locale: string; title: string }[];
  book: { book_localizations: { locale: string; title: string }[] } | null;
};

export async function listAdminJourneys(): Promise<AdminJourneyListItemDTO[]> {
  await requireAdmin();
  const { data, error } = await createAdminClient()
    .from("reading_journeys")
    .select(
      "id, slug, status, session_count, book_id, edition_id, updated_at, edition:editions(language_code), localizations:journey_localizations(locale, title), book:books(book_localizations(locale, title))",
    )
    .order("updated_at", { ascending: false });
  if (error) throw failure("listAdminJourneys", error);
  return ((data ?? []) as unknown as ListRow[]).map((row) => {
    const language = row.edition?.language_code ?? "en";
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      title: adminTitle(row.localizations, language) ?? row.slug,
      sessionCount: row.session_count,
      bookId: row.book_id,
      bookTitle: adminTitle(row.book?.book_localizations ?? [], language) ?? row.book_id,
      editionId: row.edition_id,
      languageCode: language,
      locales: row.localizations.map((localization) => localization.locale),
      updatedAt: row.updated_at,
    };
  });
}

type DetailRow = {
  id: string;
  slug: string;
  status: JourneyStatus;
  session_count: number;
  book_id: string;
  edition_id: string;
  edition: { language_code: string; active_publication_id: string | null } | null;
  localizations: { locale: string; title: string; summary: string | null }[];
  sessions: {
    id: string;
    position: number;
    start_locator: ReaderLocator;
    end_locator: ReaderLocator | null;
    localizations: { locale: string; title: string; guide_md: string | null; questions: string[] }[];
  }[];
};

export async function getAdminJourney(id: string): Promise<AdminJourneyDTO> {
  await requireAdmin();
  if (!uuid.safeParse(id).success) notFound();
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("reading_journeys")
    .select(
      "id, slug, status, session_count, book_id, edition_id, edition:editions(language_code, active_publication_id), localizations:journey_localizations(locale, title, summary), sessions:journey_sessions(id, position, start_locator, end_locator, localizations:journey_session_localizations(locale, title, guide_md, questions))",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw failure("getAdminJourney", error);
  if (!data) notFound();
  const row = data as unknown as DetailRow;

  let toc: FlatTocEntry[] = [];
  const publicationId = row.edition?.active_publication_id;
  if (publicationId) {
    const { data: publication, error: tocError } = await supabase
      .from("ebook_publications")
      .select("toc_json")
      .eq("id", publicationId)
      .maybeSingle();
    if (tocError) throw failure("getAdminJourney", tocError);
    const stored: unknown = publication?.toc_json;
    toc = Array.isArray(stored) ? flattenToc(stored as ReaderTocEntry[]) : [];
  }

  return {
    id: row.id,
    slug: row.slug,
    status: row.status,
    sessionCount: row.session_count,
    bookId: row.book_id,
    editionId: row.edition_id,
    languageCode: row.edition?.language_code ?? "en",
    localizations: row.localizations.map((localization) => ({ ...localization, summary: localization.summary ?? "" })),
    sessions: [...row.sessions]
      .sort((a, b) => a.position - b.position)
      .map((session) => ({
        id: session.id,
        position: session.position,
        startHref: session.start_locator.href,
        endHref: session.end_locator?.href ?? null,
        localizations: session.localizations.map((localization) => ({
          locale: localization.locale,
          title: localization.title,
          guideMd: localization.guide_md ?? "",
          questions: localization.questions,
        })),
      })),
    toc,
  };
}

export async function createJourney(input: { bookId: string; editionId: string; slug: string }): Promise<{ journeyId: string }> {
  await requireAdmin();
  const { bookId, editionId, slug } = journeyCreateSchema.parse(input);
  const supabase = createAdminClient();

  const { data: edition, error: editionError } = await supabase
    .from("editions")
    .select("id")
    .eq("id", editionId)
    .eq("book_id", bookId)
    .maybeSingle();
  if (editionError) throw failure("createJourney", editionError);
  if (!edition) throw new JourneyEditionMismatchError();

  const { data, error } = await supabase
    .from("reading_journeys")
    .insert({ book_id: bookId, edition_id: editionId, slug })
    .select("id")
    .single();
  if (error) throw failure("createJourney", error);
  return { journeyId: (data as { id: string }).id };
}

export async function updateJourneyLocalization(
  journeyId: string,
  locale: Locale,
  input: { title: string; summary: string },
): Promise<void> {
  await requireAdmin();
  const parsedLocale = localeSchema.parse(locale);
  const { title, summary } = journeyLocalizationSchema.parse(input);
  const { error } = await createAdminClient()
    .from("journey_localizations")
    .upsert(
      { journey_id: uuid.parse(journeyId), locale: parsedLocale, title, summary: summary || null },
      { onConflict: "journey_id,locale" },
    );
  if (error) throw failure("updateJourneyLocalization", error);
}

export async function upsertSession(
  journeyId: string,
  input: { position: number; startHref: string; endHref: string | null },
): Promise<{ sessionId: string }> {
  await requireAdmin();
  const { position, startHref, endHref } = journeySessionSchema.parse(input);
  const { data, error } = await createAdminClient()
    .from("journey_sessions")
    .upsert(
      {
        journey_id: uuid.parse(journeyId),
        position,
        start_locator: locatorFor(startHref),
        end_locator: endHref === null ? null : locatorFor(endHref),
      },
      { onConflict: "journey_id,position" },
    )
    .select("id")
    .single();
  if (error) throw failure("upsertSession", error);
  return { sessionId: (data as { id: string }).id };
}

export async function updateSessionLocalization(
  sessionId: string,
  locale: Locale,
  input: { title: string; guideMd: string; questions: string[] },
): Promise<void> {
  await requireAdmin();
  const parsedLocale = localeSchema.parse(locale);
  const { title, guideMd, questions } = journeySessionLocalizationSchema.parse(input);
  const { error } = await createAdminClient()
    .from("journey_session_localizations")
    .upsert(
      { session_id: uuid.parse(sessionId), locale: parsedLocale, title, guide_md: guideMd || null, questions },
      { onConflict: "session_id,locale" },
    );
  if (error) throw failure("updateSessionLocalization", error);
}

export async function deleteSession(sessionId: string): Promise<void> {
  await requireAdmin();
  const { error } = await createAdminClient().from("journey_sessions").delete().eq("id", uuid.parse(sessionId));
  if (error) throw failure("deleteSession", error);
}

export async function setJourneyStatus(journeyId: string, status: JourneyStatus): Promise<void> {
  await requireAdmin();
  const id = uuid.parse(journeyId);
  const nextStatus = journeyStatusSchema.parse(status);
  const supabase = createAdminClient();

  if (nextStatus === "published") {
    const { data, error } = await supabase
      .from("reading_journeys")
      .select("session_count, edition:editions(language_code), localizations:journey_localizations(locale)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw failure("setJourneyStatus", error);
    const row = data as { session_count: number; edition: { language_code: string } | null; localizations: { locale: string }[] } | null;
    if (!row) throw new Error("setJourneyStatus failed.");
    const language = row.edition?.language_code;
    if (row.session_count < 1 || !row.localizations.some((localization) => localization.locale === language)) {
      throw new JourneyNotReadyError();
    }
  }

  const { error } = await supabase.from("reading_journeys").update({ status: nextStatus }).eq("id", id);
  if (error) throw failure("setJourneyStatus", error);
}
