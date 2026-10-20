// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { loadOperationsSnapshot, MAX_ROWS_PER_RULE } from "@/lib/data/operations";
import { recordingChain } from "@/lib/data/supabase-test-client";
import type { Database } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

// The outbox is read in TWO reads, not one (S9 Task 10, controller ruling R10): PostgREST cannot
// express "inner-join entitlements OR gift_id is not null" in a single select, and a gift row has
// entitlement_id IS NULL, so the pre-existing `entitlements!inner` query drops every gift row
// unconditionally. Before this fix a jammed gift delivery burned its six attempts in silence: the
// purchaser had paid, the recipient never heard, and no finding was ever raised.
//
// The gift half goes through the `stuck_gift_notifications` definer RPC, because public.gifts is
// granted to nobody at all - service_role included - so a `gifts!inner(...)` embed fails at
// planning time with 42501 and can never return a row. These tests cannot see a GRANT (the client
// is a stand-in), which is exactly why supabase/tests/049 invokes that RPC under real roles; what
// they pin here is that the loader calls it BY NAME with the rule's own boundaries, so renaming or
// reshaping it fails loudly rather than silently returning nothing again.
//
// They also pin that the book-ready query is unchanged, filter for filter, because that is what
// makes the addition safe.

const NOW = new Date("2026-09-22T12:00:00.000Z");

type Call = [string, unknown[]];

function fakeClient(outbox: { book: unknown[]; gift: unknown[]; review?: unknown[] }): {
  client: SupabaseClient<Database>;
  outboxCalls: Call[][];
  rpc: ReturnType<typeof vi.fn>;
} {
  const outboxCalls: Call[][] = [];

  const from = vi.fn((table: string) => {
    if (table !== "notification_outbox") return recordingChain({ data: [], error: null }).chain;
    // Answered from the recorded filters at await time: the review branch is the one that
    // filters on the embedded review's status.
    const calls: Call[] = [];
    const result = {
      get data() {
        return calls.some(([name, args]) => name === "eq" && args[0] === "book_reviews.status") ? (outbox.review ?? []) : outbox.book;
      },
      error: null,
    };
    const { chain } = recordingChain(result, calls);
    outboxCalls.push(calls);
    return chain;
  });
  const rpc = vi.fn(async (name: string) =>
    name === "stuck_gift_notifications" ? { data: outbox.gift, error: null } : { data: [], error: null },
  );

  return { client: { from, rpc } as unknown as SupabaseClient<Database>, outboxCalls, rpc };
}

const bookRow = {
  id: "outbox-book",
  profile_id: "profile-7",
  attempt_count: 5,
  lease_expires_at: null,
  sent_at: null,
  created_at: "2026-09-22T09:00:00.000Z",
  entitlements: { status: "active" },
};

// The RPC's own row shape: ids and timestamps, and nothing that could carry a recipient address,
// a claim path or a token.
const giftRow = {
  id: "outbox-gift",
  gift_id: "gift-1",
  order_id: "order-1",
  attempt_count: 6,
  lease_expires_at: null,
  sent_at: null,
  created_at: "2026-09-22T08:00:00.000Z",
};

function filtersOf(calls: Call[]): Record<string, unknown[]> {
  return Object.fromEntries(calls.map(([name, args]) => [`${name}:${String(args[0])}`, args]));
}

