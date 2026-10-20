import { NextResponse } from "next/server";

import { EBOOK_DERIVED_BUCKET } from "@/lib/epub/constants";
import {
  normalizeResourceHref,
  ReaderAccessDeniedError,
  ReaderUnavailableError,
  resolveSampleResource,
} from "@/lib/reader/session";
import { createAdminClient } from "@/lib/supabase/admin";

// Streams one allowlisted sample resource to anyone, including anonymous visitors.
//
// Ruling AR: no user gate of any kind, and therefore no 401 - adding one would silently break
// public samples. Authorization comes entirely from resolveSampleResource, which requires the
// href to be named in book_samples.allowed_hrefs AND its ebook_resources row to carry
// access_class = 'sample'. Sample membership is never inferred from a request parameter, a query
// string, or the shape of the path.
//
// Every refusal is the same 404: a paid href, an href belonging to a different publication, an
// href with no row at all, and a publication that is not published are indistinguishable. A
// resource absent from the allowlist looks exactly like one that does not exist.
//
// As on the entitled route, the storage key comes only from the matched row - the URL's segments
// are a WHERE-clause value, never a path joined onto a bucket prefix.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicationId: string; href: string[] }> },
) {
  const { publicationId, href: hrefSegments } = await params;

  const href = normalizeResourceHref(hrefSegments);
  if (href === null) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  let resource: { storageKey: string; mediaType: string };
  try {
    resource = await resolveSampleResource(publicationId, href);
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Ruling CF: same generic 502 as the download failure below - one infrastructure channel.
    if (error instanceof ReaderUnavailableError) {
      return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
    }
    throw error;
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EBOOK_DERIVED_BUCKET).download(resource.storageKey);

  if (error || !data) {
    return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
  }

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": resource.mediaType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      // Same header as the entitled reader route, and the same caveat: a sample opened through
      // the Readium reader is fetched and re-hosted in a `blob:` frame under a CSP Readium
      // substitutes, so this is not the policy that frame enforces. It governs direct navigation
      // to this URL, and route.test.ts pins it so it cannot be changed silently. The ingest-time
      // sanitizer stays the only boundary that removes hostile content - see ADR-005, "What is
      // actually enforced on the reader path", before relaxing either.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    },
  });
}
