// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import {
  acquireFreeOffer,
  applyVerifiedPaymentEvent,
  EmailNotVerifiedError,
  GrantTargetNotFoundError,
  grantComplimentaryEntitlement,
  MissingGrantReasonError,
  MissingRevokeReasonError,
  NoFreeOfferError,
  OrderEntitlementNotFoundError,
  RevocableEntitlementNotFoundError,
  revokeComplimentaryEntitlement,
  revokeOrderEntitlement,
  TargetIdentityNotVerifiedError,
} from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const bookId = "30000000-0000-0000-0000-000000000001";
const profileId = "20000000-0000-0000-0000-000000000001";
const entitlementId = "80000000-0000-0000-0000-000000000001";
const entitlementIds = [entitlementId, "80000000-0000-0000-0000-000000000002"];

// Mirrors createBook's/publishPublication's call shape mocking pattern: `.rpc(name, args)`
// resolves once with {data, error}.
function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { rpc } as unknown as Awaited<ReturnType<typeof createClient>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireAdmin>>);
  vi.mocked(requireUser).mockResolvedValue({} as unknown as Awaited<ReturnType<typeof requireUser>>);
});

describe("acquireFreeOffer", () => {
  // Ruling AO: a customer-facing mutation - gated on requireUser, never requireAdmin.
  it("never constructs a Supabase client when the sign-in gate denies", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(acquireFreeOffer("en", bookId)).rejects.toThrow("NEXT_REDIRECT");
    expect(createClient).not.toHaveBeenCalled();
  });

  // Ruling AO: the profile is derived server-side from auth.uid() inside acquire_free_ebook -
  // this call must never carry a caller-supplied profile id.
  it("calls acquire_free_ebook through the session client with only the book id", async () => {
    const client = rpcClient({ data: entitlementId, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    await acquireFreeOffer("en", bookId);

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("acquire_free_ebook", { p_book_id: bookId });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  // Spec 6.2 point 5 / the brief's idempotency bullet: retrying resolves to the same entitlement.
  it("returns the same entitlement id across repeated calls", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: entitlementId, error: null }));

    const first = await acquireFreeOffer("en", bookId);
    const second = await acquireFreeOffer("en", bookId);

    expect(first).toEqual({ entitlementId });
    expect(second).toEqual({ entitlementId });
  });

  it.each([
    ["EB005", EmailNotVerifiedError],
    ["EB006", NoFreeOfferError],
  ] as const)("maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(acquireFreeOffer("en", bookId)).rejects.toBeInstanceOf(ErrorClass);
  });

  it("does not guess an error class for an unrecognized failure", async () => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code: "XXYYY", message: "boom" } }));

    const error = await acquireFreeOffer("en", bookId).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(EmailNotVerifiedError);
    expect(error).not.toBeInstanceOf(NoFreeOfferError);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("grantComplimentaryEntitlement", () => {
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(grantComplimentaryEntitlement(profileId, bookId, "launch promo")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  // Ruling AO: an admin mutation on the Ruling W pattern - user-session client, not service-role,
  // since grant_complimentary_entitlement's is_admin() check resolves through auth.uid().
  it("calls grant_complimentary_entitlement through the session client and nothing else", async () => {
    const client = rpcClient({ data: entitlementId, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await grantComplimentaryEntitlement(profileId, bookId, "launch promo");

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("grant_complimentary_entitlement", {
      p_profile_id: profileId,
      p_book_id: bookId,
      p_reason: "launch promo",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(result).toEqual({ entitlementId });
  });

  it.each([
    ["22023", MissingGrantReasonError],
    ["P0002", GrantTargetNotFoundError],
    ["EB007", TargetIdentityNotVerifiedError],
  ] as const)("maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(grantComplimentaryEntitlement(profileId, bookId, "")).rejects.toBeInstanceOf(ErrorClass);
  });
});

describe("revokeComplimentaryEntitlement", () => {
  it("never constructs a Supabase client when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(revokeComplimentaryEntitlement(profileId, entitlementId, "campaign ended")).rejects.toThrow(
      "NEXT_FORBIDDEN",
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls the admin-gated revoke RPC with the target profile, entitlement, and reason", async () => {
    const client = rpcClient({ data: entitlementId, error: null });
    vi.mocked(createClient).mockResolvedValue(client);

    const result = await revokeComplimentaryEntitlement(profileId, entitlementId, "campaign ended");

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("revoke_complimentary_entitlement", {
      p_profile_id: profileId,
      p_entitlement_id: entitlementId,
      p_reason: "campaign ended",
    });
    expect(createAdminClient).not.toHaveBeenCalled();
    expect(result).toEqual({ entitlementId });
  });

  it.each([
    ["22023", MissingRevokeReasonError],
    ["P0002", RevocableEntitlementNotFoundError],
  ] as const)("maps %s to %s", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));

    await expect(revokeComplimentaryEntitlement(profileId, entitlementId, "")).rejects.toBeInstanceOf(ErrorClass);
  });
});

describe("revokeOrderEntitlement", () => {
  const orderId = "70000000-0000-0000-0000-000000000001";

  it("gates on requireAdmin before creating a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls revoke_order_entitlement with the session client", async () => {
    const client = rpcClient({ data: entitlementIds, error: null });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).resolves.toEqual({ entitlementIds });
    expect(client.rpc).toHaveBeenCalledWith("revoke_order_entitlement", { p_order_id: orderId, p_reason: "Chargeback" });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", MissingRevokeReasonError],
    ["P0002", OrderEntitlementNotFoundError],
  ] as const)("maps %s to a typed error", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).rejects.toThrow(ErrorClass);
  });
});

