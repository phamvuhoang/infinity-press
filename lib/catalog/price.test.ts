import { describe, expect, it } from "vitest";

import { formatPrice, priceInMajorUnits } from "@/lib/catalog/price";

// Intl uses non-breaking spaces. Compare with plain spaces.
const plain = (value: string) => value.replace(/\s/gu, " ");

describe("formatPrice", () => {
  it("formats VND, which has no minor digits", () => {
    expect(plain(formatPrice(129000, "VND", "vi"))).toBe("129.000 ₫");
  });

  it("formats USD minor units as cents", () => {
    expect(formatPrice(1299, "USD", "en")).toBe("$12.99");
  });
});

describe("priceInMajorUnits", () => {
  it("keeps VND whole and converts USD cents", () => {
    expect(priceInMajorUnits(129000, "VND")).toBe(129000);
    expect(priceInMajorUnits(1299, "USD")).toBe(12.99);
    expect(priceInMajorUnits(0, "USD")).toBe(0);
  });
});
