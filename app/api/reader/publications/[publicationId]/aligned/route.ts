import { type NextRequest } from "next/server";

import { getAlignedPassage } from "@/lib/data/reader-aligned";
import { getRequestId } from "@/lib/observability/request-id";
import { parseAnchor } from "@/lib/reader/anchor";
import { toPublicationResourceHref } from "@/lib/reader/locator-paths";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

type Context = { params: Promise<{ publicationId: string }> };

// `?ordinal=N`, or the reader's own place as `?href=<reader URL href>&progression=<0..1>` so the
// compare panel needs one request. `{ passage: null }` when nothing is aligned there.
function parsePlace(params: URLSearchParams, publicationId: string): { ordinal: number } | { href: string; progression: number } | null {
  const ordinal = params.get("ordinal");
  if (ordinal !== null) {
    const parsed = parseAnchor(ordinal);
    return parsed === null ? null : { ordinal: parsed };
  }
  const href = params.get("href");
  const progression = Number(params.get("progression") ?? Number.NaN);
  if (href === null || !Number.isFinite(progression) || progression < 0 || progression > 1) return null;
  try {
    return { href: toPublicationResourceHref(publicationId, href), progression };
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { publicationId } = await params;
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    const place = parsePlace(request.nextUrl.searchParams, publicationId);
    if (!place) return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    return readerJsonResponse(requestId, 200, { passage: await getAlignedPassage(context, place) });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "compare");
    if (handled) return handled;
    throw error;
  }
}
