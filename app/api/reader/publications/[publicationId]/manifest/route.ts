import { type NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeReaderSession,
  ReaderAccessDeniedError,
  ReaderUnavailableError,
  resolveEntitledManifest,
  readerSessionIdFrom,
} from "@/lib/reader/session";

// The entitled manifest. Readium Web Publication Manifest JSON whose reading-order and resource
// links point at this application's authenticated Route Handlers - never at a Supabase object
// URL, and never carrying a storage key.
//
// Authorization is re-run here on every request rather than trusted from session creation:
// authorizeReaderSession rechecks expiry, revocation, ownership, entitlement, publication status,
// and version in one security-definer RPC. Only after it returns does resolveEntitledManifest
// construct the service-role client to read the private bucket - the Ruling AD/AM ordering, third
// instance in this repo.
//
// 401/404 model as in app/api/reader/sessions/route.ts: 401 only for an unauthenticated caller,
// decided before any lookup; one indistinguishable 404 for every other refusal.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicationId: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { publicationId } = await params;
  const sessionId = readerSessionIdFrom(request, publicationId);
  if (!sessionId) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    await authorizeReaderSession(sessionId, publicationId);
    const manifest = await resolveEntitledManifest(publicationId);

    return NextResponse.json(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/webpub+json",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    // Ruling CF: a broken or unreadable manifest object, a corrupt one, or a failed resource
    // query is an outage, not a refusal. Same generic 502 body the resource routes use.
    if (error instanceof ReaderUnavailableError) {
      return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
    }
    throw error;
  }
}
