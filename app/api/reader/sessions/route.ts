import { type NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { createReaderSession, ReaderAccessDeniedError, ReaderUnavailableError } from "@/lib/reader/session";

// Mints a short-lived reader session for one publication the caller is entitled to.
//
// Status model, identical across all four entitled handlers in this task:
//  - 401 only when there is no authenticated session at all. It is decided before any database
//    access, so it is a statement about the caller and never about the publication - an invented
//    publication id and a real one produce exactly the same 401.
//  - 404 for every other refusal, with one body. No entitlement, revoked entitlement, publication
//    absent, not published, or no longer the book's active version all take this branch, so a
//    real publication the caller lacks entitlement to is indistinguishable from one that does not
//    exist. A 403 for "exists but forbidden" is precisely the existence oracle this avoids, which
//    is why 403 appears nowhere on these paths.
//
// The response carries the session id and its expiry, never a storage key. It also sets the id in
// an httpOnly cookie scoped to /api: the reading engine fetches manifest and resource URLs as
// ordinary sub-resources, and a cookie keeps the session out of URLs, `Referer` headers, and
// access logs. The cookie is named per publication so a reader with two books open does not have
// one session evict the other.
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  let publicationId: unknown;
  try {
    ({ publicationId } = (await request.json()) as { publicationId?: unknown });
  } catch {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  if (typeof publicationId !== "string" || publicationId.length === 0) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const grant = await createReaderSession(publicationId);

    const response = NextResponse.json(grant, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
    response.cookies.set({
      name: `reader-session-${grant.publicationId}`,
      value: grant.sessionId,
      httpOnly: true,
      sameSite: "lax",
      // NODE_ENV describes the build, not the transport. Local acceptance runs the production
      // build over HTTP, and WebKit correctly refuses a Secure cookie received there. Derive the
      // flag from the request instead; the forwarded value covers the normal TLS-terminating
      // production proxy while direct HTTPS is represented by nextUrl itself.
      secure:
        request.nextUrl.protocol === "https:" ||
        request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https",
      path: "/api",
      expires: new Date(grant.expiresAt),
    });
    return response;
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    // Ruling CF, for uniformity across all five handlers. Unreachable today - createReaderSession
    // only calls the RPC and never touches the storage or publication helpers that throw this - so
    // this is here to stop a future change to that function leaking a 500, not because a path
    // exists now.
    if (error instanceof ReaderUnavailableError) {
      return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
    }
    throw error;
  }
}
