import { NextResponse } from "next/server";

import type { ViewerBundleActionState } from "@/lib/catalog/viewer-action";
import { getBundleActionState, getBundleOwnership, getPublicBundleById } from "@/lib/data/public-bundles";
import { isLocale } from "@/lib/i18n/config";

// The one part of a bundle page that differs per viewer. The page itself renders what an anonymous
// visitor could do, so it can be prerendered, and this fills in the rest in the browser. It grants
// nothing: buyBundleAction and create_bundle_order re-check the reader and the bundle again.
export async function GET(request: Request, { params }: { params: Promise<{ bundleId: string }> }) {
  const { bundleId } = await params;

  // The island sends the locale it rendered in - the page only ever renders in a locale the bundle
  // is localized in - so the lookup below stays in that one locale. An unsupported or missing value
  // is a caller bug, not something to paper over with a fallback.
  const locale = new URL(request.url).searchParams.get("locale");
  if (!locale || !isLocale(locale)) {
    return NextResponse.json({ error: "invalid_locale" }, { status: 400, headers: { "cache-control": "private, no-store" } });
  }

  // Resolve the bundle from the public catalog first. An id the storefront does not show in this
  // locale gets a 404 from the same read a visitor could do anyway, so this endpoint never confirms
  // a hidden bundle.
  const bundle = await getPublicBundleById(locale, bundleId);
  if (!bundle) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } });

  const ownedMemberCount = await getBundleOwnership(bundle.members);
  const { action, signedIn } = await getBundleActionState({
    publishedMemberCount: bundle.members.length,
    ownedMemberCount,
    offer: bundle.offer,
  });

  const state: ViewerBundleActionState = { action, signedIn, ownedMemberCount };
  return NextResponse.json(state, { headers: { "cache-control": "private, no-store" } });
}
