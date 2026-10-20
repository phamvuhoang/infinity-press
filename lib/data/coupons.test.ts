// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc }) }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));

const { createCoupon, updateCoupon, getAdminCoupon, listAdminCoupons, CouponValueLockedError, DuplicateCouponCodeError } =
  await import("@/lib/data/coupons");

const ROW = {
  id: "c1", code: "TWENTY", kind: "percent", percent_off: 20, amount_off_minor: null, currency: null,
  starts_at: null, ends_at: null, active: true, max_redemptions: null, max_redemptions_per_profile: 1,
  note: null, created_at: "2026-09-21T00:00:00Z", reserved_count: 2, redeemed_count: 1, book_ids: ["b1"],
  bundle_ids: ["u1"],
};

const INPUT = {
  code: "TESTER-100", kind: "percent" as const, percentOff: 100, amountOffMinor: null, currency: null,
  startsAt: null, endsAt: null, active: true, maxRedemptions: 20, maxRedemptionsPerProfile: 1,
  note: "launch testers", bookIds: ["b1"], bundleIds: ["u1"],
};

beforeEach(() => rpc.mockReset());

describe("listAdminCoupons", () => {
  it("maps the RPC row to the DTO, counts included", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await expect(listAdminCoupons()).resolves.toEqual([
      {
        id: "c1", code: "TWENTY", kind: "percent", percentOff: 20, amountOffMinor: null, currency: null,
        startsAt: null, endsAt: null, active: true, maxRedemptions: null, maxRedemptionsPerProfile: 1,
        note: null, createdAt: "2026-09-21T00:00:00Z", reservedCount: 2, redeemedCount: 1, bookIds: ["b1"], bundleIds: ["u1"],
      },
    ]);
  });

  it("fails loudly rather than pretending there are no coupons", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    await expect(listAdminCoupons()).rejects.toThrow(/listAdminCoupons/);
  });
});

describe("getAdminCoupon", () => {
  it("returns null for an id the RPC has no row for", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(getAdminCoupon("c1")).resolves.toBeNull();
  });

  it("maps the single returned row to the DTO", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });
    await expect(getAdminCoupon("c1")).resolves.toMatchObject({ id: "c1", code: "TWENTY" });
    expect(rpc).toHaveBeenCalledWith("admin_get_coupon", { p_id: "c1" });
  });
});

describe("createCoupon", () => {
  it("passes the editor's fields through to the RPC", async () => {
    rpc.mockResolvedValue({ data: "new-id", error: null });
    await createCoupon(INPUT);
    expect(rpc).toHaveBeenCalledWith(
      "admin_create_coupon",
      expect.objectContaining({ p_code: "TESTER-100", p_percent_off: 100, p_max_redemptions: 20 }),
    );
  });

  // S9 spec 8: the two scopes travel as two arrays. A create that dropped p_bundle_ids would land
  // on the old eleven-argument overload's shape and silently store no bundle scope at all.
  it("sends book scope and bundle scope as separate arrays", async () => {
    rpc.mockResolvedValue({ data: "new-id", error: null });
    await createCoupon(INPUT);
    expect(rpc).toHaveBeenCalledWith("admin_create_coupon", expect.objectContaining({ p_book_ids: ["b1"], p_bundle_ids: ["u1"] }));
  });

  it("returns the new coupon id", async () => {
    rpc.mockResolvedValue({ data: "new-id", error: null });
    await expect(createCoupon(INPUT)).resolves.toBe("new-id");
  });

  // The unique index on coupons.code surfaces as Postgres error code 23505. supabase-js exposes
  // that code on the error object rather than only in its message, so this matches on `error.code`
  // (as lib/data/books.ts and lib/data/catalog-entities.ts already do) instead of the fragile
  // substring match the brief sketched - a message that happened not to mention "23505" would have
  // fallen through to the generic failure.
  it("raises a named error for a duplicate code, rather than a generic failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "coupons_code_key"' } });
    await expect(createCoupon(INPUT)).rejects.toBeInstanceOf(DuplicateCouponCodeError);
  });

  it("wraps any other RPC failure in a generic error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "bad kind" } });
    await expect(createCoupon(INPUT)).rejects.toThrow(/createCoupon/);
  });
});

describe("updateCoupon", () => {
  it("passes the editor's fields, including active, through to the RPC", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await updateCoupon("c1", INPUT);
    expect(rpc).toHaveBeenCalledWith(
      "admin_update_coupon",
      expect.objectContaining({ p_id: "c1", p_active: true, p_percent_off: 100 }),
    );
  });

  it("sends both scopes on an update too", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await updateCoupon("c1", INPUT);
    expect(rpc).toHaveBeenCalledWith("admin_update_coupon", expect.objectContaining({ p_book_ids: ["b1"], p_bundle_ids: ["u1"] }));
  });

  // EB025 is a named condition (S8 spec 7.2): a coupon that already has a reservation or a
  // redemption cannot have its kind or value changed. The operator needs to see why the value did
  // not change, not a generic failure.
  it("raises CouponValueLockedError for EB025 rather than a generic failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB025", message: "coupon c1 is already reserved or redeemed" } });
    await expect(updateCoupon("c1", INPUT)).rejects.toBeInstanceOf(CouponValueLockedError);
  });

  it("wraps any other RPC failure in a generic error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "not found" } });
    await expect(updateCoupon("c1", INPUT)).rejects.toThrow(/updateCoupon/);
  });
});
