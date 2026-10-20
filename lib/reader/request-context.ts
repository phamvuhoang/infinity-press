import "server-only";

import type { NextRequest } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeReaderSession,
  type AuthorizedReaderContext,
  ReaderAccessDeniedError,
  readerSessionIdFrom,
} from "@/lib/reader/session";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ReaderRequestUnauthorizedError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "ReaderRequestUnauthorizedError";
  }
}

export class ReaderRequestNotFoundError extends Error {
  constructor() {
    super("Not found.");
    this.name = "ReaderRequestNotFoundError";
  }
}

export async function requireReaderRequestContext(
  request: NextRequest,
  publicationId: string,
): Promise<AuthorizedReaderContext & { sessionId: string }> {
  const user = await getSessionUser();
  if (!user) throw new ReaderRequestUnauthorizedError();
  if (!UUID_PATTERN.test(publicationId)) throw new ReaderRequestNotFoundError();

  const sessionId = readerSessionIdFrom(request, publicationId);
  if (!sessionId) throw new ReaderRequestNotFoundError();

  try {
    const context = await authorizeReaderSession(sessionId, publicationId);
    return { ...context, sessionId };
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) throw new ReaderRequestNotFoundError();
    throw error;
  }
}
