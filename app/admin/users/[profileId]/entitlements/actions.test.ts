// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantComplimentaryEntitlementAction, revokeComplimentaryEntitlementAction } from "@/app/admin/users/[profileId]/entitlements/actions";
import { grantComplimentaryEntitlement, revokeComplimentaryEntitlement } from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";
import { revalidatePath } from "next/cache";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({
  GrantTargetNotFoundError: class extends Error {},
  MissingGrantReasonError: class extends Error {},
  MissingRevokeReasonError: class extends Error {},
  RevocableEntitlementNotFoundError: class extends Error {},
  TargetIdentityNotVerifiedError: class extends Error {},
  grantComplimentaryEntitlement: vi.fn(),
  revokeComplimentaryEntitlement: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const profileId = "20000000-0000-0000-0000-000000000001";
const entitlementId = "80000000-0000-0000-0000-000000000001";

it("grants and returns to the user detail page", async () => {
  vi.mocked(grantComplimentaryEntitlement).mockResolvedValue({ entitlementId });
  await expect(grantComplimentaryEntitlementAction(profileId, "book-id", "Reviewer")).resolves.toEqual({ ok: true, entitlementId });
  expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/users/${profileId}` });
  expect(grantComplimentaryEntitlement).toHaveBeenCalledWith(profileId, "book-id", "Reviewer");
  expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(`/admin/users/${profileId}`);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(revokeComplimentaryEntitlement).mockResolvedValue({ entitlementId });
});

describe("revokeComplimentaryEntitlementAction", () => {
  it("stops before the mutation when the route-level admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(revokeComplimentaryEntitlementAction(profileId, entitlementId, "campaign ended")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(revokeComplimentaryEntitlement).not.toHaveBeenCalled();
  });

  it("revokes the entitlement and invalidates the admin path", async () => {
    const result = await revokeComplimentaryEntitlementAction(profileId, entitlementId, "campaign ended");

    expect(revokeComplimentaryEntitlement).toHaveBeenCalledExactlyOnceWith(
      profileId,
      entitlementId,
      "campaign ended",
    );
    expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/users/${profileId}` });
    expect(revalidatePath).toHaveBeenCalledExactlyOnceWith(`/admin/users/${profileId}`);
    expect(result).toEqual({ ok: true, entitlementId });
  });
});
