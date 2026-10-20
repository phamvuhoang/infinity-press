import { describe, expect, it } from "vitest";

import { retailLinksSchema, retailerLabel, withRetailUtm } from "@/lib/catalog/retail";

describe("withRetailUtm", () => {
  it("appends the four utm parameters", () => {
    expect(withRetailUtm("https://shopee.vn/x?y=1", "vi")).toBe(
      "https://shopee.vn/x?y=1&utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
    );
  });
  it("leaves a url that already carries any utm parameter untouched", () => {
    const affiliate = "https://shopee.vn/x?utm_source=aff&aff_id=9";
    expect(withRetailUtm(affiliate, "en")).toBe(affiliate);
  });
  it("keeps a fragment after the query string", () => {
    expect(withRetailUtm("https://tiki.vn/x#reviews", "en")).toBe(
      "https://tiki.vn/x?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=en#reviews",
    );
  });
  it("passes a non-https url through unchanged (the read boundary rejects it) rather than throwing", () => {
    expect(withRetailUtm("not a url", "vi")).toBe("not a url");
  });
});

describe("retailLinksSchema", () => {
  const base = { retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: true };
  it("accepts a plain link", () => {
    expect(retailLinksSchema.safeParse({ links: [base] }).success).toBe(true);
  });
  it("requires a label only for other", () => {
    expect(retailLinksSchema.safeParse({ links: [{ ...base, retailer: "other" }] }).success).toBe(false);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, retailer: "other", label: "ABC" }] }).success).toBe(true);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, label: "ABC" }] }).success).toBe(false);
  });
  it("rejects http and price without currency", () => {
    expect(retailLinksSchema.safeParse({ links: [{ ...base, url: "http://shopee.vn/x" }] }).success).toBe(false);
    expect(retailLinksSchema.safeParse({ links: [{ ...base, priceMinor: 1000 }] }).success).toBe(false);
  });
  it("caps at 10 links", () => {
    expect(retailLinksSchema.safeParse({ links: Array.from({ length: 11 }, () => base) }).success).toBe(false);
  });
});

describe("retailerLabel", () => {
  const labels = { shopee: "Shopee", fahasa: "Fahasa", tiki: "Tiki" };
  it("uses the dictionary for named retailers and the stored label for other", () => {
    expect(retailerLabel({ retailer: "tiki", label: null }, labels)).toBe("Tiki");
    expect(retailerLabel({ retailer: "other", label: "Nhà sách ABC" }, labels)).toBe("Nhà sách ABC");
  });
});
