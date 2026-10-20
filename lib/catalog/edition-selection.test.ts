import { describe, expect, it } from "vitest";

import type { CatalogEditionOption } from "@/lib/catalog/public-types";
import { editionPublicAction, selectEdition } from "@/lib/catalog/edition-selection";

function edition(overrides: Partial<CatalogEditionOption> & { editionId: string }): CatalogEditionOption {
  return {
    languageCode: "en",
    epubLanguage: "en",
    isDefault: false,
    offer: { offerId: "offer-1", priceMinor: 500, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasSample: false,
    ...overrides,
  };
}

const english = edition({ editionId: "e-en", isDefault: true });
const japanese = edition({ editionId: "e-ja", languageCode: "ja", offer: null });

describe("selectEdition", () => {
  it("is the default edition when no edition is asked for", () => {
    expect(selectEdition([japanese, english], null)).toEqual({ status: "selected", edition: english });
  });

  it("is the asked-for edition when it is one of the work's readable editions", () => {
    expect(selectEdition([english, japanese], "e-ja")).toEqual({ status: "selected", edition: japanese });
  });

  // The invalid id must not fall through to the default: that is how a reader buys a product they
  // never chose.
  it("is invalid for an edition that is not on the list, never the default", () => {
    expect(selectEdition([english, japanese], "e-unknown")).toEqual({ status: "invalid" });
  });

  it("has nothing to select when the work lists no edition", () => {
    expect(selectEdition([], null)).toEqual({ status: "none" });
  });

  it("treats an empty value as no request", () => {
    expect(selectEdition([english], "")).toEqual({ status: "selected", edition: english });
  });
});

describe("editionPublicAction", () => {
  it("is buy for a priced edition while payments are on", () => {
    expect(editionPublicAction(english, true)).toBe("buy");
  });

  it("is coming soon for a priced edition while payments are off", () => {
    expect(editionPublicAction(english, false)).toBe("coming_soon");
  });

  it("is get free for a zero price", () => {
    const free = edition({ editionId: "e-free", offer: { offerId: "o", priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null } });
    expect(editionPublicAction(free, true)).toBe("get_free");
  });

  it("is unavailable, not another edition's price, for an edition with no offer", () => {
    expect(editionPublicAction(japanese, true)).toBe("unavailable");
  });
});
