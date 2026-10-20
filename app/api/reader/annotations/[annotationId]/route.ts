import { type NextRequest } from "next/server";

import {
  deleteReaderAnnotation,
  updateReaderAnnotation,
} from "@/lib/data/reader-annotations";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { parseAnnotationPatch } from "@/lib/reader/annotations";
import { requireReaderRequestContext } from "@/lib/reader/request-context";
import { readerApiErrorResponse, readerJsonResponse } from "@/lib/reader/route-response";

type Context = { params: Promise<{ annotationId: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { annotationId } = await params;
  const publicationId = request.nextUrl.searchParams.get("publicationId") ?? "";
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    let patch;
    try {
      patch = parseAnnotationPatch(await request.json());
    } catch {
      return readerJsonResponse(requestId, 400, { error: "Invalid request." });
    }
    const annotation = await updateReaderAnnotation(context, annotationId, patch);
    return readerJsonResponse(requestId, 200, { annotation });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "annotation");
    if (handled) return handled;
    throw error;
  }
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const requestId = getRequestId(request.headers);
  const { annotationId } = await params;
  const publicationId = request.nextUrl.searchParams.get("publicationId") ?? "";
  try {
    const context = await requireReaderRequestContext(request, publicationId);
    await deleteReaderAnnotation(context, annotationId);
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store", [REQUEST_ID_HEADER]: requestId },
    });
  } catch (error) {
    const handled = readerApiErrorResponse(error, requestId, "annotation");
    if (handled) return handled;
    throw error;
  }
}
