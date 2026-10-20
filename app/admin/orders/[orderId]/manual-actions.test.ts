// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { confirmManualPaymentAction, declineManualPaymentAction } from "@/app/admin/orders/[orderId]/manual-actions";
import { requireAdmin } from "@/lib/auth/admin";
import { AmountMismatchError, DuplicateBankReferenceError, NotAPendingManualOrderError, confirmManualPayment, rejectManualPayment } from "@/lib/commerce/manual-payment";
import { type AdminOrderDTO, getAdminOrder } from "@/lib/data/admin-orders";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/data/admin-orders", () => ({ getAdminOrder: vi.fn() }));
vi.mock("@/lib/commerce/manual-payment", () => {
  class AmountMismatchError extends Error {
    constructor(
      readonly receivedMinor: number,
      readonly expectedMinor: number,
    ) {
      super("mismatch");
    }
  }
  class NotAPendingManualOrderError extends Error {}
  class DuplicateBankReferenceError extends Error {}
  return {
    confirmManualPayment: vi.fn(),
    rejectManualPayment: vi.fn(),
    AmountMismatchError,
    NotAPendingManualOrderError,
    DuplicateBankReferenceError,
  };
});

const { revalidatePath } = await import("next/cache");

const ORDER_ID = "order-1";

const order = { totalMinor: 129000, currency: "VND" } as AdminOrderDTO;

function formDataOf(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(getAdminOrder).mockResolvedValue(order);
});

describe("confirmManualPaymentAction", () => {
  it("gates on requireAdmin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(
      confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "129000", reference: "VCB-1" })),
    ).rejects.toThrow("NEXT_FORBIDDEN");
    expect(confirmManualPayment).not.toHaveBeenCalled();
  });

  it("requires a bank reference", async () => {
    const state = await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "129000" }));
    expect(state).toEqual({ status: "error", message: "Enter the bank transaction reference." });
    expect(confirmManualPayment).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount before calling the RPC", async () => {
    const state = await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "129000.50", reference: "VCB-1" }),
    );
    expect(state).toEqual({ status: "error", message: "Enter the received amount in the order's currency, without rounding." });
    expect(confirmManualPayment).not.toHaveBeenCalled();
  });

  it("rejects a negative amount", async () => {
    const state = await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "-1", reference: "VCB-1" }));
    expect(state).toEqual({ status: "error", message: "Enter the received amount in the order's currency, without rounding." });
    expect(confirmManualPayment).not.toHaveBeenCalled();
  });

  it("confirms with the order total as the expected amount and a trimmed note", async () => {
    vi.mocked(confirmManualPayment).mockResolvedValue(undefined);
    const state = await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "129000", reference: " VCB-1 ", note: "  Matches the statement  " }),
    );
    expect(state).toEqual({ status: "done" });
    expect(confirmManualPayment).toHaveBeenCalledWith(ORDER_ID, {
      receivedAmountMinor: 129000,
      expectedAmountMinor: 129000,
      bankReference: "VCB-1",
      note: "Matches the statement",
      acceptMismatch: false,
    });
  });

  it("sends null for an empty note", async () => {
    vi.mocked(confirmManualPayment).mockResolvedValue(undefined);
    await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "129000", reference: "VCB-1" }));
    expect(confirmManualPayment).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ note: null }));
  });

  it("returns a mismatch state instead of an error, so the form can offer an override", async () => {
    vi.mocked(confirmManualPayment).mockRejectedValue(new AmountMismatchError(100000, 129000));
    const state = await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "100000", reference: "VCB-1" }),
    );
    expect(state).toEqual({ status: "mismatch", receivedMinor: 100000, expectedMinor: 129000 });
  });

  it("passes the override through when the admin ticks it", async () => {
    vi.mocked(confirmManualPayment).mockResolvedValue(undefined);
    await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "100000", reference: "VCB-1", "accept-mismatch": "on" }),
    );
    expect(confirmManualPayment).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ acceptMismatch: true }));
  });

  it("explains when the order is no longer a pending manual payment", async () => {
    vi.mocked(confirmManualPayment).mockRejectedValue(new NotAPendingManualOrderError());
    const state = await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "129000", reference: "VCB-1" }),
    );
    expect(state).toEqual({ status: "error", message: "This order is no longer awaiting a transfer." });
  });

  it("hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(confirmManualPayment).mockRejectedValue(new Error("secret detail"));
    const state = await confirmManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ amount: "129000", reference: "VCB-1" }),
    );
    expect(state).toEqual({ status: "error", message: "Something went wrong. Try again." });
  });

  it("revalidates the order page and the queue after a decision", async () => {
    vi.mocked(confirmManualPayment).mockResolvedValue(undefined);
    await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "129000", reference: "VCB-1" }));
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/orders/${ORDER_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/payments");
  });
});

