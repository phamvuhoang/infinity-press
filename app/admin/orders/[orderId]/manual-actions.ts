"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { requireAdmin } from "@/lib/auth/admin";
import {
  AmountMismatchError,
  DuplicateBankReferenceError,
  NotAPendingManualOrderError,
  confirmManualPayment,
  rejectManualPayment,
  type DeclineOutcome,
} from "@/lib/commerce/manual-payment";
import { minorFromMajorText } from "@/lib/commerce/money";
import { getAdminOrder } from "@/lib/data/admin-orders";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function; only type exports are safe beside them.

export type ManualDecisionState =
  | { status: "idle" }
  | { status: "done" }
  | { status: "mismatch"; receivedMinor: number; expectedMinor: number }
  | { status: "error"; message: string };

const GENERIC_ERROR = "Something went wrong. Try again.";

function revalidate(orderId: string): void {
  revalidatePath(`/admin/orders/${orderId}`);
  revalidatePath("/admin/payments");
}

async function logFailure(operation: string, orderId: string, error: unknown): Promise<void> {
  console.error("Manual payment decision failed.", {
    operation,
    orderId,
    requestId: getRequestId(await headers()),
    error: String(error),
  });
}

export async function confirmManualPaymentAction(
  orderId: string,
  _previous: ManualDecisionState,
  formData: FormData,
): Promise<ManualDecisionState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const bankReference = String(formData.get("reference") ?? "").trim();
  if (!bankReference) return { status: "error", message: "Enter the bank transaction reference." };

  // getAdminOrder never returns null: a missing or malformed order id calls notFound() internally
  // and this Server Action never gets a chance to run. There is nothing to check here.
  const order = await getAdminOrder(orderId);

  // The amount is typed in the order's currency and parsed as exact decimal text. Anything else is
  // a typo, and guessing at it would write the wrong number into the reconciliation record.
  const receivedAmountMinor = minorFromMajorText(String(formData.get("amount") ?? ""), order.currency);
  if (receivedAmountMinor === null) {
    return { status: "error", message: "Enter the received amount in the order's currency, without rounding." };
  }

  const note = String(formData.get("note") ?? "").trim();

  try {
    await confirmManualPayment(orderId, {
      receivedAmountMinor,
      expectedAmountMinor: order.totalMinor,
      bankReference,
      note: note === "" ? null : note,
      acceptMismatch: formData.get("accept-mismatch") === "on",
    });
  } catch (error) {
    if (error instanceof AmountMismatchError) {
      return { status: "mismatch", receivedMinor: error.receivedMinor, expectedMinor: error.expectedMinor };
    }
    if (error instanceof DuplicateBankReferenceError) {
      return { status: "error", message: "That bank reference is already recorded on another order." };
    }
    if (error instanceof NotAPendingManualOrderError) {
      return { status: "error", message: "This order is no longer awaiting a transfer." };
    }
    await logFailure("confirmManualPaymentAction", orderId, error);
    return { status: "error", message: GENERIC_ERROR };
  }

  revalidate(orderId);
  return { status: "done" };
}

export async function declineManualPaymentAction(
  orderId: string,
  _previous: ManualDecisionState,
  formData: FormData,
): Promise<ManualDecisionState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: "Enter a reason before declining." };

  const outcome = String(formData.get("outcome") ?? "");
  if (outcome !== "not_received" && outcome !== "cancel") {
    return { status: "error", message: GENERIC_ERROR };
  }

  try {
    await rejectManualPayment(orderId, reason, outcome satisfies DeclineOutcome);
  } catch (error) {
    if (error instanceof NotAPendingManualOrderError) {
      return { status: "error", message: "This order is no longer awaiting a transfer." };
    }
    await logFailure("declineManualPaymentAction", orderId, error);
    return { status: "error", message: GENERIC_ERROR };
  }

  revalidate(orderId);
  return { status: "done" };
}
