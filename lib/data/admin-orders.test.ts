// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getAdminOrder, searchAdminOrders } from "@/lib/data/admin-orders";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

const orderRow = {
  id: ORDER_ID,
  profile_id: PROFILE_ID,
  status: "completed",
  payment_status: "succeeded",
  total_minor: 129000,
  currency: "VND",
  created_at: "2026-09-15T00:00:00Z",
  items: [{ book_id: "b1", title_snapshot: "A Book", unit_price_minor: 129000 }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("searchAdminOrders", () => {
  it("blocks before creating a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(searchAdminOrders("an@example.test")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns no rows when no customer email matches", async () => {
    const fake = fakeSupabaseClient({ tables: { customer_identities: { data: [], error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(searchAdminOrders("nobody@example")).resolves.toEqual([]);
    expect(fake.from).not.toHaveBeenCalledWith("orders");
  });

  it("maps orders with customer emails", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        orders: { data: [orderRow], error: null },
        customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(searchAdminOrders(undefined)).resolves.toEqual([
      {
        id: ORDER_ID,
        profileId: PROFILE_ID,
        email: "an@example.test",
        title: "A Book",
        totalMinor: 129000,
        currency: "VND",
        status: "completed",
        paymentStatus: "succeeded",
        createdAt: "2026-09-15T00:00:00Z",
      },
    ]);
  });
});

describe("getAdminOrder", () => {
  it("returns 404 for a non-UUID without a query", async () => {
    await expect(getAdminOrder("order-1")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing order", async () => {
    const fake = fakeSupabaseClient({ tables: { orders: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(getAdminOrder(ORDER_ID)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("assembles payments, events, and the order's entitlement", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        orders: { data: orderRow, error: null },
        payments: {
          data: [{ id: "p1", provider: "simulator", external_payment_id: "sim_pay", status: "succeeded", amount_minor: 129000, currency: "VND", created_at: "2026-09-15T00:00:00Z" }],
          error: null,
        },
        payment_events: {
          data: [{ id: "ev1", provider: "simulator", provider_event_id: "sim_evt_1", received_at: "2026-09-15T00:01:00Z", processed_at: "2026-09-15T00:01:00Z" }],
          error: null,
        },
        entitlements: {
          data: { id: "e1", source_type: "simulated_payment", status: "active", granted_at: "2026-09-15T00:01:00Z", revoked_at: null },
          error: null,
        },
        customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const order = await getAdminOrder(ORDER_ID);
    expect(order).toMatchObject({
      id: ORDER_ID,
      email: "an@example.test",
      item: { bookId: "b1", title: "A Book", unitPriceMinor: 129000 },
      payments: [{ id: "p1", externalPaymentId: "sim_pay", amountMinor: 129000 }],
      events: [{ id: "ev1", providerEventId: "sim_evt_1" }],
      entitlement: { id: "e1", sourceType: "simulated_payment", status: "active" },
      manualClaim: null,
      manualConfirmation: null,
    });
  });

  it("surfaces the reference code, a pending claim, and confirmation evidence for a manual order", async () => {
    const manualOrderRow = {
      ...orderRow,
      reference_code: "IB-ABCDE",
      claims: { claimed_at: "2026-09-16T00:00:00Z", note: "Transferred via Vietcombank" },
      confirmations: {
        received_amount_minor: 129000,
        bank_reference: "VCB-1",
        note: "Matches the statement",
        mismatch_accepted: false,
        confirmed_at: "2026-09-17T00:00:00Z",
      },
    };
    const fake = fakeSupabaseClient({
      tables: {
        orders: { data: manualOrderRow, error: null },
        payments: { data: [], error: null },
        payment_events: { data: [], error: null },
        entitlements: { data: null, error: null },
        customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const order = await getAdminOrder(ORDER_ID);
    expect(order).toMatchObject({
      referenceCode: "IB-ABCDE",
      manualClaim: { claimedAt: "2026-09-16T00:00:00Z", note: "Transferred via Vietcombank" },
      manualConfirmation: {
        receivedAmountMinor: 129000,
        bankReference: "VCB-1",
        note: "Matches the statement",
        mismatchAccepted: false,
        confirmedAt: "2026-09-17T00:00:00Z",
      },
    });
  });
});