describe("applyVerifiedPaymentEvent", () => {
  const baseEvent = {
    provider: "simulator",
    eventId: "evt-1",
    externalPaymentId: "pay-1",
    orderId: "70000000-0000-0000-0000-000000000001",
    status: "succeeded" as const,
    amountMinor: 150000,
    currency: "VND",
    occurredAt: "2026-09-12T00:00:00.000Z",
  };

  function adminRpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(result);
    return { rpc } as unknown as ReturnType<typeof createAdminClient>;
  }

  // Ruling AO: reached with no session at all - never gated on requireAdmin/requireUser, and
  // always the service-role client, never the session client.
  it("never calls requireAdmin or requireUser, and uses the service-role client", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminRpcClient({ data: [{ entitlement_ids: entitlementIds, order_status: "completed", payment_status: "succeeded" }], error: null }),
    );

    await applyVerifiedPaymentEvent(baseEvent);

    expect(requireAdmin).not.toHaveBeenCalled();
    expect(requireUser).not.toHaveBeenCalled();
    expect(createAdminClient).toHaveBeenCalledTimes(1);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("maps event fields onto apply_payment_event's parameters", async () => {
    const client = adminRpcClient({
      data: [{ entitlement_ids: entitlementIds, order_status: "completed", payment_status: "succeeded" }],
      error: null,
    });
    vi.mocked(createAdminClient).mockReturnValue(client);

    await applyVerifiedPaymentEvent(baseEvent);

    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("apply_payment_event", {
      p_provider: baseEvent.provider,
      p_provider_event_id: baseEvent.eventId,
      p_order_id: baseEvent.orderId,
      p_external_payment_id: baseEvent.externalPaymentId,
      p_status: baseEvent.status,
      p_amount_minor: baseEvent.amountMinor,
      p_currency: baseEvent.currency,
      p_occurred_at: baseEvent.occurredAt,
    });
  });

  // The brief's idempotency bullet: a duplicated success event resolves to the same entitlements -
  // pinned at the app layer as "the same row the database already returns is relayed verbatim".
  it("relays the same entitlement ids when the same event outcome is returned twice", async () => {
    const row = { entitlement_ids: entitlementIds, order_status: "completed", payment_status: "succeeded" };
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: [row], error: null }));

    const first = await applyVerifiedPaymentEvent(baseEvent);
    const second = await applyVerifiedPaymentEvent(baseEvent);

    expect(first).toEqual({ entitlementIds, orderStatus: "completed", paymentStatus: "succeeded" });
    expect(second).toEqual({ entitlementIds, orderStatus: "completed", paymentStatus: "succeeded" });
  });

  // S9 spec 5: one order may hold several books, so a success relays every entitlement it granted
  // rather than an arbitrary one of them.
  it("relays every entitlement of a multi-book order", async () => {
    const row = { entitlement_ids: entitlementIds, order_status: "completed", payment_status: "succeeded" };
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: [row], error: null }));

    await expect(applyVerifiedPaymentEvent(baseEvent)).resolves.toMatchObject({ entitlementIds });
  });

  // Failure/cancellation never grant access - the database returns an empty array, and a null
  // (which PostgREST can still produce for an empty set) must land as an empty array rather than
  // reaching a caller that iterates it.
  it.each(["failed", "cancelled"] as const)("relays no entitlement ids for a %s event", async (status) => {
    const row = { entitlement_ids: [], order_status: status === "cancelled" ? "cancelled" : "pending", payment_status: status };
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: [row], error: null }));

    const result = await applyVerifiedPaymentEvent({ ...baseEvent, status });

    expect(result.entitlementIds).toEqual([]);
  });

  // S9 spec 7.2: a completed GIFT order grants the BUYER nothing, so a success can legitimately
  // carry an empty array. The wrapper must relay that rather than treat 'completed with nothing'
  // as a contract break - the recipient's access is created later, by claim_gift.
  it("relays an empty entitlement array for a completed gift order", async () => {
    const row = { entitlement_ids: [], order_status: "completed", payment_status: "succeeded" };
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: [row], error: null }));

    await expect(applyVerifiedPaymentEvent(baseEvent)).resolves.toEqual({
      entitlementIds: [],
      orderStatus: "completed",
      paymentStatus: "succeeded",
    });
  });

  it("relays a null entitlement array as an empty one", async () => {
    const row = { entitlement_ids: null, order_status: "pending", payment_status: "failed" };
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: [row], error: null }));

    await expect(applyVerifiedPaymentEvent(baseEvent)).resolves.toMatchObject({ entitlementIds: [] });
  });

  it("throws when apply_payment_event reports an error", async () => {
    vi.mocked(createAdminClient).mockReturnValue(
      adminRpcClient({ data: null, error: { code: "P0002", message: "order does not exist" } }),
    );

    await expect(applyVerifiedPaymentEvent(baseEvent)).rejects.toThrow();
  });

  it.each(["P0002", "EB004", "EB016"])("maps RPC code %s to PaymentEventRejectedError", async (code) => {
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: null, error: { code, message: "x" } }));
    await expect(applyVerifiedPaymentEvent(baseEvent)).rejects.toThrow(PaymentEventRejectedError);
  });
});