describe("loadOperationsSnapshot outbox reads", () => {
  it("returns a stuck gift row, which the entitlement-joined query can never see", async () => {
    const { client } = fakeClient({ book: [], gift: [giftRow] });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox).toEqual([
      {
        id: "outbox-gift",
        profileId: null,
        giftId: "gift-1",
        orderId: "order-1",
        reviewId: null,
        entitlementStatus: null,
        attemptCount: 6,
        leaseExpiresAt: null,
        sentAt: null,
        createdAt: "2026-09-22T08:00:00.000Z",
      },
    ]);
  });

  it("keeps book-ready detection exactly as it was", async () => {
    const { client, outboxCalls } = fakeClient({ book: [bookRow], gift: [] });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox).toEqual([
      {
        id: "outbox-book",
        profileId: "profile-7",
        giftId: null,
        orderId: null,
        reviewId: null,
        entitlementStatus: "active",
        attemptCount: 5,
        leaseExpiresAt: null,
        sentAt: null,
        createdAt: "2026-09-22T09:00:00.000Z",
      },
    ]);

    // The book-ready query's own filters, asserted literally: the inner join on entitlements, the
    // active-only restriction, the attempt floor, and the lease test are what "unchanged" means.
    const [book] = outboxCalls;
    const filters = filtersOf(book);
    expect(filters["select:id, profile_id, attempt_count, lease_expires_at, sent_at, created_at, entitlements!inner(status)"]).toBeDefined();
    expect(filters["is:sent_at"]).toEqual(["sent_at", null]);
    expect(filters["eq:entitlements.status"]).toEqual(["entitlements.status", "active"]);
    expect(filters["gte:attempt_count"]).toEqual(["attempt_count", 4]);
    expect(filters["or:lease_expires_at.is.null,lease_expires_at.lte.2026-09-22T12:00:00.000Z"]).toBeDefined();
    expect(filters["limit:500"]).toEqual([MAX_ROWS_PER_RULE]);
    // Nothing about gifts leaks into it, so it cannot start or stop matching a book row.
    expect(book.some(([, args]) => JSON.stringify(args).includes("gift"))).toBe(false);
  });

  // public.gifts reaches the gift half through a definer RPC and through nothing else. This pins
  // the RPC's name and its three arguments: the defect this replaced was a read that compiled,
  // typed and unit-tested perfectly and was refused by the database on every call.
  it("reads the gift half through the definer RPC, by name, with the rule's own boundaries", async () => {
    const { client, rpc, outboxCalls } = fakeClient({ book: [], gift: [] });

    await loadOperationsSnapshot(client, NOW);

    expect(rpc).toHaveBeenCalledWith("stuck_gift_notifications", {
      p_attempt_floor: 4,
      p_now: NOW.toISOString(),
      p_limit: MAX_ROWS_PER_RULE,
    });
    // Two queries on notification_outbox - the book branch and the review branch (S15) - and none
    // for gifts: the gift half never touches the table.
    expect(outboxCalls).toHaveLength(2);
  });

  it("never embeds public.gifts, which is granted to nobody and refuses the read at planning time", async () => {
    const { client, outboxCalls } = fakeClient({ book: [bookRow], gift: [] });

    await loadOperationsSnapshot(client, NOW);

    expect(outboxCalls.flat().some(([, args]) => JSON.stringify(args).includes("gifts"))).toBe(false);
  });

  it("fails loudly when the RPC is refused rather than reporting an empty gift backlog", async () => {
    const { client, rpc } = fakeClient({ book: [], gift: [] });
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for table gifts" } });

    await expect(loadOperationsSnapshot(client, NOW)).rejects.toThrow(/notification_outbox/);
  });

  it("merges both branches oldest first", async () => {
    const { client } = fakeClient({ book: [bookRow], gift: [giftRow] });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox.map((row) => row.id)).toEqual(["outbox-gift", "outbox-book"]);
  });

  it("caps the merged result overall, so one branch cannot starve the other", async () => {
    const book = Array.from({ length: MAX_ROWS_PER_RULE }, (_, index) => ({
      ...bookRow,
      id: `book-${index}`,
      created_at: "2026-09-22T09:00:00.000Z",
    }));
    const gift = Array.from({ length: MAX_ROWS_PER_RULE }, (_, index) => ({
      ...giftRow,
      id: `gift-${index}`,
      created_at: "2026-09-22T08:00:00.000Z",
    }));
    const { client } = fakeClient({ book, gift });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox).toHaveLength(MAX_ROWS_PER_RULE);
    // Oldest first, so the gift backlog - which is older here - is what survives the cap.
    expect(snapshot.outbox.every((row) => row.giftId !== null)).toBe(true);
  });

  // S15: a review-reply row joins book_reviews (selectable by service_role and admins, unlike
  // gifts), filtered to a published review with a reply - the rows the claim can still hand over.
  it("reads stuck review-reply rows in a third branch, filtered like the claim, merged oldest first", async () => {
    const reviewRow = {
      id: "outbox-review",
      profile_id: "profile-9",
      review_id: "review-1",
      attempt_count: 4,
      lease_expires_at: null,
      sent_at: null,
      created_at: "2026-09-22T07:00:00.000Z",
      book_reviews: { status: "published", author_reply: "Thanks" },
    };
    const { client, outboxCalls } = fakeClient({ book: [bookRow], gift: [giftRow], review: [reviewRow] });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox.map((row) => row.id)).toEqual(["outbox-review", "outbox-gift", "outbox-book"]);
    expect(snapshot.outbox[0]).toEqual({
      id: "outbox-review",
      profileId: "profile-9",
      giftId: null,
      orderId: null,
      reviewId: "review-1",
      entitlementStatus: null,
      attemptCount: 4,
      leaseExpiresAt: null,
      sentAt: null,
      createdAt: "2026-09-22T07:00:00.000Z",
    });
    const review = outboxCalls.find((calls) => calls.some(([name, args]) => name === "eq" && args[0] === "book_reviews.status"));
    const filters = filtersOf(review ?? []);
    expect(filters["eq:book_reviews.status"]).toEqual(["book_reviews.status", "published"]);
    expect(filters["not:book_reviews.author_reply"]).toEqual(["book_reviews.author_reply", "is", null]);
    expect(filters["is:sent_at"]).toEqual(["sent_at", null]);
    expect(filters["gte:attempt_count"]).toEqual(["attempt_count", 4]);
    expect(filters["or:lease_expires_at.is.null,lease_expires_at.lte.2026-09-22T12:00:00.000Z"]).toBeDefined();
  });

  it("drops a book row that names no profile rather than reporting a half-row", async () => {
    const { client } = fakeClient({ book: [{ ...bookRow, profile_id: null }], gift: [] });

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.outbox).toEqual([]);
  });
});

