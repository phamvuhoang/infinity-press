import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth/admin";
import { PreviewResourceNotFoundError, resolvePreviewResourceStorageKey } from "@/lib/data/publications";
import { EBOOK_DERIVED_BUCKET } from "@/lib/epub/constants";
import { createAdminClient } from "@/lib/supabase/admin";

// Streams one private ebook-derived object for the admin preview UI
// (components/admin/publication-preview.tsx). Ruling AM: requireAdmin() runs first and
// unconditionally, ahead of anything else in this handler - including resolving the resource,
// which is itself a read that could otherwise look "safe enough" to run before the gate. The
// service-role client (the only thing in this codebase that can read a private bucket at all) is
// not constructed until both requireAdmin() and the resource lookup have already succeeded.
//
// The storage key is never accepted from the request: `href` (from the catch-all route segment)
// and `publicationId` only ever select a row through resolvePreviewResourceStorageKey(), which
// scopes its query to `publication_id = :publicationId and href = :href`
// (lib/data/publications.ts) - there is no code path from this URL to an arbitrary object in the
// ebook-derived bucket.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicationId: string; href: string[] }> },
) {
  await requireAdmin();

  const { publicationId, href: hrefSegments } = await params;
  const href = hrefSegments.join("/");

  let resource: { storageKey: string; mediaType: string };
  try {
    resource = await resolvePreviewResourceStorageKey(publicationId, href);
  } catch (error) {
    if (error instanceof PreviewResourceNotFoundError) {
      return NextResponse.json({ error: "Resource not found for this publication." }, { status: 404 });
    }
    throw error;
  }

  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(EBOOK_DERIVED_BUCKET).download(resource.storageKey);

  if (error || !data) {
    return NextResponse.json({ error: "Failed to load preview resource." }, { status: 502 });
  }

  return new NextResponse(data, {
    status: 200,
    headers: {
      "Content-Type": resource.mediaType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Restrictive on purpose: this streams EPUB content (XHTML/CSS/images) that has already
      // been through the processor's sanitizer (Task 4), but the preview UI renders it in an
      // isolated frame, not trusted top-level navigation - no script execution, no framing by
      // anything but this app, no network egress from the resource itself.
      //
      // Unlike the reader route, that description is accurate HERE, and the difference is worth
      // knowing: the preview points an iframe directly at this route, so the browser enforces
      // exactly this header, and the element adds `sandbox=""` as a second lock. The reader path
      // instead fetches resources and re-hosts them as `blob:` documents under a CSP Readium
      // substitutes, which makes its copy of this header inert. Do not consolidate the two.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'",
    },
  });
}
