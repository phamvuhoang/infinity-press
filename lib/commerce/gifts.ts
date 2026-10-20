import "server-only";

import { requireUser } from "@/lib/auth/session";
import type { GiftCheckoutInput } from "@/lib/commerce/gift-form";
import { generateGiftToken, hashGiftToken } from "@/lib/commerce/gift-token";
import type { Locale } from "@/lib/i18n/config";
import { getCommerceRoutes } from "@/lib/i18n/routes";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

// Gifts (S9 spec 7.2-7.3). Four operations, all of them the reader's own: the purchaser configures
// or removes a gift on their own pending order and reads back what they set, and the recipient
// claims it. Every one of them goes through the user-session client after requireUser, and every
// authorization decision is made again inside the RPC from auth.uid() - neither side is trusted to
// have done it alone.
//
// The token discipline this module exists to keep (spec 7.1):
//
//   * The raw token is generated HERE, and the only place it goes is the claim path handed to the
//     database for the recipient's message. The database is sent the hash.
//   * configureGift returns void. Returning the token would put it in a Server Action's response,
//     and from there into browser state, history, and anything that records either.
//   * Nothing in this file logs a token, a claim path, or a recipient address. The error messages
//     below carry the RPC's name and its message, never its arguments.

// The order refused the operation: not the caller's, not pending, its transfer already reported,
// or its gift already activated. One class for all of them, because the database answers all of
// them with one code so that an order id cannot be probed by the error it produces.
export class GiftNotConfigurableError extends Error {
  constructor() {
    super("This order cannot be set up as a gift right now.");
    this.name = "GiftNotConfigurableError";
  }
}

// The token cannot be claimed: unknown, already claimed by somebody else, revoked, or belonging to
// an order that was never paid for. Deliberately indistinguishable - the token IS the
// authorization, so an error that told a guesser which of those applied would be an oracle.
export class GiftClaimRejectedError extends Error {
  constructor() {
    super("This gift link cannot be used.");
    this.name = "GiftClaimRejectedError";
  }
}

// gifts_status_check constrains the column to exactly these four values, which is why the row can
// be narrowed to them rather than carried around as an unconstrained string.
export type OrderGiftStatus = "pending" | "sent" | "claimed" | "revoked";

export type OrderGift = {
  recipientEmail: string;
  message: string | null;
  status: OrderGiftStatus;
};

type ClaimGiftRow = Database["public"]["Functions"]["claim_gift"]["Returns"][number];

export type ClaimedGiftBook = {
  bookId: string;
  title: string;
  entitlementId: string;
  // True when the claimant already held this book before the claim. The book is still listed -
  // the recipient should be told what the gift covered, not silently given a shorter list.
  alreadyOwned: boolean;
};

// EB028 and P0002 are the same thing to a reader: this order is not theirs to change right now.
function isOrderRefusal(code: string | undefined): boolean {
  return code === "EB028" || code === "P0002";
}

export async function configureGift(locale: Locale, orderId: string, input: GiftCheckoutInput): Promise<void> {
  await requireUser(locale);

  // Generated fresh on every call, including a correction: replacing the hash is what retires the
  // link that went to the wrong address.
  const token = generateGiftToken();
  const claimPath = getCommerceRoutes(locale).giftClaim(token);

  const supabase = await createClient();
  const { error } = await supabase.rpc("configure_gift", {
    p_order_id: orderId,
    p_recipient_email: input.recipientEmail,
    p_message: input.message,
    p_token_hash: await hashGiftToken(token),
    p_claim_path: claimPath,
  });

  if (error) {
    if (isOrderRefusal(error.code)) throw new GiftNotConfigurableError();
    throw new Error(`configureGift: configure_gift failed: ${error.message}`);
  }
}

export async function removeGift(locale: Locale, orderId: string): Promise<void> {
  await requireUser(locale);

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_gift", { p_order_id: orderId });

  if (error) {
    if (isOrderRefusal(error.code)) throw new GiftNotConfigurableError();
    throw new Error(`removeGift: remove_gift failed: ${error.message}`);
  }
}

// The checkout read. The RPC answers from public.gift_summaries, which has no claim_token_hash
// column at all, and returns only these three fields - so there is no path from here to the
// credential, and none to the claim link either.
export async function getMyOrderGift(locale: Locale, orderId: string): Promise<OrderGift | null> {
  await requireUser(locale);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_my_order_gift", { p_order_id: orderId });

  if (error) {
    if (isOrderRefusal(error.code)) throw new GiftNotConfigurableError();
    throw new Error(`getMyOrderGift: get_my_order_gift failed: ${error.message}`);
  }

  const row = data?.[0];
  if (!row) return null;

  return {
    recipientEmail: row.recipient_email,
    message: row.message,
    status: row.status as OrderGiftStatus,
  };
}

// The claim. The raw token arrives from the URL and goes straight to the RPC, which hashes it and
// compares hashes - it is never stored, logged, or echoed back in an error.
export async function claimGift(locale: Locale, token: string): Promise<ClaimedGiftBook[]> {
  await requireUser(locale);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("claim_gift", { p_token: token });

  if (error) {
    if (error.code === "EB029") throw new GiftClaimRejectedError();
    throw new Error(`claimGift: claim_gift failed: ${error.message}`);
  }

  // Annotated rather than inferred: `data` is nullable, and `?? []` on its own widens the element
  // type to never, which would make the mapping below silently untyped.
  const rows: ClaimGiftRow[] = data ?? [];

  return rows.map((row) => ({
    bookId: row.book_id,
    title: row.title,
    entitlementId: row.entitlement_id,
    alreadyOwned: row.already_owned,
  }));
}
