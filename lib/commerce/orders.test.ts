// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createBundleOrder, createEbookOrder } from "@/lib/commerce/orders";
import { getServerEnv } from "@/lib/config/server-env";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const BUNDLE_ID = "40000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";

function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "simulator" } as ReturnType<typeof getServerEnv>);
});

describe("createEbookOrder", () => {
  it("gates on the signed-in user before anything else", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow("NEXT_REDIRECT");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses without calling the RPC when the app gate is off", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "disabled" } as ReturnType<typeof getServerEnv>);
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow(PaymentsDisabledError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the order ID from create_ebook_order", async () => {
    const rpc = rpcClient({ data: ORDER_ID, error: null });
    await expect(createEbookOrder("en", BOOK_ID)).resolves.toEqual({ orderId: ORDER_ID });
    expect(rpc).toHaveBeenCalledWith("create_ebook_order", { p_book_id: BOOK_ID });
  });

  it.each([
    ["EB005", EmailNotVerifiedError],
    ["EB011", PaymentsDisabledError],
    ["EB012", NotPurchasableError],
    ["EB013", AlreadyOwnedError],
  ] as const)("maps %s to a typed error", async (code, ErrorClass) => {
    rpcClient({ data: null, error: { code, message: "x" } });
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow(ErrorClass);
  });

  it("throws a plain error for anything else", async () => {
    rpcClient({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow("createEbookOrder: create_ebook_order failed");
  });
});

describe("createBundleOrder", () => {
  it("gates on the signed-in user before anything else", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(createBundleOrder("en", BUNDLE_ID)).rejects.toThrow("NEXT_REDIRECT");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses without calling the RPC when the app gate is off", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "disabled" } as ReturnType<typeof getServerEnv>);
    await expect(createBundleOrder("en", BUNDLE_ID)).rejects.toThrow(PaymentsDisabledError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the order ID from create_bundle_order", async () => {
    const rpc = rpcClient({ data: ORDER_ID, error: null });
    await expect(createBundleOrder("en", BUNDLE_ID)).resolves.toEqual({ orderId: ORDER_ID });
    expect(rpc).toHaveBeenCalledWith("create_bundle_order", { p_bundle_id: BUNDLE_ID });
  });

  // EB027 is the bundle's EB012: not published, no live offer, or nothing left to sell. The buy
  // action shows the same "cannot be bought right now" message for all three.
  it.each([
    ["EB005", EmailNotVerifiedError],
    ["EB011", PaymentsDisabledError],
    ["EB027", NotPurchasableError],
    ["EB013", AlreadyOwnedError],
  ] as const)("maps %s to a typed error", async (code, ErrorClass) => {
    rpcClient({ data: null, error: { code, message: "x" } });
    await expect(createBundleOrder("en", BUNDLE_ID)).rejects.toThrow(ErrorClass);
  });

  it("throws a plain error for anything else", async () => {
    rpcClient({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(createBundleOrder("en", BUNDLE_ID)).rejects.toThrow("createBundleOrder: create_bundle_order failed");
  });

  it("throws when the RPC returns no order id", async () => {
    rpcClient({ data: null, error: null });
    await expect(createBundleOrder("en", BUNDLE_ID)).rejects.toThrow("returned no order id");
  });
});
