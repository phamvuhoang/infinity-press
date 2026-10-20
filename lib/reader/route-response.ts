import "server-only";

import { NextResponse } from "next/server";

import {
  ReaderDataDeniedError,
  ReaderDataInvalidError,
  ReaderDataUnavailableError,
} from "@/lib/data/reader-annotations";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";
import { ReaderRequestNotFoundError, ReaderRequestUnauthorizedError } from "@/lib/reader/request-context";

type ReaderApiArea = "annotation" | "search" | "quote";

export function readerJsonResponse(
  requestId: string,
  status: number,
  body: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", [REQUEST_ID_HEADER]: requestId },
  });
}

export function readerApiErrorResponse(
  error: unknown,
  requestId: string,
  area: ReaderApiArea,
): NextResponse | null {
  if (error instanceof ReaderRequestUnauthorizedError) {
    return readerJsonResponse(requestId, 401, { error: "Authentication required." });
  }
  if (error instanceof ReaderRequestNotFoundError || error instanceof ReaderDataDeniedError) {
    return readerJsonResponse(requestId, 404, { error: "Not found." });
  }
  if (error instanceof ReaderDataInvalidError) {
    return readerJsonResponse(requestId, 400, { error: "Invalid request." });
  }
  if (error instanceof ReaderDataUnavailableError) {
    console.error(`Reader ${area} request failed.`, { requestId, code: error.code });
    return readerJsonResponse(requestId, 502, { error: "Reader request failed.", requestId });
  }
  return null;
}
