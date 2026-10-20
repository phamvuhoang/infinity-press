// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import {
  createEdition,
  createOffer,
  DuplicateEditionError,
  EditionIdentityLockedError,
  getAdminEdition,
  listPricingDefaults,
  setDefaultEdition,
  ProvenanceIncompleteError,
  saveEditionProvenance,
  setDefaultOffer,
  setEditionReview,
  UnknownLanguageError,
  updateEdition,
} from "@/lib/data/admin-editions";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const editionId = "6a1b2c3d-0000-4000-8000-000000000001";
const offerId = "8a1b2c3d-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("admin gate ordering", () => {
  it.each([
    ["getAdminEdition", () => getAdminEdition(bookId, editionId)],
    ["createEdition", () => createEdition(bookId, { languageCode: "ja", editionNumber: null })],
    ["updateEdition", () => updateEdition(editionId, { languageCode: "ja", isbn: null, editionNumber: 1, publicationDate: null, introduction: null, contributors: [] })],
    ["createOffer", () => createOffer(editionId, { marketCode: "JP", currency: "JPY", priceMinor: 500 })],
    ["setDefaultEdition", () => setDefaultEdition(bookId, "ja", editionId)],
    ["setDefaultOffer", () => setDefaultOffer(editionId, offerId)],
    ["listPricingDefaults", () => listPricingDefaults("ja")],
    ["saveEditionProvenance", () => saveEditionProvenance(editionId, { textSourceNote: null, translationSource: null, rightsNote: null, territoryNote: null })],
    ["setEditionReview", () => setEditionReview(editionId, { state: "approved", note: null })],
  ])("%s never builds a client when the admin gate denies", async (_name, call) => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(call()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("createEdition", () => {
  it("calls admin_create_edition and returns the new edition id", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: editionId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createEdition(bookId, { languageCode: "ja", editionNumber: null })).resolves.toEqual({ editionId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_edition", {
      p_book_id: bookId,
      p_language_code: "ja",
      p_edition_number: null,
      p_isbn: null,
      p_publication_date: null,
    });
  });

  it("maps a repeated book, language and number to DuplicateEditionError", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "23505", message: "editions_book_id_language_code_edition_number_key" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(createEdition(bookId, { languageCode: "ja", editionNumber: 1 })).rejects.toBeInstanceOf(DuplicateEditionError);
  });

  it("maps an unregistered language to UnknownLanguageError", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "23503", message: "editions_language_code_fkey" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(createEdition(bookId, { languageCode: "xx", editionNumber: null })).rejects.toBeInstanceOf(UnknownLanguageError);
  });
});

describe("updateEdition", () => {
  const input = {
    languageCode: "ja",
    isbn: "9780000000002",
    editionNumber: 2,
    publicationDate: "2026-01-01",
    introduction: "A new translation.",
    contributors: [{ role: "translator", name: "T. Translator" }],
  };

  it("saves everything through admin_save_edition", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await updateEdition(editionId, input);

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_edition", {
      p_edition_id: editionId,
      p_isbn: "9780000000002",
      p_edition_number: 2,
      p_publication_date: "2026-01-01",
      p_introduction: "A new translation.",
      p_contributors: [{ role: "translator", name: "T. Translator" }],
      p_language_code: "ja",
    });
  });

  it("explains a refused identity change once the edition has been sold", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "23514", message: "edition has orders or entitlements" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(updateEdition(editionId, input)).rejects.toBeInstanceOf(EditionIdentityLockedError);
  });

  it("rejects a malformed edition id before calling the database", async () => {
    await expect(updateEdition("nope", input)).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});

describe("offers", () => {
  it("creates an offer with the price exactly as entered", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: offerId, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(createOffer(editionId, { marketCode: "JP", currency: "JPY", priceMinor: 500 })).resolves.toEqual({ offerId });
    expect(fake.rpc).toHaveBeenCalledWith("admin_create_offer", {
      p_edition_id: editionId,
      p_market_code: "JP",
      p_currency: "JPY",
      p_price_minor: 500,
    });
  });

  it("names the default offer explicitly", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await setDefaultOffer(editionId, offerId);
    expect(fake.rpc).toHaveBeenCalledWith("admin_set_default_offer", { p_edition_id: editionId, p_offer_id: offerId });
  });
});

