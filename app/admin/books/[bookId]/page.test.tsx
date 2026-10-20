import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminBookPage from "./page";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminBook, listAdminBooks, type AdminBookDTO } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";
import { listContentLanguages } from "@/lib/i18n/settings";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ getAdminBook: vi.fn(), listAdminBooks: vi.fn() }));
vi.mock("@/lib/data/catalog-entities", () => ({ listCatalogEntityOptions: vi.fn() }));
vi.mock("@/lib/i18n/settings", () => ({ listContentLanguages: vi.fn() }));
vi.mock("./editor-actions", () => ({ updateBookDetailsAction: vi.fn(), saveBookLocalizationAction: vi.fn(), setBookRelationsAction: vi.fn(), setRelatedBooksAction: vi.fn(), saveRetailLinksAction: vi.fn() }));
vi.mock("./editions/actions", () => ({ createEditionAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/cover-actions", () => ({ createCoverUploadAction: vi.fn(), finalizeCoverUploadAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/publish-actions", () => ({ publishBookAction: vi.fn(), unpublishBookAction: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));

const book: AdminBookDTO = {
  id: "3a1b2c3d-0000-4000-8000-000000000001",
  canonicalKey: "golden",
  originalLanguage: "vi",
  primaryAuthorId: "author-id",
  authorName: "Author",
  status: "draft",
  localization: { locale: "vi", title: "Golden", slug: "golden" },
  localizations: [],
  editions: [
    { id: "edition-en", languageCode: "en", editionNumber: 1, status: "published", isDefault: true, activePublicationId: "pub-en", offerCount: 1, hasLiveOffer: true },
    { id: "edition-ja", languageCode: "ja", editionNumber: 1, status: "draft", isDefault: true, activePublicationId: null, offerCount: 0, hasLiveOffer: false },
  ],
  cover: null,
  topicIds: ["topic-id"],
  relatedBookIds: ["3a1b2c3d-0000-4000-8000-000000000002"],
  series: null,
  retailLinks: [],
  readinessIssues: ["missing_cover"],
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAdminBook).mockResolvedValue(book);
  vi.mocked(listCatalogEntityOptions).mockImplementation(async (kind) => [{ id: `${kind}-id`, name: `${kind} option`, canonicalSlug: `${kind}-option` }]);
  vi.mocked(listContentLanguages).mockResolvedValue([{ code: "en", name: "English" }, { code: "ja", name: "Japanese" }, { code: "vi", name: "Vietnamese" }]);
  vi.mocked(listAdminBooks).mockResolvedValue([
    { id: book.id, canonicalKey: "golden", title: "Golden", authorName: "Author", status: "draft", hasActivePublication: false, readinessIssues: [] },
    { id: "3a1b2c3d-0000-4000-8000-000000000002", canonicalKey: "quiet", title: "Quiet", authorName: "Linh Tran", status: "published", hasActivePublication: true, readinessIssues: [] },
    { id: "3a1b2c3d-0000-4000-8000-000000000003", canonicalKey: "rivers", title: "Rivers", authorName: "Minh Le", status: "draft", hasActivePublication: false, readinessIssues: [] },
  ]);
});
it("renders every anchored work-level section and no per-edition controls", async () => {
  const { container } = render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${book.id}` });
  for (const id of ["details", "localizations", "editions", "retail", "cover", "relations", "publish"]) {
    expect(container.querySelector(`section#${id}`)).not.toBeNull();
    expect(container.querySelector(`nav a[href='#${id}']`)).not.toBeNull();
  }
  for (const label of ["Primary author", "Book language", "Title (vi)", "Slug (vi)", "Description (vi)", "Key ideas (vi)", "Title (en)", "Title (ja)", "Cover image", "Cover alt text", "Series position"]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
  for (const label of ["Save details", "Save vi copy", "Save en copy", "Save ja copy", "Upload cover", "Save relations", "Save editorial pins", "Save paperback retailers", "Add edition"]) {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  }
  // Price, offers, credits and the EPUB belong to one edition and live on its own page.
  for (const label of ["Price (minor units)", "Offer is active", "EPUB file"]) expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
  expect(screen.getByText("Author · golden · draft")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish book" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toHaveAttribute("href", "#cover");
});

it("lists every edition with its language, state and a link to its own page", async () => {
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  const english = screen.getByRole("link", { name: /English/ });
  expect(english).toHaveAttribute("href", `/admin/books/${book.id}/editions/edition-en`);
  expect(screen.getByText("Published · default · 1 offer")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Japanese/ })).toHaveAttribute("href", `/admin/books/${book.id}/editions/edition-ja`);
  expect(screen.getByText("Draft · default · no offer")).toBeInTheDocument();
});

it("says so when a work has no edition yet", async () => {
  vi.mocked(getAdminBook).mockResolvedValue({ ...book, editions: [] });
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(screen.getByText("No editions yet. Add one to upload an EPUB.")).toBeInTheDocument();
});

it("links to the shared quotes taken from this book", async () => {
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(screen.getByRole("link", { name: "Shared quotes from this book" })).toHaveAttribute("href", `/admin/quotes?book=${book.id}`);
});

it("places Paperback retailers between Editions and Cover and lists saved links", async () => {
  vi.mocked(getAdminBook).mockResolvedValue({ ...book, retailLinks: [{ id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: false }] });
  const { container } = render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  const ids = Array.from(container.querySelectorAll("section[id]")).map((section) => section.id);
  expect(ids.indexOf("retail")).toBe(ids.indexOf("editions") + 1);
  expect(ids.indexOf("cover")).toBe(ids.indexOf("retail") + 1);
  expect(screen.getByDisplayValue("https://shopee.vn/x")).toBeInTheDocument();
  expect(screen.getByLabelText("Active")).not.toBeChecked();
});

it("authorizes before querying book or entity options", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
  await expect(AdminBookPage({ params: Promise.resolve({ bookId: book.id }) })).rejects.toThrow("Forbidden");
  expect(getAdminBook).not.toHaveBeenCalled();
  expect(listCatalogEntityOptions).not.toHaveBeenCalled();
  expect(listAdminBooks).not.toHaveBeenCalled();
  expect(listContentLanguages).not.toHaveBeenCalled();
});

it("pins the saved related book and offers every other book, never this one", async () => {
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="relatedBookIds"]')).map((input) => input.value)).toEqual([
    "3a1b2c3d-0000-4000-8000-000000000002",
  ]);
  const choices = Array.from(screen.getByLabelText<HTMLSelectElement>("Pin another book").options).map((option) => option.text);
  expect(choices).toEqual(["Choose a book", "Rivers — Minh Le (draft)"]);
  expect(screen.getByRole("listitem", { name: /Quiet/ })).toHaveTextContent("Quiet — Linh Tran (published)");
});
