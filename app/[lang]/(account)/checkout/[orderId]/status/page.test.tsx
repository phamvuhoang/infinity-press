import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutStatusPage from "@/app/[lang]/(account)/checkout/[orderId]/status/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

// The header and the auto-refresh widget both reach for a Supabase session or a timer and have
// nothing to do with which state this page decides to show.
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/components/commerce/status-auto-refresh", () => ({ StatusAutoRefresh: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn() }));
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
  vi.mocked(getBookCards).mockResolvedValue([]);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("CheckoutStatusPage", () => {
  it("explains a pending order booked under a provider this deployment no longer runs", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env("simulator"));

    render(await CheckoutStatusPage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "This order can no longer be paid" })).toBeInTheDocument();
    expect(screen.getByText(/Start a new order from the book page/)).toBeInTheDocument();
  });

  // Payments being off is not the same thing, and must not borrow that copy: create_ebook_order
  // refuses every order while payments are disabled (EB011), so "start a new order" is advice the
  // reader cannot act on. Their order is not stale, it is waiting on us.
  it("does not tell a reader to start a new order while payments are switched off", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env("disabled"));

    render(await CheckoutStatusPage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "Payments are paused" })).toBeInTheDocument();
    expect(screen.queryByText(/Start a new order from the book page/)).not.toBeInTheDocument();
  });

  it("keeps the manual states for an order the active provider can still settle", async () => {
    render(await CheckoutStatusPage({ params }));

    expect(screen.getByRole("heading", { level: 1, name: "Waiting for your transfer" })).toBeInTheDocument();
  });

  // S9 spec 5: the order is named by its own snapshot and sized by its item count, rather than
  // borrowing the name of whichever member happened to come back first.
  it("names a bundle order by its snapshot and says how many books it holds", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(bundleOrder);

    render(await CheckoutStatusPage({ params }));

    expect(screen.getByText("The Starter Bundle")).toBeInTheDocument();
    expect(screen.getByText("3 books")).toBeInTheDocument();
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });

  // "Read now" needs one book to open. A completed bundle order sends the reader to their library
  // instead, which is where all three of them now are.
  it("offers the library, and no single-book read link, for a completed bundle order", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...bundleOrder,
      provider: "simulator",
      status: "completed",
      paymentStatus: "succeeded",
      hasAllActiveEntitlements: true,
      items: bundleOrder.items.map((item) => ({ ...item, hasActiveEntitlement: true })),
    });
    vi.mocked(getServerEnv).mockReturnValue(env("simulator"));

    render(await CheckoutStatusPage({ params }));

    expect(screen.getByRole("link", { name: "Go to your library" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Read now" })).not.toBeInTheDocument();
  });

  it("still offers Read now for a completed single-book order", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      provider: "simulator",
      status: "completed",
      paymentStatus: "succeeded",
      hasAllActiveEntitlements: true,
      items: [{ ...order.items[0], hasActiveEntitlement: true }],
    });
    vi.mocked(getServerEnv).mockReturnValue(env("simulator"));

    render(await CheckoutStatusPage({ params }));

    expect(screen.getByRole("link", { name: "Read now" })).toHaveAttribute(
      "href",
      "/en/read/30000000-0000-4000-8000-000000000001",
    );
    expect(screen.queryByText("3 books")).not.toBeInTheDocument();
    expect(screen.getByText("Your ebook is ready in your library.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your library" })).toBeInTheDocument();
  });

  // S9. A gift purchaser is granted nothing - the books go to the recipient on claim - so a
  // completed gift order is the one completed order whose books the buyer does not own. The page
  // must not tell them otherwise, and must not send them to a library that will never hold it.
  it("does not claim the library holds the book on a completed gift order", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      provider: "simulator",
      status: "completed",
      paymentStatus: "succeeded",
      hasAllActiveEntitlements: false,
    });
    vi.mocked(getServerEnv).mockReturnValue(env("simulator"));

    render(await CheckoutStatusPage({ params }));

    expect(screen.queryByText("Your ebook is ready in your library.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to your library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Read now" })).not.toBeInTheDocument();
    expect(screen.getByText("Your gift is on its way")).toBeInTheDocument();
  });
});
