// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { payOrderAction } from "@/app/[lang]/(account)/checkout/[orderId]/actions";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("next/navigation", () => ({
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
  provider: "simulator",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({
    appEnv: "test",
    paymentProvider: "simulator",
    simulatorSecret: "test-simulator-secret-0123456789abcdef",
  } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("payOrderAction", () => {
  it("requires a signed-in reader and returns them to this checkout", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT sign-in"));
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT sign-in");
    expect(requireUser).toHaveBeenCalledWith("en", `/en/checkout/${ORDER_ID}`);
    expect(getCustomerOrder).not.toHaveBeenCalled();
  });

  it("sends a pending order to the provider session", async () => {
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/simulate`);
  });

  it("refuses when payments are disabled", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ appEnv: "production", paymentProvider: "disabled", simulatorSecret: null } as ReturnType<typeof getServerEnv>);
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(getCustomerOrder).not.toHaveBeenCalled();
  });

  it("treats a missing or foreign order as missing", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
  });

  it("sends a finished order to its status page", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, status: "completed", paymentStatus: "succeeded" });
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  // C1: the order's own provider, not just the environment's. A reader arriving here from order
  // history holds an order booked under whichever provider was active when they pressed Buy, and
  // create_ebook_order's cancel-and-replace only runs when they come back through Buy.
  it("refuses an order booked under a provider that is no longer the active one", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "manual" });
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  it("never starts a payment for a book the reader already owns", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: true });
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(new RegExp(`NEXT_REDIRECT /en/checkout/${ORDER_ID}$`));
  });
});
