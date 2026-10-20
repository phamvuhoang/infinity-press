import { type NextRequest } from "next/server";

import {
  createReaderAnnotation,
  listReaderAnnotations,
} from "@/lib/data/reader-annotations";
import { getRequestId } from "@/lib/observability/request-id";
import { parseAnnotationDraft } from "@/lib/reader/annotations";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

type Context = { params: Promise<{ publicationId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { publicationId } = await params;
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    const annotations = await listReaderAnnotations(context);
    return readerJsonResponse(requestId, 200, { annotations });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "annotation");
    if (handled) return handled;
    throw error;
  }
}

export async function POST(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { publicationId } = await params;
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    let draft;
    try {
      draft = parseAnnotationDraft(await request.json());
    } catch {
      return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    }
    const annotation = await createReaderAnnotation(context, draft);
    return readerJsonResponse(requestId, 201, { annotation });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "annotation");
    if (handled) return handled;
    throw error;
  }
}
