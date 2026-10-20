import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminQuotesPage from "./page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminSharedQuotes } from "@/lib/data/admin-shared-quotes";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/admin-shared-quotes", () => ({ listAdminSharedQuotes: vi.fn() }));
vi.mock("./actions", () => ({ removeSharedQuoteAction: vi.fn() }));

const BOOK = "3a1b2c3d-0000-4000-8000-000000000001";

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAdminSharedQuotes).mockResolvedValue([]);
});

it("authorizes before listing", async () => {
  vi.mocked(requireAdmin).mockRejectedValue(new Error("Forbidden"));
  await expect(AdminQuotesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("Forbidden");
  expect(listAdminSharedQuotes).not.toHaveBeenCalled();
});

it("filters by a valid book id and ignores anything else", async () => {
  render(await AdminQuotesPage({ searchParams: Promise.resolve({ book: BOOK }) }));
  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/quotes" });
  expect(listAdminSharedQuotes).toHaveBeenLastCalledWith(BOOK);
  expect(screen.getByRole("heading", { name: "Shared quotes" })).toBeInTheDocument();
  await AdminQuotesPage({ searchParams: Promise.resolve({ book: "not-a-uuid" }) });
  expect(listAdminSharedQuotes).toHaveBeenLastCalledWith(null);
});