describe("loadOperationsSnapshot reader questions", () => {
  it("reads only new questions, oldest first, capped, and maps them to rows", async () => {
    const sink: Call[] = [];
    const from = vi.fn((table: string) =>
      table === "reader_questions"
        ? recordingChain({ data: [{ id: "q-1", created_at: "2026-10-01T00:00:00.000Z" }], error: null }, sink).chain
        : recordingChain({ data: [], error: null }).chain,
    );
    const client = { from, rpc: vi.fn(async () => ({ data: [], error: null })) } as unknown as SupabaseClient<Database>;

    const snapshot = await loadOperationsSnapshot(client, NOW);

    expect(snapshot.readerQuestions).toEqual([{ id: "q-1", createdAt: "2026-10-01T00:00:00.000Z" }]);
    const filters = filtersOf(sink);
    expect(filters["select:id, created_at"]).toBeDefined();
    expect(filters["eq:status"]).toEqual(["status", "new"]);
    expect(filters["lt:created_at"]).toEqual(["created_at", "2026-09-15T12:00:00.000Z"]);
    expect(filters["order:created_at"]).toEqual(["created_at", { ascending: true }]);
    expect(filters["limit:500"]).toEqual([MAX_ROWS_PER_RULE]);
  });

  it("fails loudly when the read is refused", async () => {
    const from = vi.fn((table: string) =>
      recordingChain(
        table === "reader_questions" ? { data: null, error: { code: "42501" } } : { data: [], error: null },
      ).chain,
    );
    const client = { from, rpc: vi.fn(async () => ({ data: [], error: null })) } as unknown as SupabaseClient<Database>;

    await expect(loadOperationsSnapshot(client, NOW)).rejects.toThrow(/reader_questions/);
  });
});
