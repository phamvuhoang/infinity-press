import { describe, expect, it } from "vitest";
import { plainText, reviewInputSchema } from "@/lib/reviews/schema";

describe("reviewInputSchema", () => {
  it("accepts a rating string from a radio group and a trimmed body", () => {
    expect(reviewInputSchema.parse({ rating: "4", body: "  Hay  " })).toEqual({ rating: 4, body: "Hay" });
  });
  it("rejects out-of-range ratings, empty, over-long, and html bodies", () => {
    expect(reviewInputSchema.safeParse({ rating: "0", body: "x" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "   " }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "a".repeat(1001) }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "<b>x</b>" }).success).toBe(false);
    expect(reviewInputSchema.safeParse({ rating: "5", body: "3 < 5 and 5 > 3" }).success).toBe(true);
  });
});

describe("plainText", () => {
  it("allows an empty value when min is 0 (optional reply)", () => {
    expect(plainText(0, 1000, "a reply").safeParse("   ").success).toBe(true);
  });
});
