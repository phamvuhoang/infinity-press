import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import AdminPaymentsPage from "@/app/admin/payments/page";
import { requireAdmin } from "@/lib/auth/admin";
import { listManualPaymentQueue } from "@/lib/data/manual-payments";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/manual-payments", () => ({ listManualPaymentQueue: vi.fn() }));

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
});

it("lists a claimed order above an unclaimed one, with the reference as a link", async () => {
  vi.mocked(listManualPaymentQueue).mockResolvedValue([
    {
      orderId: "70000000-0000-4000-8000-00000000000a",
      referenceCode: "IB-ABCDE",
      email: "claimed@example.test",
      title: "A Claimed Book",
      totalMinor: 129000,
      currency: "VND",
      createdAt: "2026-09-15T00:00:00Z",
      claimedAt: "2026-09-16T00:00:00Z",
      claimNote: "Transferred via Vietcombank",
    },
    {
      orderId: "70000000-0000-4000-8000-00000000000b",
      referenceCode: "IB-FGHJK",
      email: "unclaimed@example.test",
      title: "An Unclaimed Book",
      totalMinor: 99000,
      currency: "VND",
      createdAt: "2026-09-10T00:00:00Z",
      claimedAt: null,
      claimNote: null,
    },
  ]);

  render(await AdminPaymentsPage({ searchParams: Promise.resolve({ q: "vietcombank" }) }));

  expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/payments" });
  expect(listManualPaymentQueue).toHaveBeenCalledWith("vietcombank");
  expect(screen.getByLabelText("Reference or email")).toHaveValue("vietcombank");

  const referenceLink = screen.getByRole("link", { name: "IB-ABCDE" });
  expect(referenceLink).toHaveAttribute("href", "/admin/orders/70000000-0000-4000-8000-00000000000a");

  const rows = screen.getAllByRole("row").slice(1); // drop the header row
  expect(rows[0]).toHaveTextContent("IB-ABCDE");
  expect(rows[1]).toHaveTextContent("IB-FGHJK");
  expect(rows[1]).toHaveTextContent("—");
});

it("explains an empty queue", async () => {
  vi.mocked(listManualPaymentQueue).mockResolvedValue([]);

  render(await AdminPaymentsPage({ searchParams: Promise.resolve({}) }));

  expect(screen.getByText("No manual payments are waiting for review.")).toBeInTheDocument();
});
