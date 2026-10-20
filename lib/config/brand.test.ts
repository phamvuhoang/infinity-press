import { describe, expect, it } from "vitest";

import { BRAND_NAME } from "@/lib/config/brand";
import { SITE_NAME } from "@/lib/seo/metadata";

describe("brand", () => {
  it("names the platform Infinity Books Press everywhere SITE_NAME is used", () => {
    expect(BRAND_NAME).toBe("Infinity Books Press");
    expect(SITE_NAME).toBe(BRAND_NAME);
  });
});

describe("active copy carries no previous identity", () => {
  const banned = [/Phương Bùi/i, /Phuong Bui/i, /infinitybooks\.vn/i,/Infinity Books(?! Press)/];

  it.each(["vi", "en"])("%s dictionary", async (locale) => {
    const text = JSON.stringify((await import(`@/lib/i18n/dictionaries/${locale}.json`)).default);
    for (const pattern of banned) expect(text).not.toMatch(pattern);
  });
});
