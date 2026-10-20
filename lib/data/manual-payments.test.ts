// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { listManualPaymentQueue } from "@/lib/data/manual-payments";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_CLAIMED_RECENT = "70000000-0000-4000-8000-00000000000a";
const ORDER_UNCLAIMED_OLDER = "70000000-0000-4000-8000-00000000000b";
const ORDER_CLAIMED_OLDER = "70000000-0000-4000-8000-00000000000c";

function orderRow(overrides: Record<string, unknown>) {
  return {
    id: "id",
    reference_code: "IB-ABCDE",
    profile_id: PROFILE_ID,
    total_minor: 129000,
    currency: "VND",
    created_at: "2026-09-15T00:00:00Z",
    items: [{ title_snapshot: "A Book" }],
    claims: null as { claimed_at: string; note: string | null } | null,
    ...overrides,
  };
}

// Reads a column the way PostgREST does for an `order` term, including the `embed(column)` form
// that orders top-level rows by a to-one embedded resource.
function columnValue(row: Record<string, unknown>, column: string): unknown {
  const embedded = /^(\w+)\((\w+)\)$/.exec(column);
  if (!embedded) return row[column];
  const child = row[embedded[1]] as Record<string, unknown> | null | undefined;
  return child?.[embedded[2]] ?? null;
}

