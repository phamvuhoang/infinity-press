import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";
import type { Locale } from "@/lib/i18n/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The three ways a reader ends up with an active entitlement (spec 6.2/6.3/6.4), each behind its
// own authorization model (Ruling AO) and its own RPC
// (supabase/migrations/20260911190000_entitlement_rpcs.sql):
//
// - acquireFreeOffer: an ordinary signed-in customer, gated on requireUser - never requireAdmin.
//   acquire_free_ebook derives the profile from auth.uid() itself; this function never accepts or
//   forwards a caller-supplied profile id.
// - grantComplimentaryEntitlement: an admin mutation on the Ruling W pattern - the user-session
//   client, gated on requireAdmin, with grant_complimentary_entitlement's own is_admin() check as
//   the database-side backstop.
// - applyVerifiedPaymentEvent: reached with no session at all, from the simulator webhook handler
//   (lib/commerce/simulator-webhook.ts) after the event signature has passed. Never gated here on
//   requireAdmin/requireUser, and always the
//   service-role client: apply_payment_event's EXECUTE grant is service_role only, and its trust
//   boundary is the verified-event contract plus payment_events' unique(provider,
//   provider_event_id) constraint, never a role predicate.

export class EmailNotVerifiedError extends Error {
  constructor() {
    super("Verify your email before claiming this free ebook.");
    this.name = "EmailNotVerifiedError";
  }
}

export class NoFreeOfferError extends Error {
  constructor() {
    super("This book has no active free offer right now.");
    this.name = "NoFreeOfferError";
  }
}

export class MissingGrantReasonError extends Error {
  constructor() {
    super("A reason is required to grant complimentary access.");
    this.name = "MissingGrantReasonError";
  }
}

export class GrantTargetNotFoundError extends Error {
  constructor() {
    super("That reader or book could not be found.");
    this.name = "GrantTargetNotFoundError";
  }
}

export class TargetIdentityNotVerifiedError extends Error {
  constructor() {
    super("That reader has no verified email yet.");
    this.name = "TargetIdentityNotVerifiedError";
  }
}

export class MissingRevokeReasonError extends Error {
  constructor() {
    super("A reason is required to revoke complimentary access.");
    this.name = "MissingRevokeReasonError";
  }
}

export class RevocableEntitlementNotFoundError extends Error {
  constructor() {
    super("That complimentary entitlement could not be found.");
    this.name = "RevocableEntitlementNotFoundError";
  }
}

export class OrderEntitlementNotFoundError extends Error {
  constructor() {
    super("That order granted no access.");
    this.name = "OrderEntitlementNotFoundError";
  }
}

