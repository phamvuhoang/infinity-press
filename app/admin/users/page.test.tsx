import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UsersPage from "./page";
import UserPage from "./[profileId]/page";
import { requireAdmin } from "@/lib/auth/admin";
import { searchUsers, getAdminUser } from "@/lib/data/users";
import { listAdminBooks } from "@/lib/data/books";
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/users", () => ({ searchUsers: vi.fn(), getAdminUser: vi.fn() }));
vi.mock("@/lib/data/books", () => ({ listAdminBooks: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/admin/users/[profileId]/entitlements/actions", () => ({ grantComplimentaryEntitlementAction: vi.fn(), revokeComplimentaryEntitlementAction: vi.fn() }));
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); });
it.each([() => UsersPage({ searchParams: Promise.resolve({ q: "reader" }) }), () => UserPage({ params: Promise.resolve({ profileId: "p1" }) })])("denies page access before loading users or books", async (page) => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
  await expect(page()).rejects.toThrow("NEXT_FORBIDDEN");
  expect(searchUsers).not.toHaveBeenCalled(); expect(getAdminUser).not.toHaveBeenCalled(); expect(listAdminBooks).not.toHaveBeenCalled();
});
it("uses the first repeated query and links to unlocalized detail", async () => {
  vi.mocked(searchUsers).mockResolvedValue([{ profileId: "p1", email: "reader@example.test", displayName: "Reader", verified: true }]);
  render(await UsersPage({ searchParams: Promise.resolve({ q: ["reader", "ignored"] }) }));
  expect(searchUsers).toHaveBeenCalledWith("reader");
  expect(screen.getByLabelText("Email")).toHaveValue("reader");
  expect(screen.getByRole("link", { name: "reader@example.test" })).toHaveAttribute("href", "/admin/users/p1");
});
it("renders detail identity and grant options", async () => {
  vi.mocked(getAdminUser).mockResolvedValue({ profileId: "p1", email: "reader@example.test", displayName: "Reader", verified: true, isAdmin: true, entitlements: [] });
  vi.mocked(listAdminBooks).mockResolvedValue([]);
  render(await UserPage({ params: Promise.resolve({ profileId: "p1" }) }));
  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/users/p1" });
  expect(screen.getByRole("heading", { name: "reader@example.test" })).toBeVisible();
  expect(screen.getByText(/verified email.*admin/)).toBeVisible();
  expect(screen.getByLabelText("Book")).toBeVisible();
});
