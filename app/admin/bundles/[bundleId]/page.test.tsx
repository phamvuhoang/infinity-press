import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminBundlePage from "./page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBooks } from "@/lib/data/books";
import { getAdminBundle, type AdminBundleDTO } from "@/lib/data/bundles";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/bundles", () => ({ getAdminBundle: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ listAdminBooks: vi.fn() }));
vi.mock("./actions", () => ({
  saveBundleLocalizationAction: vi.fn(),
  setBundleMembersAction: vi.fn(),
  setBundleOfferAction: vi.fn(),
  publishBundleAction: vi.fn(),
  unpublishBundleAction: vi.fn(),
}));
vi.mock("@/app/admin/bundles/[bundleId]/cover-actions", () => ({
  createBundleCoverUploadAction: vi.fn(),
  finalizeBundleCoverUploadAction: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";
const bookA = "8a1b2c3d-0000-4000-8000-00000000000a";
const bookB = "8a1b2c3d-0000-4000-8000-00000000000b";

const bundle: AdminBundleDTO = {
  id: bundleId,
  status: "draft",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  localizations: [
    { id: "loc-vi", locale: "vi", slug: "bo-khoi-dau", title: "Bộ khởi đầu", subtitle: null, description: "Hai cuốn sách." },
  ],
  members: [
    { editionId: bookA, bookId: bookA, languageCode: "en", position: 1, title: "Cuốn một", canonicalKey: "first", published: true },
    { editionId: bookB, bookId: bookB, languageCode: "en", position: 2, title: "Cuốn hai", canonicalKey: "second", published: false },
  ],
  offers: [{ id: "offer-vn", marketCode: "VN", currency: "VND", priceMinor: 150000, active: true }],
  cover: null,
  readiness: { blocking: ["too_few_published_members", "missing_cover"], warnings: ["unpublished_member"] },
};

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAdminBundle).mockResolvedValue(bundle);
  vi.mocked(listAdminBooks).mockResolvedValue([
    { id: bookA, canonicalKey: "first", title: "Cuốn một", authorName: "A", status: "published", hasActivePublication: true, editions: [], readinessIssues: [] },
    { id: bookB, canonicalKey: "second", title: "Cuốn hai", authorName: "B", status: "draft", hasActivePublication: false, editions: [], readinessIssues: [] },
    { id: "8a1b2c3d-0000-4000-8000-00000000000c", canonicalKey: "third", title: "Cuốn ba", authorName: "C", status: "published", hasActivePublication: true, editions: [], readinessIssues: [] },
  ]);
});

it("renders every anchored editor section with its form controls", async () => {
  const { container } = render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(requireAdmin).toHaveBeenCalledWith({ next: `/admin/bundles/${bundleId}` });
  for (const id of ["details", "localizations", "cover", "members", "offer", "publish"]) {
    expect(container.querySelector(`section#${id}`)).not.toBeNull();
    expect(container.querySelector(`nav a[href='#${id}']`)).not.toBeNull();
  }
  for (const label of ["Title (vi)", "Slug (vi)", "Description (vi)", "Title (en)", "Cover image", "Cover alt text", "Price for VN/VND (minor units)"]) {
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  }
  for (const label of ["Save vi copy", "Save en copy", "Save members", "Save VN/VND offer", "Upload cover"]) {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  }
});

it("authorizes before loading the bundle or the book options", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));

  await expect(AdminBundlePage({ params: Promise.resolve({ bundleId }) })).rejects.toThrow("Forbidden");

  expect(getAdminBundle).not.toHaveBeenCalled();
  expect(listAdminBooks).not.toHaveBeenCalled();
});

it("gives keyboard users explicit reorder controls and posts the whole ordered list", async () => {
  const { container } = render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  // Move up / Move down / Remove per member, plus an Add control - never drag-and-drop alone. Each
  // button names the book it acts on, so two rows are distinguishable to a screen reader.
  expect(screen.getByRole("button", { name: "Move Cuốn một up" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move Cuốn hai up" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Move Cuốn một down" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Move Cuốn hai down" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Cuốn hai from the bundle" })).toBeInTheDocument();
  expect(screen.getByLabelText("Add an edition to the bundle")).toBeInTheDocument();

  const posted = [...container.querySelectorAll<HTMLInputElement>("input[type='hidden'][name='editionIds']")].map((input) => input.value);
  expect(posted).toEqual([bookA, bookB]);
});