// Free acquisition (spec 6.2). Idempotent: acquire_free_ebook uses
// entitlements_active_subject_key (a partial unique index, not a hand-rolled check-then-insert)
// so a retried request resolves to the same entitlement instead of erroring or duplicating
// access - the opposite of admin_create_ebook's deliberate reject-on-duplicate.
export async function acquireFreeOffer(locale: Locale, bookId: string): Promise<{ entitlementId: string }> {
  await requireUser(locale);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("acquire_free_ebook", { p_book_id: bookId });

  if (error) {
    if (error.code === "EB005") throw new EmailNotVerifiedError();
    if (error.code === "EB006") throw new NoFreeOfferError();
    throw new Error(`acquireFreeOffer: acquire_free_ebook failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("acquireFreeOffer: acquire_free_ebook returned no entitlement id");
  }

  return { entitlementId: data };
}

// Complimentary access (spec 6.3). No order or payment is ever created here - the RPC's own
// entitlements_source_consistency CHECK constraint forbids an admin_grant from carrying a
// source_order_id at all, so there is no code path that could fabricate one. The RPC records the
// audit event in the same transaction as the grant (audit_logs is immutable - a compensating
// write is not available if the two were ever split).
export async function grantComplimentaryEntitlement(
  profileId: string,
  bookId: string,
  reason: string,
): Promise<{ entitlementId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("grant_complimentary_entitlement", {
    p_profile_id: profileId,
    p_book_id: bookId,
    p_reason: reason,
  });

  if (error) {
    if (error.code === "22023") throw new MissingGrantReasonError();
    if (error.code === "P0002") throw new GrantTargetNotFoundError();
    if (error.code === "EB007") throw new TargetIdentityNotVerifiedError();
    throw new Error(`grantComplimentaryEntitlement: grant_complimentary_entitlement failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("grantComplimentaryEntitlement: grant_complimentary_entitlement returned no entitlement id");
  }

  return { entitlementId: data };
}

export async function revokeComplimentaryEntitlement(
  profileId: string,
  entitlementId: string,
  reason: string,
): Promise<{ entitlementId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_complimentary_entitlement", {
    p_profile_id: profileId,
    p_entitlement_id: entitlementId,
    p_reason: reason,
  });

  if (error) {
    if (error.code === "22023") throw new MissingRevokeReasonError();
    if (error.code === "P0002") throw new RevocableEntitlementNotFoundError();
    throw new Error(`revokeComplimentaryEntitlement: revoke_complimentary_entitlement failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("revokeComplimentaryEntitlement: revoke_complimentary_entitlement returned no entitlement id");
  }

  return { entitlementId: data };
}

// Revokes the access one order granted (S3 spec 4.4, S9 spec 5). The RPC only finds the
// entitlements whose source_order_id is this order - all of them, since an order may hold several
// books - so grants and other orders stay untouched, and it writes one audit row for the whole
// decision in the same transaction.
export async function revokeOrderEntitlement(orderId: string, reason: string): Promise<{ entitlementIds: string[] }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_order_entitlement", { p_order_id: orderId, p_reason: reason });

  if (error) {
    if (error.code === "22023") throw new MissingRevokeReasonError();
    if (error.code === "P0002") throw new OrderEntitlementNotFoundError();
    throw new Error(`revokeOrderEntitlement: revoke_order_entitlement failed: ${error.message}`);
  }
  // An empty array never comes back: the RPC raises P0002 when the order granted nothing at all,
  // which is mapped above, so anything but a non-empty array here is a contract break.
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("revokeOrderEntitlement: revoke_order_entitlement returned no entitlement ids");
  }

  return { entitlementIds: data };
}

export type AppliedPaymentEventOutcome = {
  // One entitlement per book of the order (S9 spec 5), empty when the event granted nothing -
  // a failure, a cancellation, or a replay of either.
  //
  // A completed GIFT order is also empty, and on every delivery of the event rather than only the
  // first (S9 spec 7.2): the buyer bought it for somebody else, so the purchase grants them no
  // access and the gift becomes claimable instead. The caller must not read an empty array on a
  // 'completed' order as a failure - apply_payment_event's success branch is where that decision
  // is made, and it is the same array a failure returns because the buyer holds the same nothing.
  entitlementIds: string[];
  orderStatus: string;
  paymentStatus: string;
};

// The order a provider's notification names by its reference code. Service role, so it is called
// only after the notification has been authenticated - the same condition applyVerifiedPaymentEvent
// runs under. It returns an ID and nothing else.
export async function findOrderIdByReference(referenceCode: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("orders")
    .select("id")
    .eq("reference_code", referenceCode)
    .maybeSingle();
  if (error) {
    throw new Error(`findOrderIdByReference: ${error.message}`);
  }
  return data?.id ?? null;
}

// The external payment ID an order's payment row holds for a provider: the notification that
// completed the order. A later, different one is money the order did not need. Service role, like
// findOrderIdByReference, and called only after the same authentication.
export async function findPaymentExternalId(orderId: string, provider: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("payments")
    .select("external_payment_id")
    .eq("order_id", orderId)
    .eq("provider", provider)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`findPaymentExternalId: ${error.message}`);
  }
  return data?.external_payment_id ?? null;
}

// Simulated payment (spec 6.4). apply_payment_event inserts the unique provider event first and
// returns the existing outcome on conflict - that ordering (not a check performed afterwards) is
// what makes duplicate delivery of the same event safe, and a terminal-order guard inside the
// same function is what stops a late, out-of-order event from resurrecting an already-cancelled
// order. Both are enforced entirely in the RPC; this wrapper only relays whatever it returns.
export async function applyVerifiedPaymentEvent(event: VerifiedPaymentEvent): Promise<AppliedPaymentEventOutcome> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("apply_payment_event", {
    p_provider: event.provider,
    p_provider_event_id: event.eventId,
    p_order_id: event.orderId,
    p_external_payment_id: event.externalPaymentId,
    p_status: event.status,
    p_amount_minor: event.amountMinor,
    p_currency: event.currency,
    p_occurred_at: event.occurredAt,
  });

  if (error) {
    // EB016 joins P0002 and EB004 for the same reason they are together: all three mean the event
    // does not belong to this order - it is missing, its amount is not the order's, or its provider
    // is not the one the order was booked under - so the webhook answers 422, not 500.
    if (error.code === "P0002" || error.code === "EB004" || error.code === "EB016") {
      throw new PaymentEventRejectedError();
    }
    throw new Error(`applyVerifiedPaymentEvent: apply_payment_event failed: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { entitlement_ids: string[] | null; order_status: string; payment_status: string }
    | undefined;

  if (!row) {
    throw new Error("applyVerifiedPaymentEvent: apply_payment_event returned no outcome");
  }

  return {
    entitlementIds: row.entitlement_ids ?? [],
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
  };
}
