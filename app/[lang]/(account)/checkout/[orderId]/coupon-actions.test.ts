// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORDER = "11111111-1111-4111-8111-111111111111";
const BOOK = "22222222-2222-4222-8222-222222222222";

const applyCouponToOrder = vi.fn();
const removeCouponFromOrder = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "user" })) }));
const getCustomerOrder = vi.fn();
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder }));
vi.mock("@/lib/commerce/coupon-order", async () => {
  const actual = await vi.importActual<typeof import("@/lib/commerce/coupon-order")>("@/lib/commerce/coupon-order");
  return { ...actual, applyCouponToOrder, removeCouponFromOrder };
});

const { applyCouponAction, removeCouponAction } = await import(
  "@/app/[lang]/(account)/checkout/[orderId]/coupon-actions"
);
const { CouponRateLimitedError, CouponRejectedError, OrderNotCouponableError } = await import("@/lib/commerce/coupon-order");

function form(code: string): FormData {
  const data = new FormData();
  data.set("code", code);
  return data;
}

const singleBookOrder = { id: ORDER, bundleId: null, items: [{ bookId: BOOK, title: "A Book", hasActiveEntitlement: true }] };

beforeEach(() => {
  getCustomerOrder.mockReset();
  getCustomerOrder.mockResolvedValue(singleBookOrder);
  applyCouponToOrder.mockReset();
  removeCouponFromOrder.mockReset();
  redirect.mockClear();
});

describe("applyCouponAction", () => {
  it("reports success for a partial discount and stays on checkout", async () => {
    applyCouponToOrder.mockResolvedValue({ subtotalMinor: 129000, discountMinor: 25800, totalMinor: 103200, completed: false, entitlementIds: [] });
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("TWENTY"))).resolves.toEqual({ status: "applied" });
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends the reader straight to the reader when the order completed", async () => {
    applyCouponToOrder.mockResolvedValue({ subtotalMinor: 129000, discountMinor: 129000, totalMinor: 0, completed: true, entitlementIds: ["ent-1"] });
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("TESTER-100"))).rejects.toThrow(`REDIRECT:/en/read/${BOOK}`);
  });

  // A fully discounted bundle order has no single book to open, so the reader goes to the library
  // where every book they just got is waiting - not to one arbitrary member of the bundle.
  it("sends the reader to the library when a completed order holds several books", async () => {
    getCustomerOrder.mockResolvedValue({
      id: ORDER,
      bundleId: "33333333-3333-4333-8333-333333333333",
      items: [
        { bookId: BOOK, title: "First", hasActiveEntitlement: true },
        { bookId: "44444444-4444-4444-8444-444444444444", title: "Second", hasActiveEntitlement: true },
      ],
    });
    applyCouponToOrder.mockResolvedValue({ subtotalMinor: 300000, discountMinor: 300000, totalMinor: 0, completed: true, entitlementIds: ["e1", "e2"] });
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("FREEBUNDLE"))).rejects.toThrow("REDIRECT:/en/library");
  });

  it("shows one message for every invalid code", async () => {
    applyCouponToOrder.mockRejectedValue(new CouponRejectedError("expired"));
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("GONE"))).resolves.toEqual({ status: "invalid" });
  });

  it("distinguishes the rate limit", async () => {
    applyCouponToOrder.mockRejectedValue(new CouponRateLimitedError());
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("TWENTY"))).resolves.toEqual({ status: "rateLimited" });
  });

  it("distinguishes an order that cannot take a code", async () => {
    applyCouponToOrder.mockRejectedValue(new OrderNotCouponableError());
    await expect(applyCouponAction("en", ORDER, { status: "idle" }, form("TWENTY"))).resolves.toEqual({ status: "unavailable" });
  });

  it("refuses an unknown locale rather than guessing one", async () => {
    await expect(applyCouponAction("de", ORDER, { status: "idle" }, form("TWENTY"))).rejects.toThrow("REDIRECT:/en");
    expect(applyCouponToOrder).not.toHaveBeenCalled();
  });
});

describe("removeCouponAction", () => {
  it("clears the applied state", async () => {
    removeCouponFromOrder.mockResolvedValue({ subtotalMinor: 129000, discountMinor: 0, totalMinor: 129000 });
    await expect(removeCouponAction("en", ORDER, { status: "applied" }, new FormData())).resolves.toEqual({ status: "idle" });
  });

  it("reports an order that cannot take the change", async () => {
    removeCouponFromOrder.mockRejectedValue(new OrderNotCouponableError());
    await expect(removeCouponAction("en", ORDER, { status: "applied" }, new FormData())).resolves.toEqual({ status: "unavailable" });
  });
});
