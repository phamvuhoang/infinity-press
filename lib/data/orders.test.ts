// @vitest-environment node
import { headers } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getActiveEntitlementBookIds } from "@/lib/data/catalog";
import { getCustomerOrder, listCustomerOrders } from "@/lib/data/orders";
import { getCurrentProfile } from "@/lib/data/profiles";
import { recordingChain } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/data/catalog", () => ({ getActiveEntitlementBookIds: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const BOOK_ID_2 = "30000000-0000-4000-8000-000000000002";
const BOOK_ID_3 = "30000000-0000-4000-8000-000000000003";
const BUNDLE_ID = "90000000-0000-4000-8000-000000000001";

const row = {
  id: ORDER_ID,
  reference_code: "IB-ABCDE",
  status: "pending",
  payment_status: "failed",
  total_minor: 129000,
  currency: "VND",
  subtotal_minor: 129000,
  discount_minor: 0,
  coupon_code: null,
  created_at: "2026-09-15T00:00:00+00:00",
  bundle_id: null,
  title_snapshot: null,
  items: [{ book_id: BOOK_ID, title_snapshot: "A Book", position: 1 }],
  // The provider is a column on the order, not an embed. A reader cannot read public.payments at
  // all - it carries one policy, "admin reads payments" - so a payments embed comes back empty for
  // the very reader every manual state is rendered for. No `payments` key here on purpose: if the
  // mapping ever reaches for one again, this row makes it null and the assertions below fail.
  payment_provider: "manual",
  claims: null,
  declines: [],
};

function mockOrders(result: { data: unknown; error: unknown }) {
  const recorded = recordingChain(result);
  const from = vi.fn(() => recorded.chain);
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { from, calls: recorded.calls };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID, auth_user_id: "u1", display_name: null, locale: "en" });
  vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set());
  vi.mocked(headers).mockResolvedValue(new Headers() as unknown as Awaited<ReturnType<typeof headers>>);
});

