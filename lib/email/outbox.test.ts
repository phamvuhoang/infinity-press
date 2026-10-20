// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { deliverNotificationBatch } from "@/lib/email/outbox";
import { MailProviderError, type MailMessage, type MailProvider } from "@/lib/email/provider";

type Result = { data: unknown; error: unknown };
type Call = [string, unknown[]];
type Query = { table: string; calls: Call[] };

const LEASE = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "req_outbox_test_1234";
const SITE = "https://books.example.com";
const FROM = "Infinity Books <books@example.com>";

type Fixture = {
  entitlements: Record<string, { id: string; book_id: string; profile_id: string; status: string } | null>;
  profiles: Record<string, { display_name: string | null; locale: string } | null>;
  // The oldest verified email per profile, exactly what the ordered/filtered query would return.
  identities: Record<string, string | null>;
  // "<book_id>/<locale>" -> published title in that locale.
  titles: Record<string, string>;
  gifts: Record<
    string,
    { id: string; order_id: string; purchaser_profile_id: string; recipient_email: string; message: string | null; status: string } | null
  >;
  // order_id -> the order's lines, exactly as order_items holds them (sparse positions, and a
  // bundle may repeat a book across two lines).
  orderItems: Record<string, { book_id: string; title_snapshot: string; position: number }[]>;
  // idea_id -> its localizations, with the parent idea's status (the inner join the query filters on).
  ideaLocalizations?: Record<string, { locale: string; slug: string; question: string; status: string }[]>;
  // question_id -> the locale the reader asked in.
  questions?: Record<string, { locale: string }>;
  // review_id -> the review as the worker selects it.
  reviews?: Record<string, { id: string; book_id: string; profile_id: string; status: string; author_reply: string | null; rating: number; body: string; locale: string } | null>;
  failTables?: Set<string>;
};

function eqValue(calls: Call[], column: string): unknown {
  return calls.find(([method, args]) => method === "eq" && args[0] === column)?.[1][1];
}

// A recording Supabase stand-in. Each `from()` returns a builder that records every call and, when
// awaited, answers from the fixture using the recorded `.eq()` filters.
function recordingClient(options: {
  claimed: unknown[];
  fixture: Fixture;
  complete?: (id: string) => Result;
  fail?: (id: string) => Result;
  claimResult?: Result;
}) {
  const queries: Query[] = [];
  // The outbox LIFECYCLE rpcs - claim, complete, fail - whose order and arguments the tests below
  // assert positionally.
  const rpcCalls: [string, Record<string, unknown>][] = [];
  // Data reads that happen to be rpcs rather than table selects, kept apart so that adding one
  // does not renumber every lifecycle assertion. gift_delivery_details is here because
  // public.gifts is granted to nobody and cannot be selected at all.
  const dataRpcCalls: [string, Record<string, unknown>][] = [];

  function resolve(query: Query): Result {
    const { table, calls } = query;
    if (options.fixture.failTables?.has(table)) return { data: null, error: { code: "XX000", message: "boom" } };
    if (table === "entitlements") {
      return { data: options.fixture.entitlements[eqValue(calls, "id") as string] ?? null, error: null };
    }
    if (table === "profiles") {
      return { data: options.fixture.profiles[eqValue(calls, "id") as string] ?? null, error: null };
    }
    if (table === "customer_identities") {
      const email = options.fixture.identities[eqValue(calls, "profile_id") as string];
      return { data: email ? { normalized_email: email } : null, error: null };
    }
    if (table === "order_items") {
      const rows = options.fixture.orderItems[eqValue(calls, "order_id") as string] ?? [];
      return { data: [...rows].sort((left, right) => left.position - right.position), error: null };
    }
    // The review branch reads every published localization of the book and picks one itself.
    if (table === "book_localizations" && eqValue(calls, "locale") === undefined) {
      const bookId = eqValue(calls, "book_id") as string;
      const published = eqValue(calls, "books.status") === "published";
      const rows = Object.entries(options.fixture.titles)
        .filter(([key]) => published && key.startsWith(`${bookId}/`))
        .map(([key, title]) => ({ locale: key.slice(bookId.length + 1), title, books: { status: "published" } }));
      return { data: rows, error: null };
    }
    if (table === "book_localizations") {
      const key = `${eqValue(calls, "book_id")}/${eqValue(calls, "locale")}`;
      const published = eqValue(calls, "books.status") === "published";
      const title = options.fixture.titles[key];
      return { data: published && title ? { title, books: { status: "published" } } : null, error: null };
    }
    if (table === "reader_questions") {
      return { data: options.fixture.questions?.[eqValue(calls, "id") as string] ?? null, error: null };
    }
    if (table === "idea_localizations") {
      const published = eqValue(calls, "ideas.status") === "published";
      const rows = (options.fixture.ideaLocalizations?.[eqValue(calls, "idea_id") as string] ?? [])
        .filter((row) => !published || row.status === "published")
        .map(({ status, ...row }) => ({ ...row, ideas: { status } }));
      return { data: rows, error: null };
    }
    if (table === "book_reviews") {
      return { data: options.fixture.reviews?.[eqValue(calls, "id") as string] ?? null, error: null };
    }
    throw new Error(`unexpected table ${table}`);
  }

  const client = {
    from(table: string) {
      const query: Query = { table, calls: [] };
      queries.push(query);
      const proxy: unknown = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") {
              return (onFulfilled: (value: Result) => unknown, onRejected: (reason: unknown) => unknown) =>
                Promise.resolve(resolve(query)).then(onFulfilled, onRejected);
            }
            return (...args: unknown[]) => {
              query.calls.push([String(property), args]);
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "gift_delivery_details") {
        dataRpcCalls.push([name, args]);
        if (options.fixture.failTables?.has("gifts")) return { data: null, error: { code: "42501", message: "denied" } };
        const gift = options.fixture.gifts[args.p_gift_id as string] ?? null;
        return { data: gift ? [gift] : [], error: null };
      }
      rpcCalls.push([name, args]);
      if (name === "claim_notification_outbox") return options.claimResult ?? { data: options.claimed, error: null };
      if (name === "complete_notification_outbox") {
        return options.complete?.(args.p_id as string) ?? { data: true, error: null };
      }
      if (name === "fail_notification_outbox") return options.fail?.(args.p_id as string) ?? { data: true, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
  };

  return { client, queries, rpcCalls, dataRpcCalls };
}

function recordingProvider(behavior: (message: MailMessage) => Promise<{ messageId: string }>) {
  const sent: MailMessage[] = [];
  const provider: MailProvider = {
    async send(message) {
      sent.push(message);
      return behavior(message);
    },
  };
  return { provider, sent };
}

function outboxRow(n: number) {
  return {
    id: `outbox-${n}`,
    entitlement_id: `ent-${n}`,
    profile_id: `profile-${n}`,
    gift_id: null,
    review_id: null,
    template_key: "book_ready",
    payload: null,
    attempt_count: 0,
    delivery_generation: 0,
  };
}

// A gift_claim row, exactly as claim_notification_outbox returns one: no entitlement, no profile,
// and the protected claim path in the payload. The path carries the locale the purchaser chose,
// which is the locale the recipient's message is rendered in.
function giftRow(n: number, generation = 0) {
  return {
    id: `outbox-${n}`,
    entitlement_id: null,
    profile_id: null,
    gift_id: `gift-${n}`,
    review_id: null,
    template_key: "gift_claim",
    payload: { claimPath: "/vi/gifts/claim/secret-token-value" },
    attempt_count: 0,
    delivery_generation: generation,
  };
}

const IDEA_ID = "00000000-0000-4000-8000-0000000000a1";

// A question_answered row, as claim_notification_outbox returns one: no entitlement, no gift.
function questionRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `outbox-${n}`,
    entitlement_id: null,
    profile_id: `profile-${n}`,
    gift_id: null,
    question_id: `question-${n}`,
    review_id: null,
    template_key: "question_answered",
    payload: { ideaId: IDEA_ID },
    attempt_count: 0,
    delivery_generation: 0,
    ...overrides,
  };
}

