import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminBundlesPage from "@/app/admin/bundles/page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminBundles } from "@/lib/data/bundles";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/bundles", () => ({ listAdminBundles: vi.fn() }));

const bundleId = "8a1b2c3d-0000-4000-8000-000000000001";

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

it("lists each bundle with its status, membership, and readiness", async () => {
  vi.mocked(listAdminBundles).mockResolvedValue([
    {
      id: bundleId,
      title: "Bộ khởi đầu",
      status: "draft",
      memberCount: 3,
      publishedMemberCount: 2,
      readiness: { blocking: ["missing_cover"], warnings: ["unpublished_member"] },
    },
  ]);

  render(await AdminBundlesPage());

  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/bundles" });
  expect(screen.getByRole("link", { name: "Bộ khởi đầu" })).toHaveAttribute("href", `/admin/bundles/${bundleId}`);
  expect(screen.getByRole("link", { name: "New bundle" })).toHaveAttribute("href", "/admin/bundles/new");

  const [row] = screen.getAllByRole("row").slice(1);
  const cells = within(row).getAllByRole("cell");
  expect(cells[0]).toHaveTextContent("draft");
  expect(cells[1]).toHaveTextContent("2 of 3 published");
  expect(within(cells[2]).getByText("1 to fix")).toHaveAttribute("title", "Upload a cover image.");
});

it("shows a ready bundle as ready even while a member is unpublished", async () => {
  vi.mocked(listAdminBundles).mockResolvedValue([
    {
      id: bundleId,
      title: "Bộ khởi đầu",
      status: "published",
      memberCount: 3,
      publishedMemberCount: 2,
      readiness: { blocking: [], warnings: ["unpublished_member"] },
    },
  ]);

  render(await AdminBundlesPage());

  expect(screen.getByText("Ready to publish")).toBeInTheDocument();
  expect(screen.getByText("1 warning")).toHaveAttribute(
    "title",
    "A member book is not published, so the bundle page hides it.",
  );
});

it("explains an empty list", async () => {
  vi.mocked(listAdminBundles).mockResolvedValue([]);

  render(await AdminBundlesPage());

  expect(screen.getByText("No bundles yet.")).toBeInTheDocument();
});

it("authorizes before listing", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));

  await expect(AdminBundlesPage()).rejects.toThrow("Forbidden");

  expect(listAdminBundles).not.toHaveBeenCalled();
});
