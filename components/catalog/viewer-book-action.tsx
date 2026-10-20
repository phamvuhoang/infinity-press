"use client";

import { BookActionControl } from "@/components/catalog/book-action-control";
import { useViewerAction } from "@/components/catalog/use-viewer-action";
import type { BookAction } from "@/lib/catalog/book-action";
import type { ViewerBookActionState } from "@/lib/catalog/viewer-action";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

// The book page prerenders `publicAction` - what an anonymous visitor could do - and this corrects
// it for the reader who is signed in or already owns the book. The Server Actions arrive as props,
// created on the server by the page; they re-check everything when invoked.
export function ViewerBookAction({
  bookId,
  editionId,
  bookPath,
  buyAction,
  copy,
  getFreeAction,
  locale,
  publicAction,
  disabled = false,
}: {
  bookId: string;
  // The edition this control is about. Ownership, the reader link and the order are all per edition.
  editionId: string;
  bookPath: string;
  buyAction: () => Promise<void>;
  copy: Dictionary["catalog"]["actions"];
  getFreeAction: () => Promise<void>;
  locale: Locale;
  publicAction: BookAction;
  disabled?: boolean;
}) {
  // Sends the locale it rendered in, so the handler resolves the book in that one locale rather than
  // searching every locale for whichever answers first (Ruling 4) - the page only ever renders in a
  // locale the book is localized in, so this can never 404 for that reason.
  const state = useViewerAction<ViewerBookActionState>(
    `/api/catalog/books/${bookId}/action-state?${new URLSearchParams({ locale, edition: editionId })}`,
    { action: publicAction, signedIn: false },
  );

  return (
    <BookActionControl
      action={state.action}
      bookPath={bookPath}
      buyAction={buyAction}
      copy={copy}
      disabled={disabled}
      getFreeAction={getFreeAction}
      locale={locale}
      readHref={getCatalogRoutes(locale).readEdition(editionId)}
      signedIn={state.signedIn}
    />
  );
}
