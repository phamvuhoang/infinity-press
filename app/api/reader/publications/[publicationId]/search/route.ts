import { type NextRequest } from "next/server";

import { parseReaderSearchQuery, searchReaderPublication } from "@/lib/data/reader-search";
import { getRequestId } from "@/lib/observability/request-id";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { publicationId } = await params;
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    let query: string;
    try {
      query = parseReaderSearchQuery(request.nextUrl.searchParams.get("q"));
    } catch {
      return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    }
    const results = await searchReaderPublication(context, query);
    return readerJsonResponse(requestId, 200, { results });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "search");
    if (handled) return handled;
    throw error;
  }
}
