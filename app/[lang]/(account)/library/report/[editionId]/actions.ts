"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { ReportNotAllowedError, submitEditionFeedback, TooManyReportsError } from "@/lib/data/edition-feedback";
import { getReadableEdition } from "@/lib/data/library";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export is an async function ("use server"). The form state carries a KEY, never
// English text: the page maps it to the reader's language.
export type ReportState = {
  status: "idle" | "sent" | "error";
  error: "empty" | "tooLong" | "markup" | "notAllowed" | "tooMany" | "failed" | null;
};

const messageSchema = z.string().trim().min(1, "empty").max(2000, "tooLong").refine((value) => !/<\/?[a-z][^>]*>/i.test(value), "markup");

const placeSchema = z
  .object({
    href: z.string().trim().min(1).max(500),
    progression: z.coerce.number().min(0).max(1).optional(),
  })
  .nullable();

const error = (key: NonNullable<ReportState["error"]>): ReportState => ({ status: "error", error: key });

export async function submitReportAction(
  locale: string,
  editionId: string,
  _previous: ReportState,
  formData: FormData,
): Promise<ReportState> {
  if (!isLocale(locale)) return error("failed");
  await requireUser(locale, getCatalogRoutes(locale).reportError(editionId));

  const message = messageSchema.safeParse(String(formData.get("message") ?? ""));
  if (!message.success) return error(message.error.issues[0].message as "empty" | "tooLong" | "markup");

  // The place is a hint for the editors. A malformed one is dropped, not an error: the report is
  // still worth sending.
  const hrefValue = String(formData.get("href") ?? "");
  const progressionValue = String(formData.get("progression") ?? "");
  const place = placeSchema.safeParse(hrefValue ? { href: hrefValue, ...(progressionValue ? { progression: progressionValue } : {}) } : null);

  // The publication comes from the edition the reader holds, resolved here: the browser never names
  // it, so a report cannot be filed against a publication the reader cannot read.
  const readable = await getReadableEdition(locale as Locale, editionId);
  if (!readable) return error("notAllowed");

  try {
    await submitEditionFeedback(readable.publicationId, place.success ? place.data : null, message.data);
  } catch (caught) {
    if (caught instanceof ReportNotAllowedError) return error("notAllowed");
    if (caught instanceof TooManyReportsError) return error("tooMany");
    console.error("Report failed.", { requestId: getRequestId(await headers()) });
    return error("failed");
  }
  return { status: "sent", error: null };
}
