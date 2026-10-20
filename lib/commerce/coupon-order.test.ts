// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));

const { applyCouponToOrder, removeCouponFromOrder, CouponRejectedError, CouponRateLimitedError, OrderNotCouponableError } =
  await import("@/lib/commerce/coupon-order");

const ORDER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => rpc.mockReset());

describe("applyCouponToOrder", () => {
  it("returns the new amounts when the code applies", async () => {
    rpc.mockResolvedValue({
      data: [{ subtotal_minor: 129000, discount_minor: 25800, total_minor: 103200, order_status: "pending", entitlement_ids: [], rejection: null }],
      error: null,
    });
    await expect(applyCouponToOrder("en", ORDER, " twenty ")).resolves.toEqual({
      subtotalMinor: 129000,
      discountMinor: 25800,
      totalMinor: 103200,
      completed: false,
      entitlementIds: [],
    });
    // Normalized before it leaves the server: the database matches an upper-case code.
    expect(rpc).toHaveBeenCalledWith("apply_coupon_to_order", { p_order_id: ORDER, p_code: "TWENTY" });
  });

  // S9 spec 5: a fully discounted BUNDLE order grants every member book in the one call, so the
  // RPC returns a set. Mapping it to a single id would drop the rest on the floor.
  it("reports a completed order and every entitlement it granted", async () => {
    rpc.mockResolvedValue({
      data: [{ subtotal_minor: 300000, discount_minor: 300000, total_minor: 0, order_status: "completed", entitlement_ids: ["ent-1", "ent-2"], rejection: null }],
      error: null,
    });
    await expect(applyCouponToOrder("en", ORDER, "FREEBUNDLE")).resolves.toMatchObject({
      completed: true,
      entitlementIds: ["ent-1", "ent-2"],
    });
  });

  // S9 spec 7.2: a fully discounted GIFT order completes in the same call and grants the BUYER
  // nothing, so `completed` arrives with an empty array. The reader is sent to the order page,
  // not to a library that gained nothing.
  it("reports a completed gift order with no entitlement of its own", async () => {
    rpc.mockResolvedValue({
      data: [{ subtotal_minor: 300000, discount_minor: 300000, total_minor: 0, order_status: "completed", entitlement_ids: [], rejection: null }],
      error: null,
    });
    await expect(applyCouponToOrder("en", ORDER, "FREEGIFT")).resolves.toEqual({
      subtotalMinor: 300000,
      discountMinor: 300000,
      totalMinor: 0,
      completed: true,
      entitlementIds: [],
    });
  });

  // P6: apply_coupon_to_order no longer returns a `detail` column at all (Task 4's security fix
  // dropped it - a returned discriminating reason was a code oracle for the authenticated role).
  // The reason still reaches an operator, but only through `raise log` in the database, never
  // through this row. So a rejection from the RPC carries a null detail here, and the message a
  // reader could see never names which check failed.
  it("turns every rejection into one error class, with no detail from the row", async () => {
    rpc.mockResolvedValue({
      data: [{ subtotal_minor: 129000, discount_minor: 0, total_minor: 129000, order_status: "pending", entitlement_id: null, rejection: "invalid" }],
      error: null,
    });
    const error = await applyCouponToOrder("en", ORDER, "GONE").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CouponRejectedError);
    expect((error as InstanceType<typeof CouponRejectedError>).detail).toBeNull();
    // The message a reader could ever see says nothing about which check failed.
    expect((error as Error).message).not.toMatch(/expired|invalid|unknown|exhausted/i);
  });

  it("separates the rate limit, which the UI explains differently", async () => {
    rpc.mockResolvedValue({
      data: [{ subtotal_minor: 129000, discount_minor: 0, total_minor: 129000, order_status: "pending", entitlement_id: null, rejection: "rate_limited" }],
      error: null,
    });
    await expect(applyCouponToOrder("en", ORDER, "TWENTY")).rejects.toBeInstanceOf(CouponRateLimitedError);
  });

  it("maps EB024 to the order error, not the code error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB024", message: "not a pending order" } });
    await expect(applyCouponToOrder("en", ORDER, "TWENTY")).rejects.toBeInstanceOf(OrderNotCouponableError);
  });

  // The local malformed-code pre-check still throws its own detail - that reason is known to the
  // application itself, not learned from the database, so it is not the oracle the RPC's dropped
  // `detail` column would have been.
  it("refuses a malformed code without calling the database at all", async () => {
    const error = await applyCouponToOrder("en", ORDER, "no").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CouponRejectedError);
    expect((error as InstanceType<typeof CouponRejectedError>).detail).toBe("malformed code");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("removeCouponFromOrder", () => {
  it("returns the restored amounts", async () => {
    rpc.mockResolvedValue({ data: [{ subtotal_minor: 129000, discount_minor: 0, total_minor: 129000 }], error: null });
    await expect(removeCouponFromOrder("en", ORDER)).resolves.toEqual({ subtotalMinor: 129000, discountMinor: 0, totalMinor: 129000 });
  });

  it("maps EB024 to the order error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB024", message: "no coupon" } });
    await expect(removeCouponFromOrder("en", ORDER)).rejects.toBeInstanceOf(OrderNotCouponableError);
  });
});
