import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminCouponsPage from "@/app/admin/coupons/page";
import { requireAdmin } from "@/lib/auth/admin";
import { listAdminCoupons } from "@/lib/data/coupons";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/coupons", () => ({ listAdminCoupons: vi.fn() }));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

it("lists a scoped coupon and an unlimited coupon, with the code as a link", async () => {
  vi.mocked(listAdminCoupons).mockResolvedValue([
    {
      id: "70000000-0000-4000-8000-00000000000a",
      code: "LAUNCH20",
      kind: "percent",
      percentOff: 20,
      amountOffMinor: null,
      currency: null,
      startsAt: null,
      endsAt: null,
      active: true,
      maxRedemptions: 100,
      maxRedemptionsPerProfile: 1,
      note: null,
      createdAt: "2026-09-15T00:00:00Z",
      reservedCount: 2,
      redeemedCount: 1,
      bundleIds: [], bookIds: ["3a1b2c3d-0000-4000-8000-000000000001"],
    },
    {
      id: "70000000-0000-4000-8000-00000000000b",
      code: "ALLBOOKS",
      kind: "fixed",
      percentOff: null,
      amountOffMinor: 50000,
      currency: "VND",
      startsAt: null,
      endsAt: null,
      active: false,
      maxRedemptions: null,
      maxRedemptionsPerProfile: 1,
      note: null,
      createdAt: "2026-09-10T00:00:00Z",
      reservedCount: 0,
      redeemedCount: 0,
      bundleIds: [], bookIds: [],
    },
  ]);

  render(await AdminCouponsPage());

  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/coupons" });

  const codeLink = screen.getByRole("link", { name: "LAUNCH20" });
  expect(codeLink).toHaveAttribute("href", "/admin/coupons/70000000-0000-4000-8000-00000000000a");

  const rows = screen.getAllByRole("row").slice(1); // drop the header row
  expect(rows[0]).toHaveTextContent("LAUNCH20");

  // Cells in column order: Value, Window, Active, Reserved, Redeemed, Scope (Code is the row's
  // <th>, not a <td>, so it is not among these). Scoped to their own cell rather than asserted
  // against the whole row's text, so "2" and "1" can't coincidentally match elsewhere in the row -
  // the row already contains a "1" inside "1 books", which an unscoped assertion on "1" would have
  // matched regardless of what the Redeemed cell actually held.
  const row0Cells = within(rows[0]).getAllByRole("cell");
  expect(row0Cells[0]).toHaveTextContent("20%");
  expect(row0Cells[3]).toHaveTextContent("2"); // reserved
  expect(row0Cells[4]).toHaveTextContent("1"); // redeemed
  expect(row0Cells[5]).toHaveTextContent("1 books");

  expect(rows[1]).toHaveTextContent("ALLBOOKS");
  const row1Cells = within(rows[1]).getAllByRole("cell");
  expect(row1Cells[2]).toHaveTextContent("No"); // active
  expect(row1Cells[3]).toHaveTextContent("0"); // reserved
  expect(row1Cells[4]).toHaveTextContent("0"); // redeemed
  expect(row1Cells[5]).toHaveTextContent("All books");
});

it("explains an empty coupon list", async () => {
  vi.mocked(listAdminCoupons).mockResolvedValue([]);

  render(await AdminCouponsPage());

  expect(screen.getByText("No coupons yet.")).toBeInTheDocument();
});
