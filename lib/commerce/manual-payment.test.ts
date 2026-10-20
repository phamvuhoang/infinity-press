// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError } from "@/lib/commerce/errors";
import {
  AmountMismatchError,
  claimManualTransfer,
  confirmManualPayment,
  type ConfirmManualPaymentInput,
  DuplicateBankReferenceError,
  MissingBankReferenceError,
  MissingDeclineReasonError,
  NotAClaimableOrderError,
  NotAPendingManualOrderError,
  rejectManualPayment,
} from "@/lib/commerce/manual-payment";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const orderId = "70000000-0000-0000-0000-000000000001";

// Mirrors lib/access/grant.test.ts's `.rpc(name, args)` resolves-once mocking pattern.
function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc } as unknown as Awaited<ReturnType<typeof createClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(requireUser).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireUser>>);
});

describe("claimManualTransfer", () => {
  // Ruling AO (matching grant.ts): a reader-facing mutation - gated on requireUser, never requireAdmin.
  it("never constructs a Supabase client when the sign-in gate denies", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(claimManualTransfer("en", orderId, null)).rejects.toThrow("NEXT_REDIRECT");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls claim_manual_transfer through the session client with the order id and note", async () => {
    const client = rpcClient({ data: "2026-09-21T00:00:00Z", error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await claimManualTransfer("en", orderId, "transferred at 3pm");

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("claim_manual_transfer", {
      p_order_id: orderId,
      p_note: "transferred at 3pm",
    });
  });

  it("maps EB020 to NotAClaimableOrderError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB020", message: "not the caller's own pending manual order" } }),
    );

    await expect(claimManualTransfer("en", orderId, null)).rejects.toBeInstanceOf(NotAClaimableOrderError);
  });

  // claim_manual_transfer's own first check (supabase/migrations/20260922120000_manual_transfer_claims.sql):
  // no profile exists yet for the current session. The reader sees the same "not claimable" outcome
  // as EB020 - there is nothing else useful to tell them apart on this call.
  it("maps P0002 to NotAClaimableOrderError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "P0002", message: "no profile for the current session" } }),
    );

    await expect(claimManualTransfer("en", orderId, null)).rejects.toBeInstanceOf(NotAClaimableOrderError);
  });

  // EB017 is its own class, not NotAClaimableOrderError: "you already own this book" and "this
  // order cannot be claimed" lead the reader to different places.
  it("maps EB017 to AlreadyOwnedError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB017", message: "the reader already owns the book" } }),
    );

    await expect(claimManualTransfer("en", orderId, null)).rejects.toBeInstanceOf(AlreadyOwnedError);
  });

  it("does not guess an error class for an unrecognized failure", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code: "XXYYY", message: "boom" } }));

    const error = await claimManualTransfer("en", orderId, null).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(NotAClaimableOrderError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("claimManualTransfer");
    expect((error as Error).message).toContain("claim_manual_transfer");
  });
});

describe("confirmManualPayment", () => {
  const input: ConfirmManualPaymentInput = {
    receivedAmountMinor: 129000,
    expectedAmountMinor: 129000,
    bankReference: "VCB-1",
    note: null,
    acceptMismatch: false,
  };

  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(confirmManualPayment(orderId, input)).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls confirm_manual_payment through the session client with the RPC's parameter names", async () => {
    const client = rpcClient({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await confirmManualPayment(orderId, input);

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("confirm_manual_payment", {
      p_order_id: orderId,
      p_received_amount_minor: input.receivedAmountMinor,
      p_bank_reference: input.bankReference,
      p_note: input.note,
      p_accept_mismatch: input.acceptMismatch,
    });
  });

  // The caller (Task 10) already holds the order, so the expected total travels with the call
  // rather than being parsed back out of the database's error message.
  it("maps EB021 to an AmountMismatchError carrying both amounts", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB021", message: "received 100000 but the order total is 129000" } }),
    );

    await expect(
      confirmManualPayment("order-1", {
        receivedAmountMinor: 100000,
        expectedAmountMinor: 129000,
        bankReference: "VCB-1",
        note: null,
        acceptMismatch: false,
      }),
    ).rejects.toMatchObject({ name: "AmountMismatchError", receivedMinor: 100000, expectedMinor: 129000 });
  });

  it("maps EB043 to DuplicateBankReferenceError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB043", message: "bank reference already used on another order" } }),
    );
    await expect(confirmManualPayment(orderId, input)).rejects.toBeInstanceOf(DuplicateBankReferenceError);
  });

  it("maps EB022 to NotAPendingManualOrderError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB022", message: "order is not a manual order" } }),
    );

    await expect(confirmManualPayment(orderId, input)).rejects.toBeInstanceOf(NotAPendingManualOrderError);
  });

  it("maps 22023 to MissingBankReferenceError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "22023", message: "a bank reference is required" } }),
    );

    await expect(confirmManualPayment(orderId, input)).rejects.toBeInstanceOf(MissingBankReferenceError);
  });

  it("does not guess an error class for an unrecognized failure", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code: "XXYYY", message: "boom" } }));

    const error = await confirmManualPayment(orderId, input).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AmountMismatchError);
    expect(error).not.toBeInstanceOf(NotAPendingManualOrderError);
    expect(error).not.toBeInstanceOf(MissingBankReferenceError);
    expect((error as Error).message).toContain("confirmManualPayment");
    expect((error as Error).message).toContain("confirm_manual_payment");
  });
});

describe("rejectManualPayment", () => {
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(rejectManualPayment(orderId, "Funds never arrived", "not_received")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls reject_manual_payment through the session client with the reason and outcome", async () => {
    const client = rpcClient({ data: null, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await rejectManualPayment(orderId, "Buyer asked to cancel", "cancel");

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("reject_manual_payment", {
      p_order_id: orderId,
      p_reason: "Buyer asked to cancel",
      p_outcome: "cancel",
    });
  });

  it("maps EB022 to NotAPendingManualOrderError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB022", message: "order is not a pending manual order" } }),
    );

    await expect(rejectManualPayment(orderId, "Funds never arrived", "not_received")).rejects.toBeInstanceOf(
      NotAPendingManualOrderError,
    );
  });

  it("maps 22023 to MissingDeclineReasonError", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "22023", message: "a reason is required" } }),
    );

    await expect(rejectManualPayment(orderId, "", "cancel")).rejects.toBeInstanceOf(MissingDeclineReasonError);
  });

  // The UI only ever sends "not_received" or "cancel" (DeclineOutcome), so EB023 can only reach
  // this wrapper if that constraint is broken elsewhere - it must surface loudly, not be papered
  // over with a named error class the UI would otherwise treat as an expected, recoverable state.
  it("maps EB023 to an ordinary Error, because the UI never sends an unknown outcome", async () => {
    vi.mocked(createClient).mockResolvedValue(
      rpcClient({ data: null, error: { code: "EB023", message: "unknown outcome" } }),
    );

    const error = await rejectManualPayment(orderId, "Funds never arrived", "cancel").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NotAPendingManualOrderError);
    expect(error).not.toBeInstanceOf(MissingDeclineReasonError);
    expect((error as Error).name).toBe("Error");
    expect((error as Error).message).toContain("rejectManualPayment");
    expect((error as Error).message).toContain("reject_manual_payment");
  });
});