describe("setDefaultEdition", () => {
  it("names the default edition for a work and language", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await setDefaultEdition(bookId, "ja", editionId);
    expect(fake.rpc).toHaveBeenCalledWith("admin_set_default_edition", {
      p_book_id: bookId,
      p_language_code: "ja",
      p_edition_id: editionId,
    });
  });
});

describe("getAdminEdition", () => {
  const row = {
    id: editionId,
    book_id: bookId,
    language_code: "ja",
    edition_number: 1,
    isbn: null,
    publication_date: null,
    introduction: null,
    contributors: [{ role: "translator", name: "T. Translator" }],
    status: "draft",
    active_publication_id: null,
    skus: [
      {
        id: "7a1b2c3d-0000-4000-8000-000000000001",
        sku_code: "book-ja-ebook",
        active: true,
        offers: [
          { id: offerId, market_code: "JP", currency: "JPY", price_minor: 500, active: true, starts_at: null, ends_at: null, sale_kind: null, sale_percent_off: null, sale_amount_off_minor: null, sale_starts_at: null, sale_ends_at: null, offer_effective_price_minor: 500 },
        ],
      },
    ],
    default_offer: { offer_id: offerId },
    text_source_note: "1912 edition",
    translation_source: "Translated 1925",
    rights_note: null,
    territory_note: null,
    editorial_state: "unreviewed",
    reviewed_at: null,
    review_note: null,
  };

  it("builds the edition DTO with its offers and default flags", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        editions: { data: row, error: null },
        book_language_editions: { data: { edition_id: editionId }, error: null },
        entitlements: { data: null, error: null },
        order_items: { data: null, error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const edition = await getAdminEdition(bookId, editionId);

    expect(edition).toMatchObject({ id: editionId, bookId, languageCode: "ja", status: "draft", isDefault: true, identityLocked: false });
    expect(edition.offers).toEqual([
      { id: offerId, marketCode: "JP", currency: "JPY", priceMinor: 500, active: true, isDefault: true, sale: null, effectivePriceMinor: 500, saleState: "none" },
    ]);
    expect(edition.sku).toEqual({ id: "7a1b2c3d-0000-4000-8000-000000000001", skuCode: "book-ja-ebook", active: true });
    expect(edition.editorial).toEqual({
      state: "unreviewed",
      textSourceNote: "1912 edition",
      translationSource: "Translated 1925",
      rightsNote: null,
      territoryNote: null,
      reviewedAt: null,
      reviewNote: null,
    });
  });

  it("is not found when the edition belongs to a different book", async () => {
    const fake = fakeSupabaseClient({ tables: { editions: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(getAdminEdition(bookId, editionId)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("listPricingDefaults", () => {
  it("returns the admin's templates for a language, for prefilling a new offer only", async () => {
    const fake = fakeSupabaseClient({
      tables: { edition_pricing_defaults: { data: [{ language_code: "ja", market_code: "JP", currency: "JPY", price_minor: 500 }], error: null } },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(listPricingDefaults("ja")).resolves.toEqual([{ marketCode: "JP", currency: "JPY", priceMinor: 500 }]);
  });
});

describe("editorial review", () => {
  it("saves the provenance notes exactly as entered", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await saveEditionProvenance(editionId, {
      textSourceNote: "1912 edition",
      translationSource: "Translated 1925",
      rightsNote: "Public domain",
      territoryNote: "Worldwide",
    });

    expect(fake.rpc).toHaveBeenCalledWith("admin_save_edition_provenance", {
      p_edition_id: editionId,
      p_text_source_note: "1912 edition",
      p_translation_source: "Translated 1925",
      p_rights_note: "Public domain",
      p_territory_note: "Worldwide",
    });
  });

  it("records a decision with the reviewer's note", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await setEditionReview(editionId, { state: "blocked", note: "Rights unclear." });

    expect(fake.rpc).toHaveBeenCalledWith("admin_set_edition_review", {
      p_edition_id: editionId,
      p_state: "blocked",
      p_note: "Rights unclear.",
    });
  });

  it("says what is missing when approval is refused for want of evidence", async () => {
    const fake = fakeSupabaseClient({ rpc: { data: null, error: { code: "EB044", message: "record the translation source" } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(setEditionReview(editionId, { state: "approved", note: null })).rejects.toBeInstanceOf(ProvenanceIncompleteError);
  });

  it("rejects a malformed edition id before calling the database", async () => {
    await expect(setEditionReview("nope", { state: "approved", note: null })).rejects.toThrow();
    expect(createClient).not.toHaveBeenCalled();
  });
});
