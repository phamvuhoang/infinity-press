// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCouponAction, updateCouponAction } from "@/app/admin/coupons/actions";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { CouponValueLockedError, DuplicateCouponCodeError, createCoupon, updateCoupon } from "@/lib/data/coupons";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));
vi.mock("@/lib/data/coupons", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/coupons")>();
  return { ...original, createCoupon: vi.fn(), updateCoupon: vi.fn() };
});

const COUPON_ID = "4a1b2c3d-0000-4000-8000-000000000001";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

// A minimal valid percent coupon, matching couponSchema.
function valid(overrides: Record<string, string> = {}): FormData {
  return form({ code: "TESTER-100", kind: "percent", percentOff: "50", active: "on", maxRedemptionsPerProfile: "1", ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("createCouponAction", () => {
  it("gates on requireAdmin before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(createCouponAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createCoupon).not.toHaveBeenCalled();
  });

  // Case 1: a malformed code returns fieldErrors.code and never calls createCoupon.
  it("rejects a malformed code without calling createCoupon", async () => {
    const result = await createCouponAction(initialAdminFormState, valid({ code: "a" }));
    expect(result.fieldErrors.code).toBeTruthy();
    expect(createCoupon).not.toHaveBeenCalled();
  });

  // Case 2: a percent coupon with no percentage returns fieldErrors.percentOff.
  it("rejects a percent coupon with no percentage", async () => {
    const data = valid();
    data.delete("percentOff");
    const result = await createCouponAction(initialAdminFormState, data);
    expect(result.fieldErrors.percentOff).toBeTruthy();
    expect(createCoupon).not.toHaveBeenCalled();
  });

  it("rejects a fixed coupon with no amount or currency", async () => {
    const result = await createCouponAction(initialAdminFormState, valid({ kind: "fixed" }));
    expect(result.fieldErrors.amountOffMinor).toBeTruthy();
    expect(createCoupon).not.toHaveBeenCalled();
  });

  // Case 3: a valid create redirects to /admin/coupons/<id>.
  it("creates a coupon and redirects to its editor", async () => {
    vi.mocked(createCoupon).mockResolvedValue(COUPON_ID);
    await expect(createCouponAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");
    expect(createCoupon).toHaveBeenCalledWith(expect.objectContaining({ code: "TESTER-100", kind: "percent", percentOff: 50 }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin/coupons");
    expect(redirect).toHaveBeenCalledWith(`/admin/coupons/${COUPON_ID}`);
  });

  // Blank maxRedemptions means unlimited: it must reach the data layer as null, not be coerced to 0.
  it("sends null maxRedemptions for a blank field", async () => {
    vi.mocked(createCoupon).mockResolvedValue(COUPON_ID);
    await expect(createCouponAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");
    expect(createCoupon).toHaveBeenCalledWith(expect.objectContaining({ maxRedemptions: null }));
  });

  // A duplicate code is a named condition, not a generic failure: the operator sees it against the
  // code field and can retype rather than reading "something went wrong".
  it("surfaces a duplicate code against the code field", async () => {
    vi.mocked(createCoupon).mockRejectedValue(new DuplicateCouponCodeError());
    const result = await createCouponAction(initialAdminFormState, valid());
    expect(result).toEqual({ fieldErrors: { code: "That code already exists." }, formError: null, savedAt: null });
  });

  // S9 spec 8: the two scopes are read from two fields. Inferring bundle scope from the selected
  // books would silently widen every book-scoped promotion to the bundles containing those books.
  it("reads book scope and bundle scope as separate fields", async () => {
    vi.mocked(createCoupon).mockResolvedValue(COUPON_ID);
    const data = valid();
    data.append("bookIds", "4a1b2c3d-0000-4000-8000-0000000000b1");
    data.append("bundleIds", "4a1b2c3d-0000-4000-8000-0000000000c1");
    await expect(createCouponAction(initialAdminFormState, data)).rejects.toThrow("NEXT_REDIRECT");
    expect(createCoupon).toHaveBeenCalledWith(
      expect.objectContaining({
        bookIds: ["4a1b2c3d-0000-4000-8000-0000000000b1"],
        bundleIds: ["4a1b2c3d-0000-4000-8000-0000000000c1"],
      }),
    );
  });

  it("sends empty scope arrays when the operator selects nothing, which means global", async () => {
    vi.mocked(createCoupon).mockResolvedValue(COUPON_ID);
    await expect(createCouponAction(initialAdminFormState, valid())).rejects.toThrow("NEXT_REDIRECT");
    expect(createCoupon).toHaveBeenCalledWith(expect.objectContaining({ bookIds: [], bundleIds: [] }));
  });

  it("hides unexpected errors behind a generic failure", async () => {
    vi.mocked(createCoupon).mockRejectedValue(new Error("private database detail"));
    const result = await createCouponAction(initialAdminFormState, valid());
    expect(result).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
  });
});

describe("updateCouponAction", () => {
  it("gates on requireAdmin before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(updateCouponAction(COUPON_ID, initialAdminFormState, valid())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(updateCoupon).not.toHaveBeenCalled();
  });

  it("saves and reports success without redirecting", async () => {
    vi.mocked(updateCoupon).mockResolvedValue(undefined);
    const result = await updateCouponAction(COUPON_ID, initialAdminFormState, valid());
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(updateCoupon).toHaveBeenCalledWith(COUPON_ID, expect.objectContaining({ code: "TESTER-100" }));
    expect(revalidatePath).toHaveBeenCalledWith("/admin/coupons");
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/coupons/${COUPON_ID}`);
  });

  // Case 4: CouponValueLockedError from updateCoupon becomes formError rather than a crash.
  it("turns CouponValueLockedError into a formError the operator can read", async () => {
    vi.mocked(updateCoupon).mockRejectedValue(new CouponValueLockedError());
    const result = await updateCouponAction(COUPON_ID, initialAdminFormState, valid());
    expect(result).toEqual({
      fieldErrors: {},
      formError: "This coupon has already been used, so its value cannot change.",
      savedAt: null,
    });
  });

  it("hides unexpected errors behind a generic failure", async () => {
    vi.mocked(updateCoupon).mockRejectedValue(new Error("private database detail"));
    const result = await updateCouponAction(COUPON_ID, initialAdminFormState, valid());
    expect(result).toEqual({ fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null });
  });
});
