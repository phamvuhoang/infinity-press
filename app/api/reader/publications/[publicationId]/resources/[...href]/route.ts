import { type NextRequest, NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import {
  authorizeReaderSession,
  normalizeResourceHref,
  ReaderAccessDeniedError,
  ReaderUnavailableError,
  readerSessionIdFrom,
  resolveEntitledResource,
} from "@/lib/reader/session";
import { EBOOK_DERIVED_BUCKET } from "@/lib/epub/constants";
import { createAdminClient } from "@/lib/supabase/admin";

// Streams one private ebook-derived object to an entitled reader.
//
// Nothing in the request can influence the storage path. The catch-all `href` segments are
// normalized (rejecting traversal, absolute paths, backslashes, control characters, and
// percent-encoded `..` - Task 1's review, Minor 5) and then used only as a WHERE-clause value
// against ebook_resources, scoped to this publication. The key that reaches storage is the one
// the matched row carries; there is no code path that joins a URL segment onto a bucket prefix.
//
// Ordering, pinned by route.test.ts: getSessionUser -> authorizeReaderSession -> href
// normalization -> resource lookup -> only then the service-role client and the download. A
// request that was going to be refused never constructs the privileged client.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ publicationId: string; href: string[] }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const { publicationId, href: hrefSegments } = await params;
  const sessionId = readerSessionIdFrom(request, publicationId);
  if (!sessionId) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const href = normalizeResourceHref(hrefSegments);
  if (href === null) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  let resource: { storageKey: string; mediaType: string };
  try {
    await authorizeReaderSession(sessionId, publicationId);
    resource = await resolveEntitledResource(publicationId, href);
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    // Ruling CF: infrastructure faults go to the same generic 502 the download failure below
    // already uses, so there is one infrastructure channel rather than two. Without this branch
    // the new error type would escape as a 500.
    if (error instanceof ReaderUnavailableError) {
      return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
    }
    throw error;
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EBOOK_DERIVED_BUCKET).download(resource.storageKey);

  if (error || !data) {
    // Generic on purpose: a storage failure must not become a channel that distinguishes "this
    // object is missing" from "this object exists but could not be read".
    return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
  }

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": resource.mediaType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // This header does NOT govern how the reader renders this resource, and must not be relied
      // on as though it does. Readium never navigates an iframe at this route: it fetches the
      // resource and re-hosts it as a `blob:` document carrying a `<meta>` CSP that
      // `FrameBlobBuilder` substitutes. That substituted policy permits `'unsafe-inline'` script
      // inside the frame, so "no script execution" is the reverse of what holds there, and
      // `frame-ancestors` is ignored in a meta policy regardless.
      //
      // It is kept, and pinned by route.test.ts, because it still applies to direct navigation to
      // this URL - and because a security header nobody asserts is one a later change can drop
      // silently. What it is not is a second lock behind the sanitizer: the ingest-time sanitizer
      // (lib/epub/sanitize.ts) is the only boundary that removes hostile content on this path. See
      // ADR-005, "What is actually enforced on the reader path", before relaxing either.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    },
  });
}
