"use client";

import Link from "next/link";

import { SubmitButton } from "@/components/auth/submit-button";
import { Button } from "@/components/ui/button";
import type { BookAction } from "@/lib/catalog/book-action";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

// Renders the result of resolveBookAction. It never grants access; the reader route, Server
// Actions, and RPCs check again.
export function BookActionControl({
  action,
  signedIn,
  bookId,
  bookPath,
  locale,
  copy,
  getFreeAction,
  buyAction,
}: {
  action: BookAction;
  signedIn: boolean;
  bookId: string;
  bookPath: string;
  locale: Locale;
  copy: Dictionary["catalog"]["actions"];
  // Bound Server Actions from the book page. The control only renders them; the actions and
  // create_ebook_order/acquire_free_ebook re-check everything.
  getFreeAction: () => Promise<void>;
  buyAction: () => Promise<void>;
}) {
  const routes = getCatalogRoutes(locale);

  switch (action) {
    case "read":
      return (
        <Button render={<Link href={routes.read(bookId)} />} size="lg">
          {copy.read}
        </Button>
      );
    case "get_free":
    case "buy": {
      const label = action === "get_free" ? copy.getFree : copy.buy;
      if (!signedIn) {
        return (
          <div className="space-y-2">
            <Button render={<Link href={routes.signInFor(bookPath)} />} size="lg">
              {label}
            </Button>
            <p className="text-sm text-ink-soft">{copy.signInHint}</p>
          </div>
        );
      }
      return (
        <form action={action === "get_free" ? getFreeAction : buyAction}>
          <SubmitButton className="" pendingLabel={copy.pending} size="lg">
            {label}
          </SubmitButton>
        </form>
      );
    }
    case "coming_soon":
      return (
        <Button disabled size="lg" variant="outline">
          {copy.comingSoon}
        </Button>
      );
    case "unavailable":
      return <p className="text-sm text-ink-soft">{copy.unavailable}</p>;
  }
}
