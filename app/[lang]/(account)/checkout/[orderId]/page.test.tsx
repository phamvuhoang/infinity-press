import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutPage from "@/app/[lang]/(account)/checkout/[orderId]/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { getMyOrderGift } from "@/lib/commerce/gifts";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

// The header reaches for a Supabase session and has nothing to do with which state this page shows.
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
// Routing only: every redirect/notFound case here leaves the page before it renders. What is pinned
// is that a reader is not shown a Pay button whose only outcome is to bounce them back here.
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getBookCards: vi.fn(async () => []) }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));
// The purchaser's own gift read. It answers from public.gift_summaries through get_my_order_gift -
// there is no `gifts` table select on this page to stub.
vi.mock("@/lib/commerce/gifts", () => ({ getMyOrderGift: vi.fn() }));

afterEach(cleanup);

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
  provider: "simulator",
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ email: "reader@example.test" } as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({
    appEnv: "test",
    paymentProvider: "simulator",
  } as unknown as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
  vi.mocked(getMyOrderGift).mockResolvedValue(null);
});

describe("CheckoutPage", () => {
  it("sends an order booked under another provider to the status page instead of offering Pay", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "manual" });

    await expect(CheckoutPage({ params })).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  // Ownership outranks the provider: a reader who holds the book should be told that, not told
  // about a provider switch, and this page is where "You already own this book" lives.
  it("keeps the already-owned view for a stale order the reader already owns", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "manual", hasAllActiveEntitlements: true });

    await expect(CheckoutPage({ params })).resolves.toBeTruthy();
  });

  it("still renders for an order booked under the active provider", async () => {
    await expect(CheckoutPage({ params })).resolves.toBeTruthy();
  });

  it("shows one total and a code field on an order with no discount", async () => {
    render(await CheckoutPage({ params }));

    expect(screen.queryByText("Subtotal")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Enter a code")).toBeInTheDocument();
  });

  // The coupon field is the ENTIRE control keeping a reader from spending a code on a book they
  // already own through the UI (the database itself allows it - see docs/runbooks/coupons.md §5).
  // Anchor on the form's own landmark, not on always-present page content: `role="status"` for
  // "You already own this book" and Next's route announcer both use roles this test must not
  // accidentally satisfy on their own.
  it("hides the coupon form once the order's book is already owned, and shows it otherwise", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: true });
    const { unmount } = render(await CheckoutPage({ params }));
    expect(screen.queryByRole("region", { name: "Promotion code" })).not.toBeInTheDocument();
    unmount();

    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: false });
    render(await CheckoutPage({ params }));
    expect(screen.getByRole("region", { name: "Promotion code" })).toBeInTheDocument();
  });

  // S9 spec 5. Every member the reader is paying for is named. A page that rendered items[0] would
  // show one book of three and look, to the reader, exactly like a correct single-book checkout.
  it("names every member book of a bundle order, under the bundle's own title", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(bundleOrder);

    render(await CheckoutPage({ params }));

    expect(screen.getByRole("heading", { level: 2, name: "The Starter Bundle" })).toBeInTheDocument();
    const members = screen.getByRole("list", { name: "In this bundle" });
    expect(members.textContent).toContain("First");
    expect(members.textContent).toContain("Second");
    expect(members.textContent).toContain("Third");
  });

  // The charged amount is orders.total_minor and nothing else. The public bundle page picks the
  // cheapest offer while create_bundle_order picks the alphabetically-first market, so re-resolving
  // an offer here could quote a price the reader will not actually be charged.
  it("renders the price the order was booked at", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(bundleOrder);

    render(await CheckoutPage({ params }));

    expect(screen.getByText("₫300,000")).toBeInTheDocument();
  });

  // A bundle is never prorated for partial ownership (spec 5), so owning some of it must not take
  // the Pay button away - the reader still has books to gain, at the price the bundle costs.
  it("keeps Pay, and says what is already owned, when only some members are held", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...bundleOrder,
      hasAllActiveEntitlements: false,
      items: bundleOrder.items.map((item, index) => ({ ...item, hasActiveEntitlement: index === 0 })),
    });

    render(await CheckoutPage({ params }));

    expect(screen.getByRole("button", { name: "Pay" })).toBeInTheDocument();
    expect(screen.getByText("You already own 1 of 3 editions in this bundle.")).toBeInTheDocument();
  });

  // And owning ALL of it replaces Pay with the library, rather than "Read now" for one arbitrary
  // member: hasAllActiveEntitlements decides this, never items[0].
  it("replaces Pay with a library link once every member is owned", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...bundleOrder,
      hasAllActiveEntitlements: true,
      items: bundleOrder.items.map((item) => ({ ...item, hasActiveEntitlement: true })),
    });

    render(await CheckoutPage({ params }));

    expect(screen.queryByRole("button", { name: "Pay" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your library" })).toHaveAttribute("href", "/en/library");
  });

  // Single-book checkout is untouched by any of the above: one cover, one title, "Read now" to the
  // reader, and no bundle list at all.
  it("leaves the single-book checkout exactly as it was", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      hasAllActiveEntitlements: true,
      items: [{ ...order.items[0], hasActiveEntitlement: true }],
    });

    render(await CheckoutPage({ params }));

    expect(screen.getByText("You already own this book.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Read now" })).toHaveAttribute(
      "href",
      "/en/read/30000000-0000-4000-8000-000000000001",
    );
    expect(screen.queryByRole("list", { name: "In this bundle" })).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------------------------------
  // The gift block (S9 spec 7.2).

  it("offers the gift form above the coupon and above Pay", async () => {
    const { container } = render(await CheckoutPage({ params }));

    const html = container.innerHTML;
    expect(screen.getByText("Send this as a gift")).toBeInTheDocument();
    // A 100% coupon completes the order as it is applied, so a gift arranged after the coupon would
    // be arranged too late. Position is the requirement, so position is what is asserted.
    expect(html.indexOf("Send this as a gift")).toBeLessThan(html.indexOf("Promotion code"));
    expect(html.indexOf("Send this as a gift")).toBeLessThan(html.indexOf(">Pay<"));
  });

  it("prefills an existing pending gift without exposing anything else about it", async () => {
    vi.mocked(getMyOrderGift).mockResolvedValue({ recipientEmail: "friend@example.com", message: "Enjoy", status: "pending" });

    const { container } = render(await CheckoutPage({ params }));

    expect(screen.getByLabelText("Recipient email")).toHaveValue("friend@example.com");
    expect(screen.getByLabelText("Message (optional)")).toHaveValue("Enjoy");
    expect(screen.getByRole("button", { name: "Remove gift" })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain("gifts/claim");
  });

  it("stops offering gift edits once a transfer has been reported", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, claimedAt: "2026-09-20T00:00:00Z" });
    vi.mocked(getMyOrderGift).mockResolvedValue({ recipientEmail: "friend@example.com", message: null, status: "pending" });

    render(await CheckoutPage({ params }));

    expect(screen.queryByLabelText("Recipient email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save gift" })).not.toBeInTheDocument();
  });

  it("offers no gift form for an order the reader already owns in full", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      hasAllActiveEntitlements: true,
      items: [{ ...order.items[0], hasActiveEntitlement: true }],
    });

    render(await CheckoutPage({ params }));

    expect(screen.queryByText("Send this as a gift")).not.toBeInTheDocument();
  });

  it("shows the subtotal, the discount, and the reduced total once a code is applied", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({
      ...order,
      subtotalMinor: 129000,
      discountMinor: 25800,
      totalMinor: 103200,
      couponCode: "TWENTY",
    });

    render(await CheckoutPage({ params }));

    expect(screen.getByText("Subtotal")).toBeInTheDocument();
    expect(screen.getByText("Code TWENTY applied.")).toBeInTheDocument();
  });
});
