import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { generateGiftToken, hashGiftToken } from "@/lib/commerce/gift-token";
import type { OrderGiftStatus } from "@/lib/commerce/gifts";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getCommerceRoutes } from "@/lib/i18n/routes";
import { createClient } from "@/lib/supabase/server";

// The gift support surface (S9 spec 7.4). Three operations, all of them an operator's, and every
// one of them gated twice: requireAdmin() here BEFORE a client exists, and is_admin() again inside
// the RPC from auth.uid(). Neither side is trusted to have done it alone.
//
// The token discipline lib/commerce/gifts.ts keeps for the purchaser, this module keeps for the
// operator, and one step further:
//
//   * reissueGift generates the new raw token here and hands the database only the hash and the
//     claim path. It returns void. An operator never needs the link - the recipient is mailed it -
//     and a Server Action that returned one would put a live credential into browser state,
//     history, and anything that records either.
//   * searchAdminGifts returns no hash and no claim path, because admin_search_gifts has neither
//     as a column. It does return the claim LOCALE, so the reissue form can keep the recipient in
//     the language they were first written to.
//   * Nothing here logs a recipient address, a token, or a claim path. The error messages below
//     carry the RPC's name and its message, never its arguments.

// A support query is typed by a human into a search box. Bounded so that a pasted document cannot
// become a 100kB LIKE pattern; the RPC caps the result set at 50 rows independently.
export const MAX_GIFT_QUERY_LENGTH = 120;

// EB030, raised by BOTH RPCs: the gift is not in `sent`, so there is no live delivery to retry or
// to replace - or a `sent` gift has no outbox row, which means an invariant broke. `sent` is what
// an order completing sets, and claim_gift trusts that status instead of rechecking payment, so
// neither operation may touch an unpaid gift.
export class GiftNotSendableError extends Error {
  constructor() {
    super("This gift has no live claim link. Only a sent, unclaimed gift can be resent or reissued.");
    this.name = "GiftNotSendableError";
  }
}

// EB031: the gift has been claimed. Taking the books back is revoke_order_entitlement's job - and
// note that a book revoked after a claim simply drops out of a replayed claim page, so the
// recipient sees a shorter list rather than an explanation. Say so in operator-facing copy.
export class GiftAlreadyClaimedError extends Error {
  constructor() {
    super("This gift has already been claimed, so it cannot be reissued. Revoke the order's access instead.");
    this.name = "GiftAlreadyClaimedError";
  }
}

// P0002: no such gift. Both RPCs raise it for the same condition.
export class GiftNotFoundError extends Error {
  constructor() {
    super("This gift no longer exists. Reload the page.");
    this.name = "GiftNotFoundError";
  }
}

export type AdminGiftDTO = {
  id: string;
  orderId: string;
  referenceCode: string;
  // Null when the purchaser has no verified identity row yet.
  purchaserEmail: string | null;
  recipientEmail: string;
  itemTitles: string[];
  itemCount: number;
  status: OrderGiftStatus;
  // The locale the recipient's message is rendered in, read back from the stored claim path. Null
  // when the gift has no outbox row left - a claimed gift's payload is cleared by claim_gift.
  claimLocale: Locale | null;
  createdAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
  // The delivery state of the one outbox row, so the operator can tell "never tried" from "tried
  // six times and gave up" before deciding between resend and reissue.
  attemptCount: number | null;
  lastErrorCode: string | null;
  sentAt: string | null;
};

// Every column admin_search_gifts declares nullable comes back from the generated types as
// non-null (the generator cannot see a set-returning function's nullability), so the row is
// re-typed honestly here rather than asserted through.
type GiftRow = {
  gift_id: string;
  order_id: string;
  reference_code: string;
  purchaser_email: string | null;
  recipient_email: string;
  item_titles: string[] | null;
  item_count: number;
  status: string;
  claim_locale: string | null;
  created_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
  attempt_count: number | null;
  last_error_code: string | null;
  sent_at: string | null;
};

function toDTO(row: GiftRow): AdminGiftDTO {
  return {
    id: row.gift_id,
    orderId: row.order_id,
    referenceCode: row.reference_code,
    purchaserEmail: row.purchaser_email,
    recipientEmail: row.recipient_email,
    itemTitles: row.item_titles ?? [],
    itemCount: Number(row.item_count),
    status: row.status as OrderGiftStatus,
    claimLocale: row.claim_locale !== null && isLocale(row.claim_locale) ? row.claim_locale : null,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    revokedAt: row.revoked_at,
    attemptCount: row.attempt_count === null ? null : Number(row.attempt_count),
    lastErrorCode: row.last_error_code,
    sentAt: row.sent_at,
  };
}

export async function searchAdminGifts(rawQuery: string | undefined): Promise<AdminGiftDTO[]> {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_search_gifts", {
    p_query: (rawQuery ?? "").trim().slice(0, MAX_GIFT_QUERY_LENGTH),
  });
  if (error) throw new Error(`searchAdminGifts: admin_search_gifts failed: ${error.message}`);
  return ((data ?? []) as unknown as GiftRow[]).map(toDTO);
}

function refusal(code: string | undefined): Error | null {
  if (code === "EB030") return new GiftNotSendableError();
  if (code === "EB031") return new GiftAlreadyClaimedError();
  if (code === "P0002") return new GiftNotFoundError();
  return null;
}

export async function resendGift(giftId: string): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_resend_gift", { p_gift_id: giftId });
  if (error) {
    throw refusal(error.code) ?? new Error(`resendGift: admin_resend_gift failed: ${error.message}`);
  }
}

// The new token is generated here and leaves this function only as a hash and as the path inside
// the database's protected outbox payload. The return type is void on purpose.
export async function reissueGift(
  giftId: string,
  recipientEmail: string,
  locale: Locale,
  reason: string,
): Promise<void> {
  await requireAdmin();

  const token = generateGiftToken();
  const claimPath = getCommerceRoutes(locale).giftClaim(token);

  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_reissue_gift", {
    p_gift_id: giftId,
    p_recipient_email: recipientEmail,
    p_token_hash: await hashGiftToken(token),
    p_claim_path: claimPath,
    p_reason: reason,
  });
  if (error) {
    throw refusal(error.code) ?? new Error(`reissueGift: admin_reissue_gift failed: ${error.message}`);
  }
}