const BOOK_ID = "00000000-0000-4000-8000-0000000000b1";

// A review_replied row, as claim_notification_outbox returns one: the review and the reviewer.
function reviewRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `outbox-${n}`,
    entitlement_id: null,
    profile_id: `profile-${n}`,
    gift_id: null,
    question_id: null,
    review_id: `review-${n}`,
    template_key: "review_replied",
    payload: { bookId: BOOK_ID },
    attempt_count: 0,
    delivery_generation: 0,
    ...overrides,
  };
}

function baseFixture(): Fixture {
  return {
    reviews: {
      "review-2": { id: "review-2", book_id: BOOK_ID, profile_id: "profile-2", status: "published", author_reply: "Cảm ơn bạn đã đọc.", rating: 5, body: "Cuốn sách rất hay.", locale: "vi" },
    },
    questions: { "question-2": { locale: "vi" }, "question-3": { locale: "en" } },
    ideaLocalizations: {
      [IDEA_ID]: [
        { locale: "vi", slug: "tai-sao", question: "Tại sao vẫn phải đọc?", status: "published" },
        { locale: "en", slug: "why", question: "Why still read?", status: "published" },
      ],
    },
    entitlements: {
      "ent-1": { id: "ent-1", book_id: "book-1", profile_id: "profile-1", status: "active" },
      "ent-2": { id: "ent-2", book_id: "book-2", profile_id: "profile-2", status: "active" },
    },
    profiles: {
      "profile-1": { display_name: "Ada", locale: "en" },
      "profile-2": { display_name: null, locale: "vi" },
    },
    identities: { "profile-1": "ada@example.com", "profile-2": "minh@example.com" },
    titles: { "book-1/en": "Deep Work", "book-1/vi": "Làm việc sâu", "book-2/vi": "Nhà giả kim", [`${BOOK_ID}/vi`]: "Sách S15" },
    gifts: {
      "gift-1": {
        id: "gift-1",
        order_id: "order-1",
        purchaser_profile_id: "profile-1",
        recipient_email: "friend@example.com",
        message: "Chúc mừng sinh nhật!",
        status: "sent",
      },
      "gift-3": {
        id: "gift-3",
        order_id: "order-3",
        purchaser_profile_id: "profile-1",
        recipient_email: "other@example.com",
        message: null,
        status: "sent",
      },
    },
    orderItems: {
      "order-1": [{ book_id: "book-2", title_snapshot: "Nhà giả kim", position: 1 }],
      "order-3": [{ book_id: "book-1", title_snapshot: "Deep Work", position: 1 }],
    },
  };
}

