import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OrderPage from "@/app/[lang]/(account)/account/orders/[orderId]/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", editionId: null, languageCode: null, title: "A Book", hasActiveEntitlement: false }],
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 129000,
  currency: "VND",
  subtotalMinor: 129000,
  discountMinor: 0,
  couponCode: null,
  createdAt: "2026-09-15T00:00:00Z",
  hasAllActiveEntitlements: false,
  referenceCode: "IB-ABCDE",
  provider: "manual",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

// S9 spec 5. A bundle order is a different shape of the same page: several member books under one
// snapshot name and one price, with ownership decided across the whole set.
const bundleOrder: CustomerOrderDTO = {
  ...order,
  bundleId: "90000000-0000-4000-8000-000000000001",
  title: "The Starter Bundle",
  totalMinor: 300000,
  subtotalMinor: 300000,
  items: [
    { bookId: "30000000-0000-4000-8000-000000000001", editionId: null, languageCode: null, title: "First", hasActiveEntitlement: false },
    { bookId: "30000000-0000-4000-8000-000000000002", editionId: null, languageCode: null, title: "Second", hasActiveEntitlement: false },
    { bookId: "30000000-0000-4000-8000-000000000003", editionId: null, languageCode: null, title: "Third", hasActiveEntitlement: false },
  ],
};

const params = Promise.resolve({ lang: "en", orderId: ORDER_ID });

function env(paymentProvider: string): ReturnType<typeof getServerEnv> {
  return { appEnv: "test", paymentProvider } as unknown as ReturnType<typeof getServerEnv>;
}

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue(env("manual"));
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("OrderPage", () => {
  // The reader's only navigable route to an order the active provider cannot settle. Every
  // provider-specific page turns them away, and this page offers no continue link for it, so
  // without this the status page's explanation was reachable by redirect or a typed URL only.
  it("links to the order status when the active provider cannot settle the order", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env("simulator"));

    render(await OrderPage({ params }));

    expect(screen.getByRole("link", { name: "View order status" })).toHaveAttribute(
      "href",
      `/en/checkout/${ORDER_ID}/status`,
    );
    expect(screen.queryByRole("link", { name: "View transfer instructions" })).not.toBeInTheDocument();
  });

  it("offers the transfer instructions, and no status link, while the order can still be paid", async () => {
    render(await OrderPage({ params }));

    expect(screen.getByRole("link", { name: "View transfer instructions" })).toHaveAttribute(
      "href",
      `/en/checkout/${ORDER_ID}/transfer`,
    );
    expect(screen.queryByRole("link", { name: "View order status" })).not.toBeInTheDocument();
  });

  // S9 spec 5: the detail page names the bundle snapshot and how many books it holds, instead of
  // truncating the order to its first member.
  it("names a bundle order by its snapshot and item count", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(bundleOrder);

    render(await OrderPage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "The Starter Bundle" })).toBeInTheDocument();
    expect(screen.getByText("3 editions")).toBeInTheDocument();
  });

  it("sends a completed bundle order to the library, and a completed single book to the reader", async () => {
    const completed = { status: "completed", paymentStatus: "succeeded", hasAllActiveEntitlements: true } as const;
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...bundleOrder,
      ...completed,
      items: bundleOrder.items.map((item) => ({ ...item, hasActiveEntitlement: true })),
    });
    const { unmount } = render(await OrderPage({ params }));
    expect(screen.getByRole("link", { name: "Go to your library" })).toHaveAttribute("href", "/en/library");
    expect(screen.queryByRole("link", { name: "Read now" })).not.toBeInTheDocument();
    unmount();

    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      ...completed,
      items: [{ ...order.items[0], hasActiveEntitlement: true }],
    });
    render(await OrderPage({ params }));
    expect(screen.getByRole("link", { name: "Read now" })).toHaveAttribute(
      "href",
      "/en/read/30000000-0000-4000-8000-000000000001",
    );
    expect(screen.queryByText("3 editions")).not.toBeInTheDocument();
  });

  it("renders the admin's decline reason", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      paymentStatus: "failed",
      declinedAt: "2026-09-18T00:00:00Z",
      declineReason: "No transfer found on the statement",
    });

    render(await OrderPage({ params }));

    expect(screen.getByRole("alert")).toHaveTextContent("Reason: No transfer found on the statement.");
  });
});
