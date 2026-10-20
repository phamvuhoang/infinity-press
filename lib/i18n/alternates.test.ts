import { describe, expect, it } from "vitest";

import { alternatePaths, alternateSlugsSchema } from "@/lib/i18n/alternates";

describe("alternateSlugsSchema", () => {
  it("keeps registered locales and drops codes this build does not know", () => {
    expect(alternateSlugsSchema.parse({ vi: "a", ja: "b", xx: "c" })).toEqual({ vi: "a", ja: "b" });
  });

  it("accepts an empty object", () => {
    expect(alternateSlugsSchema.parse({})).toEqual({});
  });

  it("rejects a non-string slug", () => {
    expect(alternateSlugsSchema.safeParse({ vi: 3 }).success).toBe(false);
  });
});

describe("alternatePaths", () => {
  it("builds each locale's own route from that locale's slug", () => {
    const paths = alternatePaths({ vi: "sach", ja: "hon" }, (locale, slug) => `/${locale}/books/${slug}`);
    expect(paths).toEqual({ vi: "/vi/books/sach", ja: "/ja/books/hon" });
  });

  it("is empty when the page has no translation", () => {
    expect(alternatePaths({}, (locale, slug) => `/${locale}/${slug}`)).toEqual({});
  });
});