describe("getCustomerOrder", () => {
  it("returns null for a non-UUID without querying", async () => {
    await expect(getCustomerOrder("order-1")).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null when signed out", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue(null);
    await expect(getCustomerOrder(ORDER_ID)).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("filters by the caller's profile and maps the order", async () => {
    const { from, calls } = mockOrders({ data: row, error: null });
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([BOOK_ID]));

    await expect(getCustomerOrder(ORDER_ID)).resolves.toEqual({
      id: ORDER_ID,
      bundleId: null,
      title: "A Book",
      items: [{ bookId: BOOK_ID, title: "A Book", hasActiveEntitlement: true }],
      status: "pending",
      paymentStatus: "failed",
      totalMinor: 129000,
      currency: "VND",
      createdAt: "2026-09-15T00:00:00+00:00",
      hasAllActiveEntitlements: true,
      referenceCode: "IB-ABCDE",
      provider: "manual",
      subtotalMinor: 129000,
      discountMinor: 0,
      couponCode: null,
      claimedAt: null,
      declinedAt: null,
      declineReason: null,
    });
    expect(from).toHaveBeenCalledWith("orders");
    expect(calls).toContainEqual(["eq", ["id", ORDER_ID]]);
    expect(calls).toContainEqual(["eq", ["profile_id", PROFILE_ID]]);
  });

  it("asks for the provider as a column, never as a payments embed", async () => {
    const { calls } = mockOrders({ data: row, error: null });
    await getCustomerOrder(ORDER_ID);
    const columns = calls.find(([method]) => method === "select")![1][0] as string;
    expect(columns).toContain("payment_provider");
    // A reader holds no select on public.payments, so an embed of it silently yields nothing and
    // every manual branch downstream goes dead. The absence is the assertion.
    expect(columns).not.toContain("payments");
  });

  it("returns null when no row matches", async () => {
    mockOrders({ data: null, error: null });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toBeNull();
  });

  it("throws a generic error on a database failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockOrders({ data: null, error: { code: "XX000", message: "secret detail" } });
    await expect(getCustomerOrder(ORDER_ID)).rejects.toThrow("getCustomerOrder failed.");
  });

  it("maps the subtotal, discount, and coupon code when a code was applied", async () => {
    mockOrders({
      data: { ...row, subtotal_minor: 129000, discount_minor: 25800, total_minor: 103200, coupon_code: "TWENTY" },
      error: null,
    });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({
      subtotalMinor: 129000,
      discountMinor: 25800,
      totalMinor: 103200,
      couponCode: "TWENTY",
    });
  });

  it("maps the claim's timestamp when a claim row exists", async () => {
    mockOrders({ data: { ...row, claims: { claimed_at: "2026-09-16T00:00:00+00:00" } }, error: null });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({ claimedAt: "2026-09-16T00:00:00+00:00" });
  });

  // S9 spec 5. The bundle cases below are the reason every field that used to be singular is now a
  // list: an order can hold several books, and reading `items[0]` for any of them would report one
  // arbitrary member of what the reader actually bought.
  const bundleRow = {
    ...row,
    bundle_id: BUNDLE_ID,
    title_snapshot: "The Starter Bundle",
    total_minor: 300000,
    subtotal_minor: 300000,
    // Deliberately out of order, and the price on position 2 rather than position 1: create_bundle_order
    // puts the whole price on the first PUBLISHED member, so position 1 can be missing entirely.
    items: [
      { book_id: BOOK_ID_3, title_snapshot: "Third", position: 3 },
      { book_id: BOOK_ID, title_snapshot: "First", position: 1 },
      { book_id: BOOK_ID_2, title_snapshot: "Second", position: 2 },
    ],
  };

  it("names a bundle order by its own snapshot and carries every member book", async () => {
    mockOrders({ data: bundleRow, error: null });

    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({
      bundleId: BUNDLE_ID,
      title: "The Starter Bundle",
      items: [
        { bookId: BOOK_ID, title: "First", hasActiveEntitlement: false },
        { bookId: BOOK_ID_2, title: "Second", hasActiveEntitlement: false },
        { bookId: BOOK_ID_3, title: "Third", hasActiveEntitlement: false },
      ],
    });
  });

  it("orders the items by the persisted position, in the query and in the mapping", async () => {
    const { calls } = mockOrders({ data: bundleRow, error: null });
    const order = await getCustomerOrder(ORDER_ID);

    // Position is a sparse rank, never a dense index: a bundle whose position-1 member is
    // unpublished ships as 2, 3, so the mapping sorts by it rather than indexing into it.
    expect(order?.items.map((item) => item.title)).toEqual(["First", "Second", "Third"]);
    expect(calls).toContainEqual(["order", ["position", { referencedTable: "order_items" }]]);
  });

  it("reports full ownership only when EVERY member book is held", async () => {
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([BOOK_ID, BOOK_ID_2]));
    mockOrders({ data: bundleRow, error: null });
    const partial = await getCustomerOrder(ORDER_ID);
    expect(partial?.hasAllActiveEntitlements).toBe(false);
    expect(partial?.items.map((item) => item.hasActiveEntitlement)).toEqual([true, true, false]);

    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([BOOK_ID, BOOK_ID_2, BOOK_ID_3]));
    mockOrders({ data: bundleRow, error: null });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({ hasAllActiveEntitlements: true });
  });

  // orders.title_snapshot is non-null exactly for bundle orders, so a single-book order is still
  // named by its one line - the rendering readers have seen since S3 is unchanged.
  it("names a single-book order by its own item", async () => {
    mockOrders({ data: { ...row, title_snapshot: null }, error: null });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({ bundleId: null, title: "A Book" });
  });

  it("takes the decline reason and timestamp with the highest sequence, not the first or last row", async () => {
    // Three rows so "first row", "last row", and "highest sequence" each name a different one -
    // only genuinely comparing sequence can pick "B". The timestamp has to come from that same
    // row: it is what resolveManualTransferState compares a later claim against.
    mockOrders({
      data: {
        ...row,
        declines: [
          { reason: "A", sequence: 1, declined_at: "2026-09-16T00:00:00+00:00" },
          { reason: "B", sequence: 3, declined_at: "2026-09-18T00:00:00+00:00" },
          { reason: "C", sequence: 2, declined_at: "2026-09-17T00:00:00+00:00" },
        ],
      },
      error: null,
    });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toMatchObject({
      declineReason: "B",
      declinedAt: "2026-09-18T00:00:00+00:00",
    });
  });
});

describe("listCustomerOrders", () => {
  it("returns the caller's orders and skips rows without an item", async () => {
    const { calls } = mockOrders({ data: [row, { ...row, id: "other", items: [] }], error: null });
    const orders = await listCustomerOrders();
    expect(orders.map((order) => order.id)).toEqual([ORDER_ID]);
    expect(calls).toContainEqual(["eq", ["profile_id", PROFILE_ID]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
  });

  it("returns an empty list when signed out", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue(null);
    await expect(listCustomerOrders()).resolves.toEqual([]);
  });
});
