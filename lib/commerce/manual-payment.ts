import "server-only";

import { requireAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError } from "@/lib/commerce/errors";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

export class NotAClaimableOrderError extends Error {
  constructor() {
    super("This order is not waiting for a bank transfer.");
    this.name = "NotAClaimableOrderError";
  }
}

export class AmountMismatchError extends Error {
  constructor(
    readonly receivedMinor: number,
    readonly expectedMinor: number,
  ) {
    super("The received amount does not match the order total.");
    this.name = "AmountMismatchError";
  }
}

export class NotAPendingManualOrderError extends Error {
  constructor() {
    super("This order is not a pending manual payment.");
    this.name = "NotAPendingManualOrderError";
  }
}

export class MissingBankReferenceError extends Error {
  constructor() {
    super("Enter the bank transaction reference before confirming.");
    this.name = "MissingBankReferenceError";
  }
}

export class DuplicateBankReferenceError extends Error {
  constructor() {
    super("That bank reference is already recorded on another order.");
    this.name = "DuplicateBankReferenceError";
  }
}

export class MissingDeclineReasonError extends Error {
  constructor() {
    super("Enter a reason before declining.");
    this.name = "MissingDeclineReasonError";
  }
}

// The reader reports a transfer (spec 5.5). Idempotent in the database, so a double submit is safe.
export async function claimManualTransfer(locale: Locale, orderId: string, note: string | null): Promise<void> {
  await requireUser(locale);
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_manual_transfer", { p_order_id: orderId, p_note: note });
  if (error) {
    // EB020: not the caller's own pending manual order. P0002: no profile at all for the current
    // session (claim_manual_transfer's own first check). Both mean the same thing to the reader -
    // this order cannot be claimed right now - so both map to the same error class.
    if (error.code === "EB020" || error.code === "P0002") throw new NotAClaimableOrderError();
    // EB017: the reader already holds an active entitlement for this book, so there is nothing to
    // pay for. Kept apart from NotAClaimableOrderError because the two send the reader to different
    // places - one to the book they own, the other back to their orders.
    if (error.code === "EB017") throw new AlreadyOwnedError();
    throw new Error(`claimManualTransfer: claim_manual_transfer failed: ${error.message}`);
  }
}

export type ConfirmManualPaymentInput = {
  receivedAmountMinor: number;
  // The caller already holds the order, so the expected total travels with the call rather than
  // being parsed back out of the database's error message.
  expectedAmountMinor: number;
  bankReference: string;
  note: string | null;
  acceptMismatch: boolean;
};

// Admin confirmation (spec 5.6). The RPC checks is_admin() as well; this gate is the application
// half, and neither one is sufficient alone.
export async function confirmManualPayment(orderId: string, input: ConfirmManualPaymentInput): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_manual_payment", {
    p_order_id: orderId,
    p_received_amount_minor: input.receivedAmountMinor,
    p_bank_reference: input.bankReference,
    p_note: input.note,
    p_accept_mismatch: input.acceptMismatch,
  });
  if (error) {
    if (error.code === "EB021") {
      throw new AmountMismatchError(input.receivedAmountMinor, input.expectedAmountMinor);
    }
    if (error.code === "EB022") throw new NotAPendingManualOrderError();
    if (error.code === "EB043") throw new DuplicateBankReferenceError();
    if (error.code === "22023") throw new MissingBankReferenceError();
    throw new Error(`confirmManualPayment: confirm_manual_payment failed: ${error.message}`);
  }
}

export type DeclineOutcome = "not_received" | "cancel";

// Admin decline (spec 5.6). EB023 (an unknown outcome) is deliberately left unmapped: DeclineOutcome
// only ever lets the UI send "not_received" or "cancel", so that code reaching here means that
// constraint broke somewhere upstream, and it must surface as a loud, unrecognized failure rather
// than a named error the UI would treat as an expected, recoverable state.
export async function rejectManualPayment(orderId: string, reason: string, outcome: DeclineOutcome): Promise<void> {
  await requireAdmin();
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_manual_payment", {
    p_order_id: orderId,
    p_reason: reason,
    p_outcome: outcome,
  });
  if (error) {
    if (error.code === "EB022") throw new NotAPendingManualOrderError();
    if (error.code === "22023") throw new MissingDeclineReasonError();
    throw new Error(`rejectManualPayment: reject_manual_payment failed: ${error.message}`);
  }
}
