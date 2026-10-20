import { type BookAction, resolveBookAction } from "@/lib/catalog/book-action";
import type { CatalogEditionOption } from "@/lib/catalog/public-types";

export type EditionSelection =
  | { status: "selected"; edition: CatalogEditionOption }
  | { status: "invalid" }
  | { status: "none" };

// Which edition the book page shows. An explicit request must name one of the work's readable
// editions; an id that is not on the list is `invalid` and never becomes the default, so a stale or
// forged link cannot put a different product behind the Buy button.
export function selectEdition(editions: CatalogEditionOption[], requested: string | null): EditionSelection {
  if (editions.length === 0) return { status: "none" };
  if (requested) {
    const match = editions.find((edition) => edition.editionId === requested);
    return match ? { status: "selected", edition: match } : { status: "invalid" };
  }
  const fallback = editions.find((edition) => edition.isDefault) ?? editions[0];
  return { status: "selected", edition: fallback };
}

// What an anonymous visitor could do with this edition. Pure, so the prerendered page and the
// browser agree; the viewer's own state (ownership, session) comes from the action-state route.
export function editionPublicAction(edition: CatalogEditionOption, paymentsEnabled: boolean): BookAction {
  return resolveBookAction({
    hasActiveEntitlement: false,
    offer: edition.offer ? { priceMinor: edition.offer.priceMinor, active: true } : null,
    hasActivePublication: true,
    paymentsEnabled,
  });
}
