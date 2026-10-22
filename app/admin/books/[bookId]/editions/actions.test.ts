// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEditionAction,
  createOfferAction,
  saveProvenanceAction,
  setDefaultEditionAction,
  setDefaultOfferAction,
  setReviewAction,
  updateEditionAction,
} from "@/app/admin/books/[bookId]/editions/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import {
  createEdition,
  createOffer,
  DuplicateEditionError,
  EditionIdentityLockedError,
  ProvenanceIncompleteError,
  saveEditionProvenance,
  setDefaultEdition,
  setDefaultOffer,
  setEditionReview,
  updateEdition,
} from "@/lib/data/admin-editions";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  },
}));
vi.mock("@/lib/data/admin-editions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/admin-editions")>()),
  createEdition: vi.fn(),
  updateEdition: vi.fn(),
  createOffer: vi.fn(),
  setDefaultEdition: vi.fn(),
  setDefaultOffer: vi.fn(),
  saveEditionProvenance: vi.fn(),
  setEditionReview: vi.fn(),
}));

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const editionId = "6a1b2c3d-0000-4000-8000-000000000001";
const offerId = "8a1b2c3d-0000-4000-8000-000000000001";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("every edition action denies before touching anything", () => {
  it.each([
    ["createEditionAction", () => createEditionAction(bookId, initialAdminFormState, form({ languageCode: "ja" }))],
    ["updateEditionAction", () => updateEditionAction(bookId, editionId, initialAdminFormState, form({ languageCode: "ja", editionNumber: "1" }))],
    ["createOfferAction", () => createOfferAction(bookId, editionId, initialAdminFormState, form({ marketCode: "JP", currency: "JPY", priceMinor: "500" }))],
    ["setDefaultEditionAction", () => setDefaultEditionAction(bookId, editionId, "ja", initialAdminFormState, form({}))],
    ["saveProvenanceAction", () => saveProvenanceAction(bookId, editionId, initialAdminFormState, form({}))],
    ["setReviewAction", () => setReviewAction(bookId, editionId, initialAdminFormState, form({ state: "approved" }))],
    ["setDefaultOfferAction", () => setDefaultOfferAction(bookId, editionId, offerId, initialAdminFormState, form({}))],
  ])("%s", async (_name, call) => {
    const denied = new Error("NEXT_FORBIDDEN");
    vi.mocked(requireAdmin).mockRejectedValue(denied);
    await expect(call()).rejects.toBe(denied);
    for (const mutation of [createEdition, updateEdition, createOffer, setDefaultEdition, setDefaultOffer]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });
});

describe("createEditionAction", () => {
  it("creates the edition and opens its page", async () => {
    vi.mocked(createEdition).mockResolvedValue({ editionId });
    await expect(
      createEditionAction(bookId, initialAdminFormState, form({ languageCode: "ja", editionNumber: "" })),
    ).rejects.toThrow(`NEXT_REDIRECT /admin/books/${bookId}/editions/${editionId}`);
    expect(createEdition).toHaveBeenCalledWith(bookId, { languageCode: "ja", editionNumber: null });
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}`);
  });

  it("reports a duplicate on the number field", async () => {
    vi.mocked(createEdition).mockRejectedValue(new DuplicateEditionError());
    const result = await createEditionAction(bookId, initialAdminFormState, form({ languageCode: "ja", editionNumber: "1" }));
    expect(result.fieldErrors.editionNumber).toMatch(/already has an edition/);
  });

  it("rejects a malformed language", async () => {
    const result = await createEditionAction(bookId, initialAdminFormState, form({ languageCode: "Japanese!" }));
    expect(result.fieldErrors.languageCode).toBeDefined();
    expect(createEdition).not.toHaveBeenCalled();
  });
});

describe("updateEditionAction", () => {
  it("parses credits one per line and saves", async () => {
    const result = await updateEditionAction(
      bookId,
      editionId,
      initialAdminFormState,
      form({
        languageCode: "ja",
        isbn: "",
        editionNumber: "2",
        publicationDate: "2026-01-01",
        introduction: "A new translation.",
        contributors: "translator: T. Translator\neditor: E. Editor",
      }),
    );
    expect(result.savedAt).not.toBeNull();
    expect(updateEdition).toHaveBeenCalledWith(editionId, {
      languageCode: "ja",
      isbn: null,
      editionNumber: 2,
      publicationDate: "2026-01-01",
      introduction: "A new translation.",
      contributors: [
        { role: "translator", name: "T. Translator" },
        { role: "editor", name: "E. Editor" },
      ],
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}/editions/${editionId}`);
  });

  it("explains a locked identity on the language field", async () => {
    vi.mocked(updateEdition).mockRejectedValue(new EditionIdentityLockedError());
    const result = await updateEditionAction(bookId, editionId, initialAdminFormState, form({ languageCode: "fr", editionNumber: "1" }));
    expect(result.fieldErrors.languageCode).toMatch(/orders or readers/);
  });
});

