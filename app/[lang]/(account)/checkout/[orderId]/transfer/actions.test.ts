// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { claimTransferAction } from "@/app/[lang]/(account)/checkout/[orderId]/transfer/actions";
import { requireUser } from "@/lib/auth/session";
import { claimManualTransfer } from "@/lib/commerce/manual-payment";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/commerce/manual-payment", () => ({ claimManualTransfer: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", title: "A Book", hasActiveEntitlement: false }],
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
  vi.mocked(claimManualTransfer).mockResolvedValue(undefined);
});

describe("claimTransferAction", () => {
  it("redirects to the locale home when the locale is not supported", async () => {
    await expect(claimTransferAction("xx", ORDER_ID, new FormData())).rejects.toThrow("NEXT_REDIRECT /vi");
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("refuses to claim an order the reader does not own", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(claimTransferAction("vi", ORDER_ID, new FormData())).rejects.toThrow("NEXT_REDIRECT /vi/account/orders");
    expect(claimManualTransfer).not.toHaveBeenCalled();
  });

  it("passes a trimmed note through, and null for an empty one", async () => {
    const withNote = new FormData();
    withNote.set("note", "  Transferred via Vietcombank  ");
    await claimTransferAction("vi", ORDER_ID, withNote);
    expect(claimManualTransfer).toHaveBeenCalledWith("vi", ORDER_ID, "Transferred via Vietcombank");

    vi.mocked(claimManualTransfer).mockClear();
    await claimTransferAction("vi", ORDER_ID, new FormData());
    expect(claimManualTransfer).toHaveBeenCalledWith("vi", ORDER_ID, null);
  });

  // C1: a manual surface acting on an order booked under another provider. claim_manual_transfer
  // raises EB020 for it, so without this guard the reader's only outcome is an unhandled error.
  it("refuses an order that was not booked under the manual provider", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "simulator" });
    await expect(claimTransferAction("vi", ORDER_ID, new FormData())).rejects.toThrow(
      `NEXT_REDIRECT /vi/checkout/${ORDER_ID}/status`,
    );
    expect(claimManualTransfer).not.toHaveBeenCalled();
  });

  // C2: an admin grant can land between the order and the transfer. Reporting a transfer for a book
  // the reader already owns is the reader paying for it twice.
  it("refuses to report a transfer for a book the reader already owns", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: true });
    await expect(claimTransferAction("vi", ORDER_ID, new FormData())).rejects.toThrow(
      new RegExp(`NEXT_REDIRECT /vi/checkout/${ORDER_ID}$`),
    );
    expect(claimManualTransfer).not.toHaveBeenCalled();
  });

  it("sends the reader to the status page when the order is no longer pending", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, status: "completed", paymentStatus: "succeeded" });
    await expect(claimTransferAction("vi", ORDER_ID, new FormData())).rejects.toThrow(
      `NEXT_REDIRECT /vi/checkout/${ORDER_ID}/status`,
    );
    expect(claimManualTransfer).not.toHaveBeenCalled();
  });
});
