// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import CheckoutTransferPage from "@/app/[lang]/(account)/checkout/[orderId]/transfer/page";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

// Routing only. Every case here leaves the page before it renders anything, which is the point:
// what this file pins is WHERE a reader ends up, and the bank details are the one thing on the site
// that only exists here.
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

const params = Promise.resolve({ lang: "en", orderId: ORDER_ID });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({
    appEnv: "test",
    paymentProvider: "manual",
    bankTransfer: null,
  } as unknown as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("CheckoutTransferPage", () => {
  // The reader has already sent the money. They come back to this page - the only place the account
  // number and the reference exist - because the bank asked for the reference again, and in between
  // ops flipped PAYMENT_PROVIDER, which is the very switch this guard exists for. Deciding on the
  // environment before the order is loaded gave them a blank 404 with money in hand.
  it("sends the owner of a manual order to the status page when the deployment left the manual provider", async () => {
    vi.mocked(getServerEnv).mockReturnValue({
      appEnv: "production",
      paymentProvider: "simulator",
      bankTransfer: null,
    } as unknown as ReturnType<typeof getServerEnv>);

    await expect(CheckoutTransferPage({ params })).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  it("sends an order booked under another provider to the status page", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "simulator" });

    await expect(CheckoutTransferPage({ params })).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  // Ownership must still not leak. getCustomerOrder returns null for both a missing order and
  // another reader's, and the two have to stay indistinguishable however the environment is set -
  // including the non-manual environment the first case above now reaches the order through.
  it("keeps a missing or foreign order a 404, in a manual deployment and outside one", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(CheckoutTransferPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");

    vi.mocked(getServerEnv).mockReturnValue({
      appEnv: "production",
      paymentProvider: "simulator",
      bankTransfer: null,
    } as unknown as ReturnType<typeof getServerEnv>);
    await expect(CheckoutTransferPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sends a reader who already owns the book to the checkout page", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: true });

    await expect(CheckoutTransferPage({ params })).rejects.toThrow(
      new RegExp(`NEXT_REDIRECT /en/checkout/${ORDER_ID}$`),
    );
  });

  it("sends a finished order to the status page", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, status: "completed", paymentStatus: "succeeded" });

    await expect(CheckoutTransferPage({ params })).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  // Manual transfer settles VND only. A reader is never shown bank details for an amount that is not
  // dong, and no QR is built for it.
  it.each(["USD", "JPY"])("sends a %s order to the status page instead of printing bank details", async (currency) => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, currency });

    await expect(CheckoutTransferPage({ params })).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });
});