async function run(client: unknown, provider: MailProvider, limit?: number) {
  return deliverNotificationBatch({
    client: client as Parameters<typeof deliverNotificationBatch>[0]["client"],
    provider,
    siteUrl: SITE,
    from: FROM,
    leaseToken: LEASE,
    requestId: REQUEST_ID,
    ...(limit === undefined ? {} : { limit }),
  });
}

let logSpies: MockInstance[];

beforeEach(() => {
  logSpies = [
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function allLogText(): string {
  return JSON.stringify(logSpies.flatMap((spy) => spy.mock.calls));
}

describe("deliverNotificationBatch", () => {
  it("claims at most 25 rows with the owning lease token", async () => {
    const { client, rpcCalls } = recordingClient({ claimed: [], fixture: baseFixture() });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    await expect(run(client, provider)).resolves.toEqual({ claimed: 0, sent: 0, failed: 0, leaseLost: 0 });
    await run(client, provider, 500);
    await run(client, provider, 3);

    expect(rpcCalls).toEqual([
      ["claim_notification_outbox", { p_limit: 25, p_lease_token: LEASE }],
      ["claim_notification_outbox", { p_limit: 25, p_lease_token: LEASE }],
      ["claim_notification_outbox", { p_limit: 3, p_lease_token: LEASE }],
    ]);
  });

  it("resolves delivery data and sends the localized message with an outbox idempotency key", async () => {
    const { client, queries, rpcCalls } = recordingClient({ claimed: [outboxRow(1), outboxRow(2)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async (message) => ({ messageId: `msg-${message.to}` }));

    const result = await run(client, provider);

    expect(result).toEqual({ claimed: 2, sent: 2, failed: 0, leaseLost: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      from: FROM,
      to: "ada@example.com",
      subject: "Your book is ready: Deep Work",
      idempotencyKey: "book-ready/outbox-1",
    });
    expect(sent[0].html).toContain('href="https://books.example.com/en/library"');
    expect(sent[1]).toMatchObject({
      to: "minh@example.com",
      subject: "Sách của bạn đã sẵn sàng: Nhà giả kim",
      idempotencyKey: "book-ready/outbox-2",
    });
    expect(sent[1].text).toContain("https://books.example.com/vi/library");

    expect(rpcCalls.slice(1)).toEqual([
      ["complete_notification_outbox", { p_id: "outbox-1", p_lease_token: LEASE, p_provider_message_id: "msg-ada@example.com" }],
      ["complete_notification_outbox", { p_id: "outbox-2", p_lease_token: LEASE, p_provider_message_id: "msg-minh@example.com" }],
    ]);

    // The security-relevant filters: the current entitlement, the profile's oldest verified
    // email, and only a published localization in the profile's own locale.
    const byTable = (table: string) => queries.find((query) => query.table === table)!.calls;
    expect(byTable("entitlements")).toContainEqual(["eq", ["id", "ent-1"]]);
    expect(byTable("profiles")).toContainEqual(["eq", ["id", "profile-1"]]);
    const identity = byTable("customer_identities");
    expect(identity).toContainEqual(["eq", ["profile_id", "profile-1"]]);
    expect(identity).toContainEqual(["not", ["verified_at", "is", null]]);
    expect(identity.filter(([method]) => method === "order")).toEqual([
      ["order", ["verified_at", { ascending: true }]],
      ["order", ["created_at", { ascending: true }]],
      ["order", ["id", { ascending: true }]],
    ]);
    expect(identity).toContainEqual(["limit", [1]]);
    const title = byTable("book_localizations");
    expect(title).toContainEqual(["eq", ["book_id", "book-1"]]);
    expect(title).toContainEqual(["eq", ["locale", "en"]]);
    expect(title).toContainEqual(["eq", ["books.status", "published"]]);
  });

  it("uses generic copy rather than another locale's title", async () => {
    const fixture = baseFixture();
    fixture.titles = { "book-2/en": "The Alchemist" };
    const { client } = recordingClient({ claimed: [outboxRow(2)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await run(client, provider);

    expect(sent[0].subject).toBe("Cuốn sách mới của bạn đã sẵn sàng");
    expect(sent[0].text).not.toContain("Alchemist");
    expect(sent[0].html).not.toContain("Alchemist");
    expect(sent[0].html).toContain('href="https://books.example.com/vi/library"');
  });

  it("releases an entitlement that is no longer active without sending", async () => {
    const fixture = baseFixture();
    fixture.entitlements["ent-1"] = { id: "ent-1", book_id: "book-1", profile_id: "profile-1", status: "revoked" };
    const { client, rpcCalls } = recordingClient({ claimed: [outboxRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    const result = await run(client, provider);

    expect(sent).toHaveLength(0);
    expect(result).toEqual({ claimed: 1, sent: 0, failed: 1, leaseLost: 0 });
    expect(rpcCalls[1]).toEqual([
      "fail_notification_outbox",
      { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: "entitlement_inactive" },
    ]);
  });

  it.each([
    ["no verified identity", (f: Fixture) => void (f.identities["profile-1"] = null), "recipient_unverified"],
    ["a missing profile", (f: Fixture) => void (f.profiles["profile-1"] = null), "profile_not_found"],
    ["a missing entitlement", (f: Fixture) => void (f.entitlements["ent-1"] = null), "entitlement_inactive"],
    ["a database read error", (f: Fixture) => void (f.failTables = new Set(["profiles"])), "delivery_data_unavailable"],
  ])("fails the row with a safe code for %s", async (_label, mutate, code) => {
    const fixture = baseFixture();
    mutate(fixture);
    const { client, rpcCalls } = recordingClient({ claimed: [outboxRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    const result = await run(client, provider);

    expect(sent).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(rpcCalls[1]).toEqual(["fail_notification_outbox", { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: code }]);
  });

  it("records the provider's safe code and keeps going after a failed row", async () => {
    const { client, rpcCalls } = recordingClient({ claimed: [outboxRow(1), outboxRow(2)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async (message) => {
      if (message.to === "ada@example.com") {
        throw new MailProviderError("resend_http_422", "Resend said: invalid recipient ada@example.com");
      }
      return { messageId: "msg-2" };
    });

    const result = await run(client, provider);

    expect(sent).toHaveLength(2);
    expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, leaseLost: 0 });
    expect(rpcCalls.slice(1)).toEqual([
      ["fail_notification_outbox", { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: "resend_http_422" }],
      ["complete_notification_outbox", { p_id: "outbox-2", p_lease_token: LEASE, p_provider_message_id: "msg-2" }],
    ]);
  });

  it("maps an unexpected provider exception to a generic safe code", async () => {
    const { client, rpcCalls } = recordingClient({ claimed: [outboxRow(1)], fixture: baseFixture() });
    const { provider } = recordingProvider(async () => {
      throw new Error("socket hang up: secret provider detail");
    });

    await run(client, provider);

    expect(rpcCalls[1]).toEqual([
      "fail_notification_outbox",
      { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: "provider_error" },
    ]);
  });

  it("truncates an over-long error code and provider message id to the column limits", async () => {
    const longCode = "x".repeat(150);
    const longId = "m".repeat(300);
    const { client, rpcCalls } = recordingClient({ claimed: [outboxRow(1), outboxRow(2)], fixture: baseFixture() });
    const { provider } = recordingProvider(async (message) => {
      if (message.to === "ada@example.com") throw new MailProviderError(longCode, "nope");
      return { messageId: longId };
    });

    await run(client, provider);

    expect(rpcCalls[1][1].p_error_code).toBe("x".repeat(100));
    expect(rpcCalls[2][1].p_provider_message_id).toBe("m".repeat(200));
  });

  it("counts a lost lease without throwing", async () => {
    const { client } = recordingClient({
      claimed: [outboxRow(1), outboxRow(2)],
      fixture: baseFixture(),
      complete: (id) => ({ data: id !== "outbox-1", error: null }),
    });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    const result = await run(client, provider);

    expect(result).toEqual({ claimed: 2, sent: 1, failed: 0, leaseLost: 1 });
    expect(allLogText()).toContain("outbox-1");
  });

  it("counts a lost lease on the failure path too", async () => {
    const fixture = baseFixture();
    fixture.identities["profile-1"] = null;
    const { client } = recordingClient({ claimed: [outboxRow(1)], fixture, fail: () => ({ data: false, error: null }) });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    await expect(run(client, provider)).resolves.toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 1 });
  });

  it("keeps going when a completion or failure RPC errors", async () => {
    const fixture = baseFixture();
    fixture.identities["profile-2"] = null;
    const { client, rpcCalls } = recordingClient({
      claimed: [outboxRow(1), outboxRow(2)],
      fixture,
      complete: () => ({ data: null, error: { code: "57014", message: "timeout" } }),
      fail: () => ({ data: null, error: { code: "57014", message: "timeout" } }),
    });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    const result = await run(client, provider);

    expect(result).toEqual({ claimed: 2, sent: 0, failed: 2, leaseLost: 0 });
    expect(rpcCalls.map(([name]) => name)).toEqual([
      "claim_notification_outbox",
      "complete_notification_outbox",
      "fail_notification_outbox",
    ]);
  });

  // ------------------------------------------------------------------------------------------
  // Gift delivery (S9 spec 7.2). A gift row carries no entitlement and no profile: the recipient
  // is gifts.recipient_email, and the claim link is rebuilt from the protected payload.

  // The provider holds an idempotency key for 24 hours and requires a distinct key per distinct
  // request. An admin resend and an admin reissue both rewind the SAME outbox row, so a key built
  // from the row id alone repeated across them: a resend was folded into the original request and
  // the recipient got nothing, and a reissue - new address, new claim link, same key - was
  // rejected outright and then burned the row's six attempts. Only those two admin actions bump
  // notification_outbox.delivery_generation; a worker retry leaves it alone.
  it("mints a new idempotency key after an admin resend or reissue", async () => {
    const { client } = recordingClient({ claimed: [giftRow(1, 2)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "gift-msg-1" }));

    await run(client, provider);

    expect(sent[0].idempotencyKey).toBe("gift-claim/outbox-1/2");
  });

  // Generation 0 keeps the original spelling, so a row already in flight when this shipped keeps
  // the key its earlier attempts used and nothing is sent twice across the upgrade.
  it("keeps the original key spelling for a delivery no admin has touched", async () => {
    const { client } = recordingClient({ claimed: [giftRow(1)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "gift-msg-1" }));

    await run(client, provider);

    expect(sent[0].idempotencyKey).toBe("gift-claim/outbox-1");
  });

  it("sends a gift row to the gift address with the claim link and an outbox idempotency key", async () => {
    const { client, queries, rpcCalls, dataRpcCalls } = recordingClient({ claimed: [giftRow(1)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "gift-msg-1" }));

    const result = await run(client, provider);

    expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, leaseLost: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: FROM,
      to: "friend@example.com",
      // The payload path is /vi/..., so the message is Vietnamese and the link it carries is the
      // same path made absolute against the site URL.
      subject: "Ada đã gửi tặng bạn một món quà trên Infinity Books",
      idempotencyKey: "gift-claim/outbox-1",
    });
    expect(sent[0].html).toContain('href="https://books.example.com/vi/gifts/claim/secret-token-value"');
    expect(sent[0].text).toContain("https://books.example.com/vi/gifts/claim/secret-token-value");
    expect(sent[0].text).toContain("Chúc mừng sinh nhật!");
    expect(sent[0].text).toContain("Nhà giả kim");

    // The reads a gift delivery is allowed to make, and the filters that make them safe.
    const byTable = (table: string) => queries.find((query) => query.table === table)!.calls;
    // The gift itself comes from the definer RPC, BY NAME. public.gifts is granted to nobody, so a
    // select on it is refused at planning time and the row would burn all six attempts instead.
    expect(dataRpcCalls).toEqual([["gift_delivery_details", { p_gift_id: "gift-1" }]]);
    expect(queries.map((query) => query.table)).not.toContain("gifts");
    expect(byTable("profiles")).toContainEqual(["eq", ["id", "profile-1"]]);
    expect(byTable("order_items")).toContainEqual(["eq", ["order_id", "order-1"]]);
    // No entitlement and no customer_identities read: the recipient may not have an account at all.
    expect(queries.map((query) => query.table)).not.toContain("entitlements");
    expect(queries.map((query) => query.table)).not.toContain("customer_identities");

    expect(rpcCalls[1]).toEqual([
      "complete_notification_outbox",
      { p_id: "outbox-1", p_lease_token: LEASE, p_provider_message_id: "gift-msg-1" },
    ]);
  });

  it("lists every distinct book of a bundle gift in the shop's order", async () => {
    const fixture = baseFixture();
    fixture.orderItems["order-1"] = [
      { book_id: "book-b", title_snapshot: "Second", position: 4 },
      { book_id: "book-a", title_snapshot: "First", position: 2 },
      // The same book on two lines is one piece of access, exactly as claim_gift treats it.
      { book_id: "book-a", title_snapshot: "First", position: 7 },
    ];
    const { client } = recordingClient({ claimed: [giftRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await run(client, provider);

    expect(sent[0].html).toContain("<ul><li>First</li><li>Second</li></ul>");
  });

  it("uses generic copy when the purchaser has no display name", async () => {
    const fixture = baseFixture();
    fixture.profiles["profile-1"] = { display_name: null, locale: "en" };
    const { client } = recordingClient({ claimed: [giftRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await run(client, provider);

    expect(sent[0].subject).toBe("Bạn được tặng một món quà trên Infinity Books");
  });

  // The purchaser's profile is a courtesy, not a precondition: a missing one costs the name, not
  // the gift. The purchaser's own locale is irrelevant - the message follows the claim path.
  it("still sends when the purchaser profile cannot be found", async () => {
    const fixture = baseFixture();
    fixture.profiles["profile-1"] = null;
    const { client } = recordingClient({ claimed: [giftRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await expect(run(client, provider)).resolves.toMatchObject({ sent: 1, failed: 0 });
    expect(sent[0].subject).toBe("Bạn được tặng một món quà trên Infinity Books");
  });

  it.each([
    ["a gift that is no longer sendable", (f: Fixture) => void (f.gifts["gift-1"]!.status = "claimed"), "gift_not_sendable"],
    ["a missing gift", (f: Fixture) => void (f.gifts["gift-1"] = null), "gift_not_found"],
    ["a database read error", (f: Fixture) => void (f.failTables = new Set(["gifts"])), "delivery_data_unavailable"],
    ["an order-items read error", (f: Fixture) => void (f.failTables = new Set(["order_items"])), "delivery_data_unavailable"],
  ])("fails a gift row with a safe code for %s", async (_label, mutate, code) => {
    const fixture = baseFixture();
    mutate(fixture);
    const { client, rpcCalls } = recordingClient({ claimed: [giftRow(1)], fixture });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    const result = await run(client, provider);

    expect(sent).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(rpcCalls[1]).toEqual(["fail_notification_outbox", { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: code }]);
  });

  // claim_gift nulls the payload the moment the gift is claimed. A row whose delivery already
  // completed is never claimed again, so that clearing cannot unsend anything; a row that is still
  // pending has nothing left to build a link from and must refuse rather than send a broken one.
  it.each([
    ["a null payload", null],
    ["a payload with no claim path", { somethingElse: true }],
    ["a payload whose claim path is not a string", { claimPath: 42 }],
    ["a payload whose claim path is not site-relative", { claimPath: "https://evil.test/steal" }],
    ["a payload whose claim path has no locale", { claimPath: "/gifts/claim/tok" }],
  ])("fails a gift row with a safe code for %s", async (_label, payload) => {
    const { client, rpcCalls } = recordingClient({
      claimed: [{ ...giftRow(1), payload }],
      fixture: baseFixture(),
    });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await run(client, provider);

    expect(sent).toHaveLength(0);
    expect(rpcCalls[1]).toEqual([
      "fail_notification_outbox",
      { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: "gift_payload_invalid" },
    ]);
  });

  it("fails a row whose template the worker does not know", async () => {
    const { client, rpcCalls } = recordingClient({
      claimed: [{ ...giftRow(1), template_key: "something_new" }],
      fixture: baseFixture(),
    });
    const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

    await run(client, provider);

    expect(sent).toHaveLength(0);
    expect(rpcCalls[1]).toEqual([
      "fail_notification_outbox",
      { p_id: "outbox-1", p_lease_token: LEASE, p_error_code: "unsupported_template" },
    ]);
  });

  it("delivers gift and book_ready rows side by side in one batch", async () => {
    const { client, rpcCalls } = recordingClient({ claimed: [giftRow(3), outboxRow(1)], fixture: baseFixture() });
    const { provider, sent } = recordingProvider(async (message) => ({ messageId: `msg-${message.to}` }));

    const result = await run(client, provider);

    expect(result).toEqual({ claimed: 2, sent: 2, failed: 0, leaseLost: 0 });
    expect(sent.map((message) => message.to)).toEqual(["other@example.com", "ada@example.com"]);
    expect(sent[0].idempotencyKey).toBe("gift-claim/outbox-3");
    expect(sent[1].idempotencyKey).toBe("book-ready/outbox-1");
    expect(rpcCalls.map(([name]) => name)).toEqual([
      "claim_notification_outbox",
      "complete_notification_outbox",
      "complete_notification_outbox",
    ]);
  });

  it("counts a lost lease on a gift row without throwing", async () => {
    const { client } = recordingClient({
      claimed: [giftRow(1)],
      fixture: baseFixture(),
      complete: () => ({ data: false, error: null }),
    });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    await expect(run(client, provider)).resolves.toEqual({ claimed: 1, sent: 0, failed: 0, leaseLost: 1 });
  });

  it("never logs the claim path, the recipient address, the message or the gift id", async () => {
    const fixture = baseFixture();
    const { client } = recordingClient({ claimed: [giftRow(1)], fixture });
    const { provider } = recordingProvider(async () => {
      throw new MailProviderError("resend_http_422", "Resend said: invalid recipient friend@example.com");
    });

    await run(client, provider);

    const logs = allLogText();
    expect(logs).toContain(REQUEST_ID);
    expect(logs).toContain("outbox-1");
    expect(logs).toContain("resend_http_422");
    expect(logs).not.toContain("secret-token-value");
    expect(logs).not.toContain("claimPath");
    expect(logs).not.toContain("gift-1");
    expect(logs).not.toContain("friend@example.com");
    expect(logs).not.toContain("Chúc mừng");
    expect(logs).not.toContain("Nhà giả kim");
    expect(logs).not.toContain("Resend said");
  });

  it("throws a safe error when the claim itself fails", async () => {
    const { client } = recordingClient({
      claimed: [],
      fixture: baseFixture(),
      claimResult: { data: null, error: { code: "42501", message: "permission denied for function" } },
    });
    const { provider } = recordingProvider(async () => ({ messageId: "m" }));

    await expect(run(client, provider)).rejects.toThrow("Notification outbox claim failed.");
    expect(allLogText()).toContain(REQUEST_ID);
  });

  it("logs request and outbox ids but never the recipient email or provider text", async () => {
    const { client } = recordingClient({ claimed: [outboxRow(1), outboxRow(2)], fixture: baseFixture() });
    const { provider } = recordingProvider(async (message) => {
      if (message.to === "ada@example.com") {
        throw new MailProviderError("resend_http_422", "Resend said: invalid recipient ada@example.com");
      }
      return { messageId: "msg-2" };
    });

    await run(client, provider);

    const logs = allLogText();
    expect(logs).toContain(REQUEST_ID);
    expect(logs).toContain("outbox-1");
    expect(logs).toContain("outbox-2");
    expect(logs).toContain("resend_http_422");
    expect(logs).not.toContain("ada@example.com");
    expect(logs).not.toContain("minh@example.com");
    expect(logs).not.toContain("Resend said");
    expect(logs).not.toContain("Deep Work");
  });

  describe("question_answered", () => {
    async function runOne(row: unknown, mutate?: (fixture: Fixture) => void) {
      const fixture = baseFixture();
      mutate?.(fixture);
      const { client, rpcCalls } = recordingClient({ claimed: [row], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));
      const result = await run(client, provider);
      return { result, rpcCalls, sent };
    }

    it("sends to the verified address with the idea link in the profile locale and an outbox key", async () => {
      const { result, sent } = await runOne(questionRow(2, { delivery_generation: 2 }));

      expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, leaseLost: 0 });
      expect(sent[0]).toMatchObject({
        to: "minh@example.com",
        subject: "Tác giả đã trả lời câu hỏi của bạn",
        idempotencyKey: "question-answered/outbox-2/2",
      });
      expect(sent[0].text).toContain("https://books.example.com/vi/ideas/tai-sao");
      expect(sent[0].text).toContain("Tại sao vẫn phải đọc?");
    });

    it("keeps the plain key spelling for generation 0", async () => {
      const { sent } = await runOne(questionRow(2));
      expect(sent[0].idempotencyKey).toBe("question-answered/outbox-2");
    });

    it("uses the question's locale, not the profile's, when both localizations exist", async () => {
      // profile-2 is vi; the question was asked in en.
      const { sent } = await runOne(questionRow(2, { question_id: "question-3" }));
      expect(sent[0].text).toContain("https://books.example.com/en/ideas/why");
      expect(sent[0].subject).toBe("The author answered your question");
      expect(sent[0].text).toContain("Why still read?");
    });

    it("fails with question_not_found when the question row is gone", async () => {
      const { sent, rpcCalls } = await runOne(questionRow(2, { question_id: "question-gone" }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "question_not_found" });
    });

    it("links the other locale's localization when the question locale has none", async () => {
      const { sent } = await runOne(questionRow(2), (f) => {
        f.ideaLocalizations![IDEA_ID] = f.ideaLocalizations![IDEA_ID].filter((l) => l.locale === "en");
      });
      expect(sent[0].text).toContain("https://books.example.com/en/ideas/why");
      expect(sent[0].subject).toBe("The author answered your question");
    });

    it("fails with recipient_unverified when there is no verified identity, and the batch continues", async () => {
      const fixture = baseFixture();
      fixture.identities["profile-2"] = null;
      const { client, rpcCalls } = recordingClient({ claimed: [questionRow(2), outboxRow(1)], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));

      const result = await run(client, provider);

      expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, leaseLost: 0 });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe("ada@example.com");
      expect(rpcCalls[1]).toEqual([
        "fail_notification_outbox",
        { p_id: "outbox-2", p_lease_token: LEASE, p_error_code: "recipient_unverified" },
      ]);
    });

    it("never emails a link to an idea that is no longer published", async () => {
      const { result, rpcCalls, sent } = await runOne(questionRow(2), (f) => {
        f.ideaLocalizations![IDEA_ID] = f.ideaLocalizations![IDEA_ID].map((l) => ({ ...l, status: "draft" }));
      });
      expect(sent).toHaveLength(0);
      expect(result.failed).toBe(1);
      expect(rpcCalls[1]).toEqual([
        "fail_notification_outbox",
        { p_id: "outbox-2", p_lease_token: LEASE, p_error_code: "unsupported_locale" },
      ]);
    });

    it("fails when the idea has no localization at all", async () => {
      const { sent, rpcCalls } = await runOne(questionRow(2), (f) => void (f.ideaLocalizations = {}));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "unsupported_locale" });
    });

    it.each([
      ["a missing ideaId", {}],
      ["a non-string ideaId", { ideaId: 7 }],
      ["a malformed ideaId", { ideaId: "not-a-uuid" }],
      ["36 dashes", { ideaId: "-".repeat(36) }],
      ["an array payload", [IDEA_ID]],
    ])("fails with question_payload_invalid for %s", async (_name, payload) => {
      const { sent, rpcCalls } = await runOne(questionRow(2, { payload }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "question_payload_invalid" });
    });

    it.each([
      ["question_id", { question_id: null }],
      ["profile_id", { profile_id: null }],
      ["payload", { payload: null }],
    ])("fails with unsupported_template when %s is missing", async (_name, overrides) => {
      const { sent, rpcCalls } = await runOne(questionRow(2, overrides));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "unsupported_template" });
    });

    it("fails with delivery_data_unavailable when the localization read errors", async () => {
      const { rpcCalls } = await runOne(questionRow(2), (f) => void (f.failTables = new Set(["idea_localizations"])));
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "delivery_data_unavailable" });
    });
  });

  describe("review_replied", () => {
    async function runOne(row: unknown, mutate?: (fixture: Fixture) => void) {
      const fixture = baseFixture();
      mutate?.(fixture);
      const { client, rpcCalls } = recordingClient({ claimed: [row], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));
      const result = await run(client, provider);
      return { result, rpcCalls, sent };
    }

    it("sends the current reply to the verified address in the review's locale with the review link", async () => {
      const { result, sent } = await runOne(reviewRow(2, { delivery_generation: 1 }));
      expect(result).toEqual({ claimed: 1, sent: 1, failed: 0, leaseLost: 0 });
      expect(sent[0]).toMatchObject({
        to: "minh@example.com",
        subject: "Tác giả đã phản hồi đánh giá của bạn về “Sách S15”",
        idempotencyKey: "review-replied/outbox-2/1",
      });
      expect(sent[0].text).toContain("Cảm ơn bạn đã đọc.");
      expect(sent[0].text).toContain(`https://books.example.com/vi/library/reviews/${BOOK_ID}`);
    });

    it("reads the reply at send time, so an edit before delivery is what goes out", async () => {
      const { sent } = await runOne(reviewRow(2), (f) => {
        f.reviews!["review-2"]!.author_reply = "Cảm ơn bạn đã đọc kỹ.";
      });
      expect(sent[0].text).toContain("Cảm ơn bạn đã đọc kỹ.");
      expect(sent[0].text).not.toContain("Cảm ơn bạn đã đọc.\n");
    });

    // The review page 404s without a localization in the link's locale, so the email follows the
    // locale that has one, as question_answered does.
    it("links and writes in the other locale when the review's locale has no localization", async () => {
      const { sent } = await runOne(reviewRow(2), (f) => {
        delete f.titles[`${BOOK_ID}/vi`];
        f.titles[`${BOOK_ID}/en`] = "Book S15";
      });
      expect(sent[0].subject).toBe("The author replied to your review of “Book S15”");
      expect(sent[0].text).toContain(`https://books.example.com/en/library/reviews/${BOOK_ID}`);
    });

    it("fails with book_not_visible when the book has no published localization, so no 404 link is mailed", async () => {
      const { sent, rpcCalls } = await runOne(reviewRow(2), (f) => void delete f.titles[`${BOOK_ID}/vi`]);
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "book_not_visible" });
    });

    it.each([
      ["unpublished", { status: "pending" }],
      ["cleared", { author_reply: null }],
    ])("fails with review_not_visible when the review is %s by send time", async (_name, patch) => {
      const { sent, rpcCalls } = await runOne(reviewRow(2), (f) => Object.assign(f.reviews!["review-2"]!, patch));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][0]).toBe("fail_notification_outbox");
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_not_visible" });
    });

    it("fails with review_not_found when the review row is gone", async () => {
      const { sent, rpcCalls } = await runOne(reviewRow(2, { review_id: "review-gone" }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_not_found" });
    });

    it("fails with recipient_unverified and continues the batch", async () => {
      const fixture = baseFixture();
      fixture.identities["profile-2"] = null;
      const { client, rpcCalls } = recordingClient({ claimed: [reviewRow(2), outboxRow(1)], fixture });
      const { provider, sent } = recordingProvider(async () => ({ messageId: "m" }));
      const result = await run(client, provider);
      expect(result).toEqual({ claimed: 2, sent: 1, failed: 1, leaseLost: 0 });
      expect(rpcCalls[1][1]).toMatchObject({ p_id: "outbox-2", p_error_code: "recipient_unverified" });
      expect(sent[0].to).toBe("ada@example.com");
    });

    it.each([
      ["missing bookId", {}],
      ["non-uuid bookId", { bookId: "nope" }],
    ])("fails with review_payload_invalid for %s", async (_name, payload) => {
      const { sent, rpcCalls } = await runOne(reviewRow(2, { payload }));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "review_payload_invalid" });
    });

    it.each([
      ["review_id", { review_id: null }],
      ["profile_id", { profile_id: null }],
      ["payload", { payload: null }],
    ])("fails with unsupported_template when %s is missing", async (_name, overrides) => {
      const { sent, rpcCalls } = await runOne(reviewRow(2, overrides));
      expect(sent).toHaveLength(0);
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "unsupported_template" });
    });

    it("fails with delivery_data_unavailable when the review read errors", async () => {
      const { rpcCalls } = await runOne(reviewRow(2), (f) => void (f.failTables = new Set(["book_reviews"])));
      expect(rpcCalls[1][1]).toMatchObject({ p_error_code: "delivery_data_unavailable" });
    });

    it("never logs the reply, the body, or the address", async () => {
      await runOne(reviewRow(2));
      const logged = logSpies.flatMap((spy) => spy.mock.calls.flat()).map((v) => JSON.stringify(v)).join("\n");
      expect(logged).not.toContain("Cảm ơn");
      expect(logged).not.toContain("minh@example.com");
    });
  });
});
