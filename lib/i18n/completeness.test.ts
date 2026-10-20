import { describe, expect, it } from "vitest";

import { missingLocales } from "@/lib/i18n/completeness";

describe("missingLocales", () => {
  it("names every registered locale that has no localization", () => {
    expect(missingLocales(["en"])).toEqual(["vi", "ja"]);
  });

  it("is empty when every locale is covered", () => {
    expect(missingLocales(["ja", "vi", "en"])).toEqual([]);
  });

  it("ignores codes the registry does not know", () => {
    expect(missingLocales(["en", "xx"])).toEqual(["vi", "ja"]);
  });
});
