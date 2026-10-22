import { type NextRequest } from "next/server";
import { z } from "zod";

import { getServerEnv } from "@/lib/config/server-env";
import { createSharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";
import { toPublicationResourceHref } from "@/lib/reader/locator-paths";
import { MAX_SHARE_QUESTION_CHARS, textKinds, truncateBookQuote } from "@/lib/reader/quote";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

// S16: Share from the reader. The publication comes from the authorized reader session, never from
// the body, so the client cannot name a book it does not hold. The body is the selection and the
// locale the reader is reading in; the quote is cut to the shared 300-grapheme limit here, and the
// RPC checks entitlement, the cap, and the text rules again.
const bodySchema = z.strictObject({
  quote: z.string().trim().min(1).regex(/^(?![\s\S]*<\/?[a-z][^>]*>)/i),
  locale: z.string().refine(isLocale),
  // S20: an optional question (code points, as the database counts them), the text kind, and the
  // selection's locator as the reader has it. The locator only finds the passage to anchor the
  // card to; one that names no passage of this publication shares the quote without an anchor.
  question: z.string().trim().refine((value) => Array.from(value).length <= MAX_SHARE_QUESTION_CHARS).optional(),
  textKind: z.enum(textKinds).default("verbatim"),
  locator: z.object({ href: z.string(), progression: z.number().min(0).max(1) }).optional(),
});

function publicationLocator(publicationId: string, locator: { href: string; progression: number } | undefined) {
  if (!locator) return undefined;
  try {
    return { href: toPublicationResourceHref(publicationId, locator.href), progression: locator.progression };
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers);
  const publicationId = request.nextUrl.searchParams.get("publicationId") ?? "";
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch {
      return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    }
    const { quote } = truncateBookQuote(body.quote);
    const locale = body.locale as Locale;
    try {
      const card = await createSharedQuote(context.publicationId, {
        quote,
        locale,
        ...(body.question ? { question: body.question } : {}),
        textKind: body.textKind,
        locator: publicationLocator(context.publicationId, body.locator),
      });
      const url = new URL(getCatalogRoutes(locale).quoteCard(card.code), getServerEnv().siteUrl).toString();
      return readerJsonResponse(requestId, 201, { code: card.code, url });
    } catch (error) {
      if (error instanceof SharedQuoteCapError) return readerJsonResponse(requestId, 409, { error: "cap" });
      if (error instanceof SharedQuoteRefusedError) return readerJsonResponse(requestId, 502, { error: "Reader request failed.", requestId });
      throw error;
    }
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "quote");
    if (handled) return handled;
    console.error("Reader quote request failed.", { requestId });
    return readerJsonResponse(requestId, 502, { error: "Reader request failed.", requestId });
  }
}