describe("declineManualPaymentAction", () => {
  it("gates on requireAdmin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(
      declineManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ reason: "No transfer found", outcome: "not_received" })),
    ).rejects.toThrow("NEXT_FORBIDDEN");
    expect(rejectManualPayment).not.toHaveBeenCalled();
  });

  it("requires a reason before declining", async () => {
    const state = await declineManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ outcome: "not_received" }));
    expect(state).toEqual({ status: "error", message: "Enter a reason before declining." });
    expect(rejectManualPayment).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized outcome", async () => {
    const state = await declineManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ reason: "No transfer found", outcome: "something-else" }),
    );
    expect(state).toEqual({ status: "error", message: "Something went wrong. Try again." });
    expect(rejectManualPayment).not.toHaveBeenCalled();
  });

  it("declines with the trimmed reason and chosen outcome", async () => {
    vi.mocked(rejectManualPayment).mockResolvedValue(undefined);
    const state = await declineManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ reason: "  No transfer found  ", outcome: "cancel" }),
    );
    expect(state).toEqual({ status: "done" });
    expect(rejectManualPayment).toHaveBeenCalledWith(ORDER_ID, "No transfer found", "cancel");
  });

  it("explains when the order is no longer a pending manual payment", async () => {
    vi.mocked(rejectManualPayment).mockRejectedValue(new NotAPendingManualOrderError());
    const state = await declineManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ reason: "No transfer found", outcome: "not_received" }),
    );
    expect(state).toEqual({ status: "error", message: "This order is no longer awaiting a transfer." });
  });

  it("hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(rejectManualPayment).mockRejectedValue(new Error("secret detail"));
    const state = await declineManualPaymentAction(
      ORDER_ID,
      { status: "idle" },
      formDataOf({ reason: "No transfer found", outcome: "not_received" }),
    );
    expect(state).toEqual({ status: "error", message: "Something went wrong. Try again." });
  });

  it("revalidates the order page and the queue after a decision", async () => {
    vi.mocked(rejectManualPayment).mockResolvedValue(undefined);
    await declineManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ reason: "No transfer found", outcome: "not_received" }));
    expect(revalidatePath).toHaveBeenCalledWith(`/admin/orders/${ORDER_ID}`);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/payments");
  });
});

describe("confirmManualPaymentAction in a currency with a minor unit", () => {
  it("reads the typed amount in major units, exactly", async () => {
    vi.mocked(getAdminOrder).mockResolvedValue({ totalMinor: 1999, currency: "USD" } as AdminOrderDTO);
    await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "19.99", reference: "REF-1" }));
    expect(confirmManualPayment).toHaveBeenCalledWith(ORDER_ID, expect.objectContaining({ receivedAmountMinor: 1999, expectedAmountMinor: 1999 }));
  });

  it("refuses a fraction the currency cannot hold", async () => {
    vi.mocked(getAdminOrder).mockResolvedValue({ totalMinor: 500, currency: "JPY" } as AdminOrderDTO);
    const state = await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "500.5", reference: "REF-1" }));
    expect(state.status).toBe("error");
    expect(confirmManualPayment).not.toHaveBeenCalled();
  });
});

describe("confirmManualPaymentAction with a reference already used", () => {
  it("says so instead of a generic failure", async () => {
    vi.mocked(confirmManualPayment).mockRejectedValue(new DuplicateBankReferenceError());
    const state = await confirmManualPaymentAction(ORDER_ID, { status: "idle" }, formDataOf({ amount: "129000", reference: "VCB-1" }));
    expect(state).toEqual({ status: "error", message: "That bank reference is already recorded on another order." });
  });
});
