import { describe, expect, it } from "vitest";

import { computeDiscountMinor, isCouponCode, normalizeCouponCode } from "@/lib/commerce/coupon";

describe("normalizeCouponCode", () => {
  it("upper-cases, trims, and drops the spaces a reader types or pastes", () => {
    expect(normalizeCouponCode("  tester-100 ")).toBe("TESTER-100");
    expect(normalizeCouponCode("te st\ter")).toBe("TESTER");
  });

  it("accepts the codes an operator can create and refuses everything else", () => {
    expect(isCouponCode("TESTER-100")).toBe(true);
    expect(isCouponCode("AB")).toBe(false);
    expect(isCouponCode("A".repeat(33))).toBe(false);
    expect(isCouponCode("TÊT")).toBe(false);
    expect(isCouponCode("DROP TABLE")).toBe(false);
  });
});

describe("computeDiscountMinor", () => {
  it("rounds a percentage down, so rounding never favours the discount", () => {
    // 20% of 129_001 is 25_800.2
    expect(computeDiscountMinor({ kind: "percent", percentOff: 20 }, { subtotalMinor: 129_001, currency: "VND" })).toBe(25_800);
  });

  it("takes the whole subtotal at 100%", () => {
    expect(computeDiscountMinor({ kind: "percent", percentOff: 100 }, { subtotalMinor: 129_000, currency: "VND" })).toBe(129_000);
  });

  it("never discounts more than the subtotal", () => {
    expect(
      computeDiscountMinor({ kind: "fixed", amountOffMinor: 500_000, currency: "VND" }, { subtotalMinor: 129_000, currency: "VND" }),
    ).toBe(129_000);
  });

  it("subtracts a fixed amount in the same currency", () => {
    expect(
      computeDiscountMinor({ kind: "fixed", amountOffMinor: 29_000, currency: "VND" }, { subtotalMinor: 129_000, currency: "VND" }),
    ).toBe(29_000);
  });

  it("refuses a fixed coupon in another currency rather than converting it", () => {
    expect(() =>
      computeDiscountMinor({ kind: "fixed", amountOffMinor: 500, currency: "USD" }, { subtotalMinor: 129_000, currency: "VND" }),
    ).toThrow(/currency/i);
  });

  it("yields nothing on a zero subtotal", () => {
    expect(computeDiscountMinor({ kind: "percent", percentOff: 50 }, { subtotalMinor: 0, currency: "VND" })).toBe(0);
  });

  // Press prices editions in VND, JPY and USD. The arithmetic is on minor units whatever they mean,
  // so a coupon is checked in each currency's own terms.
  it.each([
    ["JPY", 500, 33, 165],
    ["USD", 500, 33, 165],
    ["VND", 50000, 33, 16500],
    ["VND", 1, 99, 0],
  ])("takes %s %i at %i%% down to %i, floored", (currency, subtotalMinor, percentOff, expected) => {
    expect(computeDiscountMinor({ kind: "percent", percentOff }, { subtotalMinor, currency })).toBe(expected);
  });

  it("never lets a fixed JPY amount exceed the price, and leaves the rest payable", () => {
    const rule = { kind: "fixed", amountOffMinor: 700, currency: "JPY" } as const;
    expect(computeDiscountMinor(rule, { subtotalMinor: 500, currency: "JPY" })).toBe(500);
    expect(computeDiscountMinor({ ...rule, amountOffMinor: 200 }, { subtotalMinor: 500, currency: "JPY" })).toBe(200);
  });

  it("refuses a USD fixed coupon on a JPY or VND order instead of reading cents as yen or dong", () => {
    const rule = { kind: "fixed", amountOffMinor: 500, currency: "USD" } as const;
    expect(() => computeDiscountMinor(rule, { subtotalMinor: 50000, currency: "VND" })).toThrow();
    expect(() => computeDiscountMinor(rule, { subtotalMinor: 500, currency: "JPY" })).toThrow();
  });
});