// A per-table fake client that also records the builder calls made against each table, so a test
// can assert on the reference/email split the way lib/data/admin-orders.test.ts's fake asserts on
// searchAdminOrders' filters.
//
// It applies `.order()` and `.limit()` to the rows it hands back, in that sequence, because the
// sequence is the thing under test: ordering that happens after the limit cannot rescue a row the
// limit already cut. Both behaviours were checked against the running PostgREST (14.13) before
// being modelled here - `order=claims(claimed_at).asc.nullslast,created_at.asc` returns a claimed
// order ahead of older unclaimed ones, and `limit` is applied to that ordering.
function fakeClient(tables: Record<string, { data: unknown; error: unknown }>): {
  client: unknown;
  from: ReturnType<typeof vi.fn>;
  callsFor: (table: string) => [string, unknown[]][];
} {
  const callsByTable = new Map<string, [string, unknown[]][]>();
  const from = vi.fn((table: string) => {
    // Accumulate rather than reset: some tables (customer_identities) are queried more than once
    // per call - a search lookup and then emailsFor's own resolution - and a test must be able to
    // see both.
    const calls = callsByTable.get(table) ?? [];
    callsByTable.set(table, calls);
    const result = tables[table] ?? { data: null, error: null };
    const resolve = (): { data: unknown; error: unknown } => {
      if (!Array.isArray(result.data)) return result;
      let rows = [...(result.data as Record<string, unknown>[])];
      // Sort keys are applied least-significant first, on a stable sort, so that a sequence of
      // .order() calls means what `order=first,second` means: the first call is the primary key.
      const orderCalls = calls.filter(([method]) => method === "order").reverse();
      for (const [, args] of orderCalls) {
        const [column, options] = args as [string, { ascending?: boolean; nullsFirst?: boolean } | undefined];
        const ascending = options?.ascending ?? true;
        const nullsFirst = options?.nullsFirst ?? false;
        rows.sort((a, b) => {
          const left = columnValue(a, column);
          const right = columnValue(b, column);
          if (left === right) return 0;
          if (left === null || left === undefined) return nullsFirst ? -1 : 1;
          if (right === null || right === undefined) return nullsFirst ? 1 : -1;
          return (left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      const limit = calls.findLast(([method]) => method === "limit");
      if (limit) rows = rows.slice(0, limit[1][0] as number);
      return { data: rows, error: result.error };
    };
    const proxy: unknown = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === "then") {
            return (onFulfilled: (value: unknown) => unknown, onRejected: (reason: unknown) => unknown) =>
              Promise.resolve(resolve()).then(onFulfilled, onRejected);
          }
          return (...args: unknown[]) => {
            calls.push([String(property), args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  });
  return { client: { from }, from, callsFor: (table: string) => callsByTable.get(table) ?? [] };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("listManualPaymentQueue", () => {
  it("gates on requireAdmin before creating a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(listManualPaymentQueue()).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("sorts a claimed order before an unclaimed order, even when the unclaimed order is older", async () => {
    const unclaimed = orderRow({
      id: ORDER_UNCLAIMED_OLDER,
      created_at: "2026-09-10T00:00:00Z",
      claims: null,
    });
    const claimed = orderRow({
      id: ORDER_CLAIMED_RECENT,
      created_at: "2026-09-15T00:00:00Z",
      claims: { claimed_at: "2026-09-16T00:00:00Z", note: null },
    });
    const fake = fakeClient({
      orders: { data: [unclaimed, claimed], error: null },
      customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const queue = await listManualPaymentQueue();

    expect(queue.map((item) => item.orderId)).toEqual([ORDER_CLAIMED_RECENT, ORDER_UNCLAIMED_OLDER]);
    expect(queue[0]).toMatchObject({ claimedAt: "2026-09-16T00:00:00Z" });
    expect(queue[1]).toMatchObject({ claimedAt: null });
  });

  it("sorts two claimed orders oldest-claim-first", async () => {
    const claimedRecently = orderRow({
      id: ORDER_CLAIMED_RECENT,
      created_at: "2026-09-10T00:00:00Z",
      claims: { claimed_at: "2026-09-18T00:00:00Z", note: null },
    });
    const claimedEarlier = orderRow({
      id: ORDER_CLAIMED_OLDER,
      created_at: "2026-09-14T00:00:00Z",
      claims: { claimed_at: "2026-09-16T00:00:00Z", note: "transferred yesterday" },
    });
    const fake = fakeClient({
      orders: { data: [claimedRecently, claimedEarlier], error: null },
      customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const queue = await listManualPaymentQueue();

    expect(queue.map((item) => item.orderId)).toEqual([ORDER_CLAIMED_OLDER, ORDER_CLAIMED_RECENT]);
    expect(queue[0]).toMatchObject({ claimNote: "transferred yesterday" });
  });

  // I1. The queue takes 50 rows from the database and then sorts claimed-first in application code.
  // Sorting after cutting is no sort at all: with more than 50 older unclaimed pending orders, a
  // newly claimed one never reaches the sort. The admin is still alerted about the claim - that rule
  // reads manual_transfer_claims directly and is not bounded by this query - and then cannot find
  // the payment here. The row count has to exceed LIMIT for this to fail at all.
  it("shows a newly claimed order even behind a full page of older unclaimed ones", async () => {
    const start = Date.parse("2026-08-01T00:00:00Z");
    const unclaimed = Array.from({ length: 50 }, (_, index) =>
      orderRow({
        id: `70000000-0000-4000-8000-0000000${String(1000 + index)}`,
        created_at: new Date(start + index * 60_000).toISOString(),
        claims: null,
      }),
    );
    const claimed = orderRow({
      id: ORDER_CLAIMED_RECENT,
      created_at: "2026-09-20T00:00:00Z",
      claims: { claimed_at: "2026-09-21T00:00:00Z", note: "paid this morning" },
    });
    const fake = fakeClient({
      orders: { data: [...unclaimed, claimed], error: null },
      customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const queue = await listManualPaymentQueue();

    expect(queue).toHaveLength(50);
    expect(queue[0]).toMatchObject({ orderId: ORDER_CLAIMED_RECENT, claimNote: "paid this morning" });
  });

  // The claimed-first ordering is a term on the query itself, not a step after it. `claims(claimed_at)`
  // is PostgREST's syntax for ordering top-level rows by a to-one embedded resource; nullsFirst
  // false is what puts the unclaimed orders, whose embed is null, behind the claimed ones.
  it("asks the database for the claimed-first ordering, before the limit", async () => {
    const fake = fakeClient({
      orders: { data: [orderRow({ id: ORDER_CLAIMED_RECENT })], error: null },
      customer_identities: { data: [], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await listManualPaymentQueue();

    const methods = fake.callsFor("orders").map(([method]) => method);
    expect(fake.callsFor("orders")).toContainEqual(["order", ["claims(claimed_at)", { ascending: true, nullsFirst: false }]]);
    expect(methods.indexOf("order")).toBeLessThan(methods.indexOf("limit"));
  });

  it("searches reference_code for a query that looks like an order reference", async () => {
    const fake = fakeClient({
      orders: { data: [orderRow({ id: ORDER_CLAIMED_RECENT })], error: null },
      customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await listManualPaymentQueue("ib-abcde");

    expect(fake.callsFor("orders")).toContainEqual(["eq", ["reference_code", "IB-ABCDE"]]);
    // customer_identities is still read to resolve the display email (emailsFor), but never
    // searched by ilike - a reference query narrows the orders table directly.
    expect(fake.callsFor("customer_identities").some(([method]) => method === "ilike")).toBe(false);
  });

  it("searches the customer email for a query that is not an order reference", async () => {
    const fake = fakeClient({
      customer_identities: { data: [{ profile_id: PROFILE_ID }], error: null },
      orders: { data: [orderRow({ id: ORDER_CLAIMED_RECENT })], error: null },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await listManualPaymentQueue("an@example.test");

    expect(fake.callsFor("customer_identities")).toContainEqual(["ilike", ["normalized_email", "%an@example.test%"]]);
    expect(fake.callsFor("orders")).toContainEqual(["in", ["profile_id", [PROFILE_ID]]]);
  });

  it("returns no rows when no customer email matches", async () => {
    const fake = fakeClient({ customer_identities: { data: [], error: null } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    await expect(listManualPaymentQueue("nobody@example.test")).resolves.toEqual([]);
    expect(fake.from).not.toHaveBeenCalledWith("orders");
  });
});
