"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import { readInteger, readOptionalText, readText, type AdminFormState, type FieldErrors } from "@/lib/catalog/form";
import {
  createJourney,
  deleteSession,
  DuplicateJourneySlugError,
  journeyCreateSchema,
  journeyLocalizationSchema,
  journeySessionLocalizationSchema,
  journeySessionSchema,
  JourneyEditionMismatchError,
  JourneyNotReadyError,
  setJourneyStatus,
  updateJourneyLocalization,
  updateSessionLocalization,
  upsertSession,
  type JourneyStatus,
} from "@/lib/data/admin-journeys";
import type { Locale } from "@/lib/i18n/config";
import { adminRoutes } from "@/lib/i18n/routes";

// The S20 journey editor. Each action gates on requireAdmin() first; the data layer validates
// again, checks the edition belongs to the book, and enforces publish readiness. Bound ids and
// locales come from the server-rendered page but are re-validated there like any posted value.

export type JourneyActionResult = { ok: true } | { ok: false; message: string };

const genericFailure = "Something went wrong saving. Try again.";
const listPath = "/admin/journeys";

const saved = (): AdminFormState => ({ fieldErrors: {}, formError: null, savedAt: Date.now() });
const formError = (message: string): AdminFormState => ({ fieldErrors: {}, formError: message, savedAt: null });

// Errors land on the top-level field: "questions.2" and "questions" are both the questions box.
function invalid(error: { issues: { path: PropertyKey[]; message: string }[] }): AdminFormState {
  const fieldErrors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    fieldErrors[key] ??= issue.message;
  }
  return { fieldErrors, formError: null, savedAt: null };
}

function refresh(journeyId: string) {
  revalidatePath(listPath);
  revalidatePath(adminRoutes.adminJourney(journeyId));
}

export async function createJourneyAction(_previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: `${listPath}/new` });

  const parsed = journeyCreateSchema.safeParse({
    bookId: readText(formData, "bookId"),
    editionId: readText(formData, "editionId"),
    slug: readText(formData, "slug"),
  });
  if (!parsed.success) return invalid(parsed.error);

  let journeyId: string;
  try {
    ({ journeyId } = await createJourney(parsed.data));
  } catch (error) {
    if (error instanceof DuplicateJourneySlugError) return { fieldErrors: { slug: error.message }, formError: null, savedAt: null };
    if (error instanceof JourneyEditionMismatchError) return { fieldErrors: { editionId: error.message }, formError: null, savedAt: null };
    return formError(genericFailure);
  }
  refresh(journeyId);
  redirect(adminRoutes.adminJourney(journeyId));
}

export async function saveJourneyLocalizationAction(
  journeyId: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });

  const parsed = journeyLocalizationSchema.safeParse({ title: readText(formData, "title"), summary: readText(formData, "summary") });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateJourneyLocalization(journeyId, locale, parsed.data);
  } catch {
    return formError(genericFailure);
  }
  refresh(journeyId);
  return saved();
}

// One action adds and edits: a session is identified by its position within the journey.
export async function saveSessionAction(journeyId: string, _previous: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });

  const parsed = journeySessionSchema.safeParse({
    position: readInteger(formData, "position"),
    startHref: readText(formData, "startHref"),
    endHref: readOptionalText(formData, "endHref"),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await upsertSession(journeyId, parsed.data);
  } catch {
    return formError(genericFailure);
  }
  refresh(journeyId);
  return saved();
}

// Questions are edited one per line; blank lines are dropped.
export async function saveSessionLocalizationAction(
  journeyId: string,
  sessionId: string,
  locale: Locale,
  _previous: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });

  const parsed = journeySessionLocalizationSchema.safeParse({
    title: readText(formData, "title"),
    guideMd: readText(formData, "guideMd"),
    questions: readText(formData, "questions")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  });
  if (!parsed.success) return invalid(parsed.error);

  try {
    await updateSessionLocalization(sessionId, locale, parsed.data);
  } catch {
    return formError(genericFailure);
  }
  refresh(journeyId);
  return saved();
}

export async function deleteSessionAction(journeyId: string, sessionId: string): Promise<JourneyActionResult> {
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });
  try {
    await deleteSession(sessionId);
  } catch {
    return { ok: false, message: genericFailure };
  }
  refresh(journeyId);
  return { ok: true };
}

export async function setJourneyStatusAction(journeyId: string, status: JourneyStatus): Promise<JourneyActionResult> {
  await requireAdmin({ next: adminRoutes.adminJourney(journeyId) });
  try {
    await setJourneyStatus(journeyId, status);
  } catch (error) {
    if (error instanceof JourneyNotReadyError) return { ok: false, message: error.message };
    return { ok: false, message: genericFailure };
  }
  refresh(journeyId);
  return { ok: true };
}
