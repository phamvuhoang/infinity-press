import { type NextRequest } from "next/server";
import { z } from "zod";

import { getServerEnv } from "@/lib/config/server-env";
import { createSharedQuote, SharedQuoteCapError, SharedQuoteRefusedError } from "@/lib/data/shared-quotes";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";
import { truncateBookQuote } from "@/lib/reader/quote";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

// S16: Share from the reader. The publication comes from the authorized reader session, never from
// the body, so the client cannot name a book it does not hold. The body is the selection and the
// locale the reader is reading in; the quote is cut to the shared 300-grapheme limit here, and the
// RPC checks entitlement, the cap, and the text rules again.
const bodySchema = z.strictObject({
  quote: z.string().trim().min(1).regex(/^(?![\s\S]*<\/?[a-z][^>]*>)/i),
  locale: z.string().refine(isLocale),
});

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
      const card = await createSharedQuote(context.publicationId, quote, locale);
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
