import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OrdersPage from "@/app/[lang]/(account)/account/orders/page";
import { requireUser } from "@/lib/auth/session";
import { type CustomerOrderDTO, listCustomerOrders } from "@/lib/data/orders";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ listCustomerOrders: vi.fn() }));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const BUNDLE_ORDER_ID = "70000000-0000-4000-8000-000000000002";

const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", editionId: null, languageCode: null, title: "A Book", hasActiveEntitlement: false }],
  status: "completed",
  paymentStatus: "succeeded",
  totalMinor: 129000,
  currency: "VND",
  subtotalMinor: 129000,
  discountMinor: 0,
  couponCode: null,
  createdAt: "2026-09-15T00:00:00Z",
  hasAllActiveEntitlements: true,
  referenceCode: "IB-ABCDE",
  provider: "simulator",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

const bundleOrder: CustomerOrderDTO = {
  ...order,
  id: BUNDLE_ORDER_ID,
  bundleId: "90000000-0000-4000-8000-000000000001",
  title: "The Starter Bundle",
  totalMinor: 300000,
  subtotalMinor: 300000,
  items: [
    { bookId: "30000000-0000-4000-8000-000000000001", editionId: null, languageCode: null, title: "First", hasActiveEntitlement: true },
    { bookId: "30000000-0000-4000-8000-000000000002", editionId: null, languageCode: null, title: "Second", hasActiveEntitlement: true },
    { bookId: "30000000-0000-4000-8000-000000000003", editionId: null, languageCode: null, title: "Third", hasActiveEntitlement: true },
  ],
};

const params = Promise.resolve({ lang: "en" });

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(listCustomerOrders).mockResolvedValue([bundleOrder, order]);
});

describe("OrdersPage", () => {
  // S9 spec 5. The list names each order by what it is: a bundle by its own snapshot plus the
  // number of books it holds, a single book by its title and nothing more. Naming a bundle order
  // after its first member would make two different purchases read identically.
  it("names a bundle order by its snapshot and item count, and leaves a single book alone", async () => {
    render(await OrdersPage({ params }));

    expect(screen.getByRole("link", { name: "The Starter Bundle" })).toHaveAttribute(
      "href",
      `/en/account/orders/${BUNDLE_ORDER_ID}`,
    );
    expect(screen.getByText("3 books")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "A Book" })).toHaveAttribute("href", `/en/account/orders/${ORDER_ID}`);
    // One count line on the page, for the one bundle order: a single-book row gains nothing.
    expect(screen.getAllByText(/^\d+ books?$/)).toHaveLength(1);
  });

  it("keeps each order's own total rather than one row's", async () => {
    render(await OrdersPage({ params }));

    expect(screen.getByText("₫300,000")).toBeInTheDocument();
    expect(screen.getByText("₫129,000")).toBeInTheDocument();
  });
});
