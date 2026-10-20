// What a reader can do with a book. Parent spec 3.3. The book page, search, sample reader, and
// library all use this. Server actions and RPCs re-check the same rules; this never grants access.
export type BookAction = "read" | "get_free" | "buy" | "coming_soon" | "unavailable";

export type BookActionInput = {
  hasActiveEntitlement: boolean;
  offer: { priceMinor: number; active: boolean } | null;
  hasActivePublication: boolean;
  paymentsEnabled: boolean;
};

// What a reader can do with a bundle. A bundle is never opened and never given away, so `read` and
// `get_free` are not among them; `owned_bundle` says there is nothing left to buy, which for a book
// would have been `read`.
export type BundleAction = Exclude<BookAction, "read" | "get_free"> | "owned_bundle";

// A bundle (S9 spec 6.3). `kind` is the discriminant, so a book input - which has no `kind` - keeps
// every answer it had before.
//
// Counts rather than a boolean, because a bundle has two separate things to say: what the reader
// can do (one action) and how much of the bundle they already hold (copy beside it). Only the
// PUBLISHED members are counted, because they are the ones the page shows and the ones
// create_bundle_order sells; a member that has since been unpublished is invisible to both.
//
// `owned_bundle` is not `read`: a bundle is never opened, its books are.
export type BundleActionInput = {
  kind: "bundle";
  publishedMemberCount: number;
  ownedMemberCount: number;
  offer: { priceMinor: number; active: boolean } | null;
  paymentsEnabled: boolean;
};

export function resolveBookAction(input: BookActionInput): BookAction;
export function resolveBookAction(input: BundleActionInput): BundleAction;
export function resolveBookAction(input: BookActionInput | BundleActionInput): BookAction | BundleAction {
  if ("kind" in input) return resolveBundleAction(input);
  if (!input.hasActivePublication) return "unavailable";
  if (input.hasActiveEntitlement) return "read";
  if (!input.offer?.active) return "unavailable";
  if (input.offer.priceMinor === 0) return "get_free";
  return input.paymentsEnabled ? "buy" : "coming_soon";
}

function resolveBundleAction(input: BundleActionInput): BundleAction {
  // A published bundle can drift below its own readiness bar - a member unpublished, the offer
  // deactivated - because readiness is a publish-time gate. With nothing left to show there is
  // nothing to buy either, and this comes first so that an empty bundle is never offered for sale.
  if (input.publishedMemberCount === 0) return "unavailable";
  if (input.ownedMemberCount >= input.publishedMemberCount) return "owned_bundle";
  // No free path: a bundle is a paid product, and a zero-price bundle offer is a pricing mistake
  // rather than a giveaway - create_bundle_order refuses it too (price_minor > 0).
  if (!input.offer?.active || input.offer.priceMinor === 0) return "unavailable";
  return input.paymentsEnabled ? "buy" : "coming_soon";
}
