"use server";

import { revalidatePath } from "next/cache";

import {
  GrantTargetNotFoundError,
  grantComplimentaryEntitlement,
  MissingGrantReasonError,
  MissingRevokeReasonError,
  RevocableEntitlementNotFoundError,
  revokeComplimentaryEntitlement,
  TargetIdentityNotVerifiedError,
} from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";

// Every runtime export below is an async function, on purpose - see Task 2's "use server"
// hazard: a plain-object or non-function export from a "use server" module typechecks, lints,
// and builds cleanly while crashing the client at request time. Only type exports are safe
// alongside them.

export type EntitlementActionResult =
  | { ok: true; entitlementId: string }
  | { ok: false; error: string };

// The three typed errors grantComplimentaryEntitlement() can throw are all safe, specific
// messages an admin can act on directly - never a raw Supabase/Postgres error, which stays
// behind this generic fallback instead.
function toActionResult(error: unknown): EntitlementActionResult {
  if (
    error instanceof MissingGrantReasonError ||
    error instanceof GrantTargetNotFoundError ||
    error instanceof TargetIdentityNotVerifiedError ||
    error instanceof MissingRevokeReasonError ||
    error instanceof RevocableEntitlementNotFoundError
  ) {
    return { ok: false, error: error.message };
  }
  return { ok: false, error: "Something went wrong. Try again." };
}

// requireAdmin() runs here too, ahead of the try/catch, matching every other admin action in
// this codebase (e.g. app/admin/publications/[publicationId]/actions.ts): a lapsed session is
// redirected to sign in via next/navigation's redirect()/forbidden(), which must propagate
// uncaught rather than be mapped through toActionResult(). grantComplimentaryEntitlement() calls
// requireAdmin() again internally as its own library-boundary guarantee.
export async function grantComplimentaryEntitlementAction(
  profileId: string,
  bookId: string,
  reason: string,
): Promise<EntitlementActionResult> {
  await requireAdmin({ next: `/admin/users/${profileId}` });

  try {
    const { entitlementId } = await grantComplimentaryEntitlement(profileId, bookId, reason);
    revalidatePath(`/admin/users/${profileId}`);
    return { ok: true, entitlementId };
  } catch (error) {
    return toActionResult(error);
  }
}

export async function revokeComplimentaryEntitlementAction(
  profileId: string,
  entitlementId: string,
  reason: string,
): Promise<EntitlementActionResult> {
  await requireAdmin({ next: `/admin/users/${profileId}` });

  try {
    const result = await revokeComplimentaryEntitlement(profileId, entitlementId, reason);
    revalidatePath(`/admin/users/${profileId}`);
    return { ok: true, entitlementId: result.entitlementId };
  } catch (error) {
    return toActionResult(error);
  }
}