it("marks an unpublished member in the members list", async () => {
  render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByText("Cuốn hai")).toBeInTheDocument();
  expect(screen.getByText("Not published")).toBeInTheDocument();
});

it("shows the blocking issues and the warning, and refuses to publish while blocked", async () => {
  render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByRole("link", { name: "Add at least two published books to the bundle." })).toHaveAttribute("href", "#members");
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toHaveAttribute("href", "#cover");
  expect(
    screen.getByRole("link", { name: "A member book is not published, so the bundle page hides it." }),
  ).toHaveAttribute("href", "#members");
  expect(screen.getByRole("button", { name: "Publish bundle" })).toBeDisabled();
});

it("keeps the unpublished-member warning visible on a published bundle", async () => {
  vi.mocked(getAdminBundle).mockResolvedValue({
    ...bundle,
    status: "published",
    readiness: { blocking: [], warnings: ["unpublished_member"] },
  });

  render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByRole("button", { name: "Unpublish bundle" })).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "A member book is not published, so the bundle page hides it." }),
  ).toBeInTheDocument();
});

it("warns on a published bundle that has fallen below the publication rules", async () => {
  vi.mocked(getAdminBundle).mockResolvedValue({
    ...bundle,
    status: "published",
    readiness: { blocking: ["too_few_published_members"], warnings: [] },
  });

  render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByRole("link", { name: "Add at least two published books to the bundle." })).toBeInTheDocument();
  expect(screen.getByText(/no longer meets the publication rules/i)).toBeInTheDocument();
});

it("offers an empty add-offer form when the bundle has no price yet", async () => {
  vi.mocked(getAdminBundle).mockResolvedValue({ ...bundle, offers: [] });

  render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByText(/no price yet/i)).toBeInTheDocument();
  expect(screen.getByLabelText("New offer price (minor units)")).toHaveValue(null);
  expect(screen.getByRole("button", { name: "Add offer" })).toBeInTheDocument();
});

// The stranding defect: admin_set_bundle_offer upserts on (bundle, market, currency), so a second
// market is a second ROW. Both must stay visible and separately editable, and an inactive row must
// not be able to pass itself off as the bundle's live price.
it("shows every priced market as its own editable row", async () => {
  vi.mocked(getAdminBundle).mockResolvedValue({
    ...bundle,
    readiness: { blocking: [], warnings: [] },
    offers: [
      { id: "offer-us", marketCode: "US", currency: "USD", priceMinor: 900, active: false },
      { id: "offer-vn", marketCode: "VN", currency: "VND", priceMinor: 150000, active: true },
    ],
  });

  const { container } = render(await AdminBundlePage({ params: Promise.resolve({ bundleId }) }));

  expect(screen.getByLabelText("Price for US/USD (minor units)")).toHaveValue(900);
  expect(screen.getByLabelText("Price for VN/VND (minor units)")).toHaveValue(150000);
  expect(screen.getByRole("button", { name: "Save US/USD offer" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save VN/VND offer" })).toBeInTheDocument();
  // The inactive row shows as inactive without hiding the live one, and the panel's verdict is
  // computed over both.
  expect(screen.getByLabelText("US/USD offer is active")).not.toBeChecked();
  expect(screen.getByLabelText("VN/VND offer is active")).toBeChecked();
  expect(screen.getByText("Everything required for publishing is in place.")).toBeInTheDocument();
  // Each row posts its own identity, and that identity is not a field the operator can retype.
  const hidden = [...container.querySelectorAll<HTMLInputElement>("input[type='hidden'][name='marketCode']")].map((input) => input.value);
  expect(hidden).toEqual(["US", "VN"]);
  expect(screen.queryByLabelText("New offer market")).not.toBeInTheDocument();
});