describe("createOfferAction", () => {
  it("creates an offer from the entered price", async () => {
    vi.mocked(createOffer).mockResolvedValue({ offerId });
    const result = await createOfferAction(bookId, editionId, initialAdminFormState, form({ marketCode: "JP", currency: "JPY", priceMinor: "500" }));
    expect(result.savedAt).not.toBeNull();
    expect(createOffer).toHaveBeenCalledWith(editionId, { marketCode: "JP", currency: "JPY", priceMinor: 500 });
  });

  it("never turns a blank price into a free offer", async () => {
    const result = await createOfferAction(bookId, editionId, initialAdminFormState, form({ marketCode: "JP", currency: "JPY", priceMinor: "" }));
    expect(result.fieldErrors.priceMinor).toBeDefined();
    expect(createOffer).not.toHaveBeenCalled();
  });
});

describe("defaults", () => {
  it("names the default edition for the language", async () => {
    const result = await setDefaultEditionAction(bookId, editionId, "ja", initialAdminFormState, form({}));
    expect(result.savedAt).not.toBeNull();
    expect(setDefaultEdition).toHaveBeenCalledWith(bookId, "ja", editionId);
  });

  it("names the default offer", async () => {
    const result = await setDefaultOfferAction(bookId, editionId, offerId, initialAdminFormState, form({}));
    expect(result.savedAt).not.toBeNull();
    expect(setDefaultOffer).toHaveBeenCalledWith(editionId, offerId);
  });
});

describe("editorial actions", () => {
  it("saves provenance, treating blank notes as none and a missing review scope as none", async () => {
    const state = await saveProvenanceAction(bookId, editionId, initialAdminFormState, form({ translationSource: " Translated 1925 ", rightsNote: "", textSourceNote: "", territoryNote: "Worldwide", textKind: "commentary" }));
    expect(saveEditionProvenance).toHaveBeenCalledWith(editionId, {
      textSourceNote: null,
      translationSource: "Translated 1925",
      rightsNote: null,
      territoryNote: "Worldwide",
      textKind: "commentary",
      reviewScope: "none",
    });
    expect(state.savedAt).not.toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/books/${bookId}/editions/${editionId}`);
  });

  it("records the decision", async () => {
    const state = await setReviewAction(bookId, editionId, initialAdminFormState, form({ state: "approved", note: "Checked." }));
    expect(setEditionReview).toHaveBeenCalledWith(editionId, { state: "approved", note: "Checked." });
    expect(state.savedAt).not.toBeNull();
  });

  it("refuses a block with no reason without asking the database", async () => {
    const state = await setReviewAction(bookId, editionId, initialAdminFormState, form({ state: "blocked", note: "  " }));
    expect(state.fieldErrors.note).toBeTruthy();
    expect(setEditionReview).not.toHaveBeenCalled();
  });

  it("refuses an unknown state", async () => {
    const state = await setReviewAction(bookId, editionId, initialAdminFormState, form({ state: "maybe" }));
    expect(state.savedAt).toBeNull();
    expect(setEditionReview).not.toHaveBeenCalled();
  });

  it("explains why approval was refused", async () => {
    vi.mocked(setEditionReview).mockRejectedValue(new ProvenanceIncompleteError());
    const state = await setReviewAction(bookId, editionId, initialAdminFormState, form({ state: "approved" }));
    expect(state.formError).toContain("translation source");
  });
});
