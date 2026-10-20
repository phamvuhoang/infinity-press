import { NextResponse } from "next/server";

import type { ViewerBookActionState } from "@/lib/catalog/viewer-action";
import { getBookActionState, getBookCardById } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";

// The one part of a book page that differs per viewer. The page itself renders what an anonymous
// visitor could do, so it can be prerendered, and this fills in the rest in the browser. It grants
// nothing: the reader route, the Server Actions and the RPCs all check again.
export async function GET(request: Request, { params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;

  // The island sends the locale it rendered in - the page only ever renders in a locale the book is
  // localized in, so a same-locale lookup can never 404 for a book that only exists in the other
  // locale (the original reason this resolved both locales). An unsupported or missing value is a
  // caller bug, not something to paper over with a fallback.
  const locale = new URL(request.url).searchParams.get("locale");
  if (!locale || !isLocale(locale)) {
    return NextResponse.json({ error: "invalid_locale" }, { status: 400, headers: { "cache-control": "private, no-store" } });
  }

  // Resolve the card from the public catalog first. An id the storefront does not show in this
  // locale gets a 404 from the same read a visitor could do anyway, so this endpoint never confirms
  // a hidden book.
  const card = await getBookCardById(locale, bookId);
  if (!card) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "private, no-store" } });

  const state: ViewerBookActionState = await getBookActionState(card);
  return NextResponse.json(state, { headers: { "cache-control": "private, no-store" } });
}
