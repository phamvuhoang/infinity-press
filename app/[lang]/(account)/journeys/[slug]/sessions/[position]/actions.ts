"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { acquireFreeEdition, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import {
  completeJourney,
  JourneyNotAvailableError,
  JourneyReflectionTooLongError,
  markJourneySession,
} from "@/lib/data/journeys";
import { resolveLocale, withLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getPassageAnchor } from "@/lib/data/library";
import { getCatalogRoutes, getCommerceRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

const uuid = z.string().uuid();

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

// "Get the free edition and open the reader here", for a reader who does not yet hold the journey's
// edition: the journey has no entitlement of its own, so this is the book page's Get free claim
// followed by the session's own reader link. A claim the database refuses (no free offer, email not
// verified) lands on the book page with the same error codes Get free uses, so a paid edition sends
// the reader to where it can be bought.
export async function claimAndOpenReaderAction(
  lang: string,
  slug: string,
  bookSlug: string,
  editionId: string,
  position: number,
  locator: { href: string; progression: number },
): Promise<void> {
  const locale = resolveLocale(lang);
  if (!uuid.safeParse(editionId).success) redirect(withLocale(locale, "/library"));
  await requireUser(locale, getCatalogRoutes(locale).journeySession(slug, position));
  try {
    await acquireFreeEdition(locale, editionId);
    revalidatePath(withLocale(locale, "/library"));
  } catch (error) {
    const code = error instanceof EmailNotVerifiedError ? "email-not-verified" : error instanceof NoFreeOfferError ? "no-free-offer" : "unexpected";
    if (code === "unexpected") {
      console.error("Journey free edition claim failed.", { editionId, requestId: getRequestId(await headers()), error: String(error) });
    }
    redirect(getCommerceRoutes(locale).bookActionError(bookSlug, code));
  }
  const { anchor } = await getPassageAnchor(locale, editionId, locator);
  redirect(getCatalogRoutes(locale).readEdition(editionId) + (anchor === null ? "" : `?${new URLSearchParams({ anchor: String(anchor) })}`));
}
