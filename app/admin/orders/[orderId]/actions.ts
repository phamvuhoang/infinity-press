"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { OrderEntitlementNotFoundError, revokeOrderEntitlement } from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function; only type exports are safe beside them.

export type RevokeOrderAccessState = { status: "idle" } | { status: "done" } | { status: "error"; message: string };

export async function revokeOrderAccessAction(
  orderId: string,
  _previous: RevokeOrderAccessState,
  formData: FormData,
): Promise<RevokeOrderAccessState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: "Enter a reason before revoking access." };

  try {
    await revokeOrderEntitlement(orderId, reason);
  } catch (error) {
    if (error instanceof OrderEntitlementNotFoundError) {
      return { status: "error", message: "This order has no access to revoke." };
    }
    console.error("Revoke order access failed.", { orderId, requestId: getRequestId(await headers()), error: String(error) });
    return { status: "error", message: "Something went wrong. Try again." };
  }

  revalidatePath(`/admin/orders/${orderId}`);
  return { status: "done" };
}
