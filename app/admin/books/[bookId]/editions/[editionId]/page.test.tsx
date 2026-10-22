import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminEditionPage from "./page";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminEdition, listPricingDefaults, type AdminEditionDTO } from "@/lib/data/admin-editions";
import { getAdminBook } from "@/lib/data/books";
import { getPublicationVersionHistory } from "@/lib/data/publications";
import { listContentLanguages } from "@/lib/i18n/settings";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/admin-editions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/admin-editions")>()),
  getAdminEdition: vi.fn(),
  listPricingDefaults: vi.fn(),
}));
vi.mock("@/lib/data/books", () => ({ getAdminBook: vi.fn() }));
vi.mock("@/lib/data/publications", () => ({ getPublicationVersionHistory: vi.fn() }));
vi.mock("@/lib/i18n/settings", () => ({ listContentLanguages: vi.fn() }));
vi.mock("../actions", () => ({
  updateEditionAction: vi.fn(),
  createOfferAction: vi.fn(),
  setDefaultEditionAction: vi.fn(),
  setDefaultOfferAction: vi.fn(),
  saveProvenanceAction: vi.fn(),
  setReviewAction: vi.fn(),
}));
vi.mock("@/app/admin/books/[bookId]/editor-actions", () => ({ updateOfferAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/epub/actions", () => ({ createEpubUploadAction: vi.fn(), finalizeEpubUploadAction: vi.fn() }));

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
const editionId = "6a1b2c3d-0000-4000-8000-000000000002";

const edition: AdminEditionDTO = {
  id: editionId,
  bookId,
  languageCode: "ja",
  editionNumber: 1,
  isbn: null,
  publicationDate: null,
  introduction: null,
  contributors: [{ role: "translator", name: "T. Translator" }],
  status: "draft",
  isDefault: false,
  activePublicationId: null,
  sampleFull: false,
  identityLocked: false,
  sku: { id: "sku-id", skuCode: "golden-ja-ebook", active: true },
  editorial: { state: "unreviewed", textSourceNote: null, translationSource: null, rightsNote: null, territoryNote: null, textKind: null, reviewScope: "none", publicVersionNote: null, reviewedAt: null, reviewNote: null },
  offers: [
    { id: "offer-id", marketCode: "JP", currency: "JPY", priceMinor: 500, active: true, isDefault: true, sale: null, effectivePriceMinor: 500, saleState: "none" },
  ],
};

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAdminEdition).mockResolvedValue(edition);
  vi.mocked(getAdminBook).mockResolvedValue({ localization: { title: "Golden" }, canonicalKey: "golden" } as Awaited<ReturnType<typeof getAdminBook>>);
  vi.mocked(listContentLanguages).mockResolvedValue([{ code: "ja", name: "Japanese" }, { code: "en", name: "English" }]);
  vi.mocked(listPricingDefaults).mockResolvedValue([{ marketCode: "JP", currency: "JPY", priceMinor: 500 }]);
  vi.mocked(getPublicationVersionHistory).mockResolvedValue([
    { assetId: "asset-2", version: 2, publicationId: "pub-2", lifecycle: "ready_for_preview" },
    { assetId: "asset-1", version: 1, publicationId: "pub-1", lifecycle: "superseded" },
  ]);
});

const props = { params: Promise.resolve({ bookId, editionId }) };

it("authorizes before reading anything", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
  await expect(AdminEditionPage(props)).rejects.toThrow("Forbidden");
  expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${bookId}/editions/${editionId}` });
  for (const read of [getAdminEdition, getAdminBook, listContentLanguages, listPricingDefaults, getPublicationVersionHistory]) {
    expect(read).not.toHaveBeenCalled();
  }
});

it("names the edition by its language and offers its own forms", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  render(await AdminEditionPage(props));

  expect(screen.getByRole("heading", { level: 1, name: /Japanese edition/ })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Back to Golden" })).toHaveAttribute("href", `/admin/books/${bookId}`);
  for (const label of ["Edition language", "ISBN", "Credits", "Translation introduction", "EPUB file"]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
  expect(screen.getByDisplayValue("translator: T. Translator")).toBeInTheDocument();
  for (const name of ["Save edition", "Save offer", "Add offer", "Upload EPUB"]) {
    expect(screen.getByRole("button", { name })).toBeInTheDocument();
  }
});

it("lets the admin make a published non-default edition the default for its language", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(getAdminEdition).mockResolvedValue({ ...edition, status: "published" });
  render(await AdminEditionPage(props));
  expect(screen.getByRole("button", { name: "Make default Japanese edition" })).toBeInTheDocument();
});

// A draft or archived default would hide the work from its language; admin_set_default_edition
// refuses it, and the page does not offer it.
it("offers no default button for an unpublished edition", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  render(await AdminEditionPage(props));
  expect(screen.queryByRole("button", { name: "Make default Japanese edition" })).not.toBeInTheDocument();
  expect(screen.getByText("Only a published edition can be the default Japanese edition.")).toBeInTheDocument();
});

it("shows a default edition as such, with no button to make it so", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(getAdminEdition).mockResolvedValue({ ...edition, isDefault: true });
  render(await AdminEditionPage(props));
  expect(screen.getByText("This is the default Japanese edition.")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Make default Japanese edition" })).not.toBeInTheDocument();
});

it("links each EPUB version to its own publication page, so this edition's versions never mix with another's", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  render(await AdminEditionPage(props));
  expect(getPublicationVersionHistory).toHaveBeenCalledWith(editionId);
  expect(screen.getByRole("link", { name: "Version 2 · Ready for preview" })).toHaveAttribute("href", "/admin/publications/asset-2");
  expect(screen.getByRole("link", { name: "Version 1 · Superseded" })).toHaveAttribute("href", "/admin/publications/asset-1");
});

it("prefills a new offer from the pricing template but offers the default offer button only for non-default offers", async () => {
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(getAdminEdition).mockResolvedValue({
    ...edition,
    offers: [...edition.offers, { id: "offer-2", marketCode: "US", currency: "USD", priceMinor: 500, active: true, isDefault: false, sale: null, effectivePriceMinor: 500, saleState: "none" }],
  });
  render(await AdminEditionPage(props));
  expect(document.querySelector<HTMLInputElement>("#new-offer-currency")?.value).toBe("JPY");
  expect(document.querySelector<HTMLInputElement>("#new-offer-priceMinor")?.value).toBe("500");
  expect(screen.getAllByRole("button", { name: "Make default offer" })).toHaveLength(1);
});

it("shows the editorial status and the provenance form, so an edition cannot be published unseen", async () => {
  vi.mocked(getAdminEdition).mockResolvedValue({
    ...edition,
    editorial: { ...edition.editorial, state: "approved", translationSource: "Translated 1925", reviewedAt: "2026-10-01T00:00:00Z" },
  });
  render(await AdminEditionPage({ params: Promise.resolve({ bookId, editionId }) }));
  expect(screen.getByTestId("editorial-state")).toHaveTextContent("Approved");
  expect(screen.getByLabelText("Source of the translation")).toHaveValue("Translated 1925");
  expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Block" })).toBeInTheDocument();
});
