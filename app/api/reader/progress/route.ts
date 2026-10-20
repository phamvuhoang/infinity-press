import { type NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { InvalidProgressInputError, ProgressDeniedError, saveProgress } from "@/lib/reader/progress";

// Records one reader's position in one publication, and answers with the position the server
// actually holds afterwards.
//
// Status model, matching the other four entitled reader handlers exactly:
//  - 401 only when there is no authenticated session at all, decided before any database access,
//    so it is a statement about the caller and never about the publication.
//  - 404 for every authorization refusal, with one body. No entitlement, revoked entitlement,
//    publication absent, not published, or superseded all take this branch, so a real
//    publication the caller lacks entitlement to is indistinguishable from one that does not
//    exist. No 403 anywhere, for the same reason it appears nowhere else on these paths: it
//    would be an existence oracle.
//  - 400 only for a body this endpoint could not parse as a progress save at all. That is a
//    statement about the request's shape, not about any publication - it is reachable with an
//    entirely invented publication id, so it discloses nothing. Returning 404 here instead would
//    tell a client with a genuine bug to go looking for a missing book.
//
// The response is the EFFECTIVE stored progress, which is not always what was submitted: when a
// newer save from another device won reconciliation, the winning position comes back so the
// client can reconcile to it rather than being told "saved" and carrying on from a position the
// server does not hold.
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  let body: { publicationId?: unknown; locator?: unknown; deviceId?: unknown; clientSequence?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (typeof body.publicationId !== "string" || body.publicationId.length === 0) {
    return NextResponse.json(
      { error: "Invalid request." },
      { status: 400, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const progress = await saveProgress({
      publicationId: body.publicationId,
      // Passed through untouched: saveProgress routes it through parseReaderLocator, which is the
      // one guard between this request body and a jsonb column with no shape constraint.
      locator: body.locator,
      deviceId: body.deviceId as string,
      clientSequence: body.clientSequence as number,
    });

    return NextResponse.json(progress, {
      status: 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ProgressDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (error instanceof InvalidProgressInputError) {
      return NextResponse.json(
        { error: "Invalid request." },
        { status: 400, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    throw error;
  }
}
