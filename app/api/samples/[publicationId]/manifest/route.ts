import { NextResponse } from "next/server";

import { ReaderAccessDeniedError, ReaderUnavailableError, resolveSampleManifest } from "@/lib/reader/session";

// The public sample manifest.
//
// Ruling AR: this handler takes NO user gate - not requireUser, not requireAdmin, not a role
// predicate. Public samples must work for anonymous visitors, so there is deliberately no call to
// getSessionUser here and no 401 on this path; every refusal is the same 404 an unknown
// publication gets. The entire trust boundary is the explicit server-side allowlist in
// book_samples.allowed_hrefs, intersected with the resources whose own access_class is 'sample',
// and resolveSampleManifest is where that lookup authorizes the response.
//
// What this returns is built from the allowlist, not from the entitled manifest with entries
// filtered out. It never names a non-sample href in any field, and includes no counts or
// placeholders that would reveal how much paid content exists.
//
// It does carry a table of contents, filtered to the same servable set as the readingOrder, and
// that filtering is what makes it safe: every href the toc names is already disclosed by the
// readingOrder, so there is nothing to obtain by diffing the two. Non-servable nodes are dropped
// and their servable descendants promoted, so no paid chapter's title is ever named - titles
// appear nowhere else in the manifest, which is why retaining a paid ancestor would have leaked.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicationId: string }> },
) {
  const { publicationId } = await params;

  try {
    const manifest = await resolveSampleManifest(publicationId);

    return NextResponse.json(manifest, {
      status: 200,
      headers: {
        "Content-Type": "application/webpub+json",
        // Not cached: a republished or rolled-back publication changes which hrefs are servable,
        // and a stale sample manifest would keep pointing at resources the allowlist no longer
        // covers.
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ReaderAccessDeniedError) {
      return NextResponse.json(
        { error: "Not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Ruling CF, and this route is why it matters most: the sample resources query previously
    // failed open here, returning 200 with an empty manifest to an anonymous visitor. It now
    // reaches this generic 502 instead.
    if (error instanceof ReaderUnavailableError) {
      return NextResponse.json({ error: "Failed to load resource." }, { status: 502 });
    }
    throw error;
  }
}
