// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { revokeOrderAccessAction } from "@/app/admin/orders/[orderId]/actions";
import { OrderEntitlementNotFoundError, revokeOrderEntitlement } from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/access/grant", () => {
  class OrderEntitlementNotFoundError extends Error {}
  return { revokeOrderEntitlement: vi.fn(), OrderEntitlementNotFoundError };
});

const ORDER_ID = "70000000-0000-4000-8000-000000000001";

function form(reason: string) {
  const data = new FormData();
  data.set("reason", reason);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("revokeOrderAccessAction", () => {
  it("gates on requireAdmin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).rejects.toThrow("NEXT_FORBIDDEN");
    expect(revokeOrderEntitlement).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("   "))).resolves.toEqual({
      status: "error",
      message: "Enter a reason before revoking access.",
    });
    expect(revokeOrderEntitlement).not.toHaveBeenCalled();
  });

  it("revokes with the trimmed reason", async () => {
    vi.mocked(revokeOrderEntitlement).mockResolvedValue({ entitlementIds: ["e1", "e2"] });
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form(" Chargeback "))).resolves.toEqual({ status: "done" });
    expect(revokeOrderEntitlement).toHaveBeenCalledWith(ORDER_ID, "Chargeback");
  });

  it("explains when the order granted nothing", async () => {
    vi.mocked(revokeOrderEntitlement).mockRejectedValue(new OrderEntitlementNotFoundError());
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).resolves.toEqual({
      status: "error",
      message: "This order has no access to revoke.",
    });
  });

  it("hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(revokeOrderEntitlement).mockRejectedValue(new Error("secret detail"));
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).resolves.toEqual({
      status: "error",
      message: "Something went wrong. Try again.",
    });
  });
});
