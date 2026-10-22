"use server";

import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth/session";
import {
  completeJourney,
  JourneyNotAvailableError,
  JourneyReflectionTooLongError,
  markJourneySession,
} from "@/lib/data/journeys";
import { resolveLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

// The bound arguments come from the server-rendered session page but are posted values all the
// same: the locale is resolved, and the data layer validates the journey id and position before
// the definer RPCs check the journey is published and the caller signed in.
export type JourneyActionState = { error: string | null };

async function run(
  lang: string,
  slug: string,
  position: number,
  write: () => Promise<void>,
): Promise<JourneyActionState> {
  const locale = resolveLocale(lang);
  const sessionPath = getCatalogRoutes(locale).journeySession(slug, position);
  await requireUser(locale, sessionPath);
  const copy = (await getDictionary(locale)).journeys.errors;
  try {
    await write();
  } catch (error) {
    if (error instanceof JourneyReflectionTooLongError) return { error: copy.reflectionTooLong };
    if (error instanceof JourneyNotAvailableError) return { error: copy.notAvailable };
    // Anything else was already logged with the request ID by the data layer.
    return { error: copy.generic };
  }
  revalidatePath(sessionPath);
  revalidatePath(withLocale(locale, "/library"));
  return { error: null };
}

export async function markSessionAction(
  lang: string,
  slug: string,
  journeyId: string,
  position: number,
): Promise<JourneyActionState> {
  return run(lang, slug, position, () => markJourneySession(journeyId, position));
}

export async function completeJourneyAction(
  lang: string,
  slug: string,
  journeyId: string,
  position: number,
  _previous: JourneyActionState,
  formData: FormData,
): Promise<JourneyActionState> {
  const reflection = formData.get("reflection");
  return run(lang, slug, position, () => completeJourney(journeyId, typeof reflection === "string" ? reflection : null));
}
