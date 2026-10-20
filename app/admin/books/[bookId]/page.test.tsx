import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AdminBookPage from "./page";
import { requireAdmin } from "@/lib/auth/admin";
import { getAdminBook, listAdminBooks, type AdminBookDTO } from "@/lib/data/books";
import { listCatalogEntityOptions } from "@/lib/data/catalog-entities";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ getAdminBook: vi.fn(), listAdminBooks: vi.fn() }));
vi.mock("@/lib/data/catalog-entities", () => ({ listCatalogEntityOptions: vi.fn() }));
vi.mock("./editor-actions", () => ({ updateBookDetailsAction: vi.fn(), saveBookLocalizationAction: vi.fn(), updateEditionAction: vi.fn(), updateOfferAction: vi.fn(), setBookRelationsAction: vi.fn(), setRelatedBooksAction: vi.fn(), saveRetailLinksAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/epub/actions", () => ({ createEpubUploadAction: vi.fn(), finalizeEpubUploadAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/cover-actions", () => ({ createCoverUploadAction: vi.fn(), finalizeCoverUploadAction: vi.fn() }));
vi.mock("@/app/admin/books/[bookId]/publish-actions", () => ({ publishBookAction: vi.fn(), unpublishBookAction: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/navigation")>()), useRouter: vi.fn(() => ({ refresh: vi.fn() })) }));

const book: AdminBookDTO = { id: "3a1b2c3d-0000-4000-8000-000000000001", canonicalKey: "golden", originalLanguage: "vi", primaryAuthorId: "author-id", authorName: "Author", status: "draft", localization: { locale: "vi", title: "Golden", slug: "golden" }, localizations: [], edition: { id: "edition-id", languageCode: "vi", isbn: null, editionNumber: 1, publicationDate: null }, sku: null, offer: { id: "offer-id", marketCode: "VN", currency: "VND", priceMinor: 1500, active: true, sale: null, effectivePriceMinor: 1500, saleState: "none" }, cover: null, topicIds: ["topic-id"], relatedBookIds: ["3a1b2c3d-0000-4000-8000-000000000002"], series: null, retailLinks: [], activePublicationId: null, readinessIssues: ["missing_cover"] };
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAdminBook).mockResolvedValue(book);
  vi.mocked(listCatalogEntityOptions).mockImplementation(async (kind) => [{ id: `${kind}-id`, name: `${kind} option`, canonicalSlug: `${kind}-option` }]);
  vi.mocked(listAdminBooks).mockResolvedValue([
    { id: book.id, canonicalKey: "golden", title: "Golden", authorName: "Author", status: "draft", hasActivePublication: false, readinessIssues: [] },
    { id: "3a1b2c3d-0000-4000-8000-000000000002", canonicalKey: "quiet", title: "Quiet", authorName: "Linh Tran", status: "published", hasActivePublication: true, readinessIssues: [] },
    { id: "3a1b2c3d-0000-4000-8000-000000000003", canonicalKey: "rivers", title: "Rivers", authorName: "Minh Le", status: "draft", hasActivePublication: false, readinessIssues: [] },
  ]);
});
it("renders every anchored editor section, including cover upload, and keeps the EPUB upload available", async () => {
  const { container } = render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/books/${book.id}` });
  for (const id of ["details", "localizations", "offer", "retail", "cover", "relations", "epub", "publish"]) {
    expect(container.querySelector(`section#${id}`)).not.toBeNull();
    expect(container.querySelector(`nav a[href='#${id}']`)).not.toBeNull();
  }
  for (const label of ["Primary author", "Title (vi)", "Slug (vi)", "Description (vi)", "Key ideas (vi)", "Title (en)", "Price (minor units)", "Offer is active", "Cover image", "Cover alt text", "Series position", "EPUB file"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
  for (const label of ["Save details", "Save vi copy", "Save en copy", "Save edition", "Save offer", "Upload cover", "Save relations", "Save editorial pins", "Save paperback retailers", "Upload EPUB"]) expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  expect(screen.getByText("Author · golden · draft")).toBeInTheDocument();
  expect(screen.getByText("Price: 1500 VND (VN)")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish book" })).toBeDisabled();
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toHaveAttribute("href", "#cover");
});
it("links to the shared quotes taken from this book", async () => {
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(screen.getByRole("link", { name: "Shared quotes from this book" })).toHaveAttribute("href", `/admin/quotes?book=${book.id}`);
});

it("places Paperback retailers between Edition & offer and Cover and lists saved links", async () => {
  vi.mocked(getAdminBook).mockResolvedValue({ ...book, retailLinks: [{ id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: null, currency: null, active: false }] });
  const { container } = render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  const ids = Array.from(container.querySelectorAll("section[id]")).map((section) => section.id);
  expect(ids.indexOf("retail")).toBe(ids.indexOf("offer") + 1);
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
it("explains missing edition and offer without exposing upload controls", async () => {
  vi.mocked(getAdminBook).mockResolvedValue({ ...book, edition: null, offer: null });
  render(await AdminBookPage({ params: Promise.resolve({ bookId: book.id }) }));
  expect(screen.getByText("No offer recorded.")).toBeInTheDocument();
  expect(screen.queryByLabelText("EPUB file")).not.toBeInTheDocument();
  expect(screen.getByText(/cannot accept an EPUB upload/)).toBeInTheDocument();
});
