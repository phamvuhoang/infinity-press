// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { analyticsIntakeLimiter } from "@/lib/analytics/intake-limiter";
import { consumeAnalyticsQuota } from "@/lib/analytics/intake-quota";
import { getServerEnv } from "@/lib/config/server-env";
import { getCurrentProfile } from "@/lib/data/profiles";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEventBestEffort: vi.fn() }));
vi.mock("@/lib/analytics/intake-quota", () => ({
  consumeAnalyticsQuota: vi.fn(),
}));

const SITE = "https://books.example.com";
const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const PUBLICATION_ID = "c0000000-0000-0000-0000-000000000001";
const QUOTE_ID = "90000000-0000-4000-8000-000000000001";
const EVENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PROFILE_ID = "20000000-0000-4000-8000-000000000001";

function env(appEnv = "production") {
  return { appEnv, siteUrl: SITE } as unknown as ReturnType<
    typeof getServerEnv
  >;
}

const CLIENT_IP = "203.0.113.7";

function signIn() {
  vi.mocked(getCurrentProfile).mockResolvedValue({
    id: PROFILE_ID,
    auth_user_id: "auth-1",
    display_name: null,
    locale: "vi",
  });
}

function request(
  body: unknown,
  headers: Record<string, string> = { origin: SITE },
) {
  return new NextRequest(`${SITE}/api/analytics/events`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const viewBook = {
  eventId: EVENT_ID,
  eventName: "view_book",
  bookId: BOOK_ID,
  locale: "en",
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(getCurrentProfile).mockResolvedValue(null);
  vi.mocked(trackEventBestEffort).mockResolvedValue(undefined);
  vi.mocked(consumeAnalyticsQuota).mockResolvedValue("allowed");
});

describe("POST /api/analytics/events", () => {
  it("accepts an anonymous view_book with 202 and returns no inserted data", async () => {
    const response = await POST(request(viewBook));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(trackEventBestEffort).toHaveBeenCalledExactlyOnceWith(
      {
        eventName: "view_book",
        dedupeKey: `client/${EVENT_ID}`,
        bookId: BOOK_ID,
        locale: "en",
      },
      { requestId: expect.any(String) },
    );
  });

  it("accepts click_external_store with a known retailer from an anonymous browser", async () => {
    const response = await POST(
      request({
        eventId: EVENT_ID,
        eventName: "click_external_store",
        bookId: BOOK_ID,
        retailer: "shopee",
        locale: "vi",
      }),
    );

    expect(response.status).toBe(202);
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "click_external_store",
        retailer: "shopee",
        bookId: BOOK_ID,
      }),
      expect.anything(),
    );
  });

  it("accepts an anonymous view_quote with the quote and book ids and nothing else", async () => {
    const response = await POST(
      request({ eventId: EVENT_ID, eventName: "view_quote", sharedQuoteId: QUOTE_ID, bookId: BOOK_ID, locale: "vi" }),
    );

    expect(response.status).toBe(202);
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "view_quote", sharedQuoteId: QUOTE_ID, bookId: BOOK_ID }),
      expect.anything(),
    );
  });

  it("refuses a view_quote carrying the quote text", async () => {
    const response = await POST(
      request({
        eventId: EVENT_ID,
        eventName: "view_quote",
        sharedQuoteId: QUOTE_ID,
        bookId: BOOK_ID,
        locale: "vi",
        quote: "x",
      }),
    );

    expect(response.status).toBe(400);
    expect(trackEventBestEffort).not.toHaveBeenCalled();
  });

  it("refuses click_external_store with an unknown retailer", async () => {
    const response = await POST(
      request({
        eventId: EVENT_ID,
        eventName: "click_external_store",
        bookId: BOOK_ID,
        retailer: "amazon",
        locale: "vi",
      }),
    );

    expect(response.status).toBe(400);
    expect(trackEventBestEffort).not.toHaveBeenCalled();
  });

  it("derives the profile from the session", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue({
      id: PROFILE_ID,
      auth_user_id: "auth-1",
      display_name: null,
      locale: "vi",
    });

    const response = await POST(
      request({ eventId: EVENT_ID, eventName: "view_library", locale: "vi" }),
    );

    expect(response.status).toBe(202);
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      {
        eventName: "view_library",
        dedupeKey: `client/${EVENT_ID}`,
        profileId: PROFILE_ID,
        locale: "vi",
      },
      expect.anything(),
    );
  });

  it("never accepts a profile ID from the body", async () => {
    const response = await POST(
      request({ ...viewBook, profileId: PROFILE_ID }),
    );

    expect(response.status).toBe(400);
    expect(trackEventBestEffort).not.toHaveBeenCalled();
  });

  it("records open_reader with its publication", async () => {
    signIn();
    const response = await POST(
      request({
        eventId: EVENT_ID,
        eventName: "open_reader",
        bookId: BOOK_ID,
        publicationId: PUBLICATION_ID,
        locale: "en",
      }),
    );

    expect(response.status).toBe(202);
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "open_reader",
        bookId: BOOK_ID,
        publicationId: PUBLICATION_ID,
      }),
      expect.anything(),
    );
  });

  it("accepts change_reader_setting without a publication", async () => {
    signIn();
    const response = await POST(
      request({
        eventId: EVENT_ID,
        eventName: "change_reader_setting",
        bookId: BOOK_ID,
        locale: "vi",
      }),
    );
    expect(response.status).toBe(202);
  });

  describe("device class", () => {
    it.each(["mobile", "tablet", "desktop"])(
      "accepts %s from the body",
      async (deviceClass) => {
        const response = await POST(request({ ...viewBook, deviceClass }));

        expect(response.status).toBe(202);
        expect(trackEventBestEffort).toHaveBeenCalledWith(
          expect.objectContaining({ deviceClass }),
          expect.anything(),
        );
      },
    );

    it.each(["phone", "", "MOBILE", 3])("rejects %j", async (deviceClass) => {
      const response = await POST(request({ ...viewBook, deviceClass }));

      expect(response.status).toBe(400);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("never reads, classifies, or stores the user agent", async () => {
      const mobileAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
      const req = request(
        { ...viewBook, deviceClass: "desktop" },
        { origin: SITE, "user-agent": mobileAgent },
      );
      const get = vi.spyOn(req.headers, "get");

      const response = await POST(req);

      expect(response.status).toBe(202);
      for (const [name] of get.mock.calls)
        expect(name.toLowerCase()).not.toBe("user-agent");
      // The body's class wins; the agent string says "mobile" and is ignored entirely.
      const [input] = vi.mocked(trackEventBestEffort).mock.calls[0];
      expect(input.deviceClass).toBe("desktop");
      expect(JSON.stringify(input)).not.toContain("iPhone");
    });

    it("stores no device class when the browser sends none", async () => {
      await POST(
        request(viewBook, { origin: SITE, "user-agent": "Mozilla/5.0 (iPad)" }),
      );

      const [input] = vi.mocked(trackEventBestEffort).mock.calls[0];
      expect(input).not.toHaveProperty("deviceClass");
    });
  });

  describe("origin", () => {
    it("rejects a cross-origin request", async () => {
      const response = await POST(
        request(viewBook, { origin: "https://evil.example" }),
      );

      expect(response.status).toBe(403);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
      expect(getCurrentProfile).not.toHaveBeenCalled();
    });

    it("rejects a missing origin outside local and test", async () => {
      const response = await POST(request(viewBook, {}));
      expect(response.status).toBe(403);
    });

    it.each(["local", "test"])(
      "accepts a missing origin in %s",
      async (appEnv) => {
        vi.mocked(getServerEnv).mockReturnValue(env(appEnv));
        const response = await POST(request(viewBook, {}));
        expect(response.status).toBe(202);
      },
    );

    it("still rejects a wrong origin in local", async () => {
      vi.mocked(getServerEnv).mockReturnValue(env("local"));
      const response = await POST(
        request(viewBook, { origin: "http://localhost:9999" }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("body validation", () => {
    it("rejects invalid JSON", async () => {
      const response = await POST(request("{not json"));

      expect(response.status).toBe(400);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("rejects an oversized body", async () => {
      const response = await POST(
        request({ ...viewBook, padding: "x".repeat(4096) }),
      );

      expect(response.status).toBe(413);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("rejects extra fields", async () => {
      const response = await POST(
        request({ ...viewBook, title: "A book title" }),
      );
      expect(response.status).toBe(400);
    });

    it("rejects a field that belongs to another event", async () => {
      const response = await POST(
        request({ ...viewBook, publicationId: PUBLICATION_ID }),
      );
      expect(response.status).toBe(400);
    });

    it.each([
      "begin_checkout",
      "purchase",
      "payment_failed",
      "progress_25",
      "book_published",
      "epub_job_failed",
    ])("rejects the server-only event %s", async (eventName) => {
      const response = await POST(
        request({ ...viewBook, eventName, orderId: BOOK_ID }),
      );

      expect(response.status).toBe(400);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it.each([
      ["bookId", { ...viewBook, bookId: "not-a-uuid" }],
      ["eventId", { ...viewBook, eventId: "123" }],
      [
        "publicationId",
        {
          eventId: EVENT_ID,
          eventName: "open_reader",
          bookId: BOOK_ID,
          publicationId: "x".repeat(36),
          locale: "en",
        },
      ],
    ])("rejects a malformed %s", async (_field, body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("rejects a missing event ID and an unsupported locale", async () => {
      const withoutId: Record<string, unknown> = { ...viewBook };
      delete withoutId.eventId;
      expect((await POST(request(withoutId))).status).toBe(400);
      expect((await POST(request({ ...viewBook, locale: "fr" }))).status).toBe(
        400,
      );
    });
  });

  it("records the event anonymously when the session lookup throws", async () => {
    // Analytics must never interrupt the page: a session outage costs attribution, not a 500.
    vi.mocked(getCurrentProfile).mockRejectedValue(
      new Error("auth unavailable"),
    );

    const response = await POST(request(viewBook));

    expect(response.status).toBe(202);
    const [input] = vi.mocked(trackEventBestEffort).mock.calls[0];
    expect(input).not.toHaveProperty("profileId");
  });

  describe("session-bound events", () => {
    it.each([
      [
        "view_library",
        { eventId: EVENT_ID, eventName: "view_library", locale: "vi" },
      ],
      [
        "open_reader",
        {
          eventId: EVENT_ID,
          eventName: "open_reader",
          bookId: BOOK_ID,
          publicationId: PUBLICATION_ID,
          locale: "en",
        },
      ],
      [
        "change_reader_setting",
        {
          eventId: EVENT_ID,
          eventName: "change_reader_setting",
          bookId: BOOK_ID,
          locale: "vi",
        },
      ],
    ])(
      "refuses an anonymous %s with 401 and writes nothing",
      async (_name, body) => {
        const response = await POST(request(body));

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: "unauthorized",
          requestId: expect.any(String),
        });
        expect(consumeAnalyticsQuota).not.toHaveBeenCalled();
        expect(trackEventBestEffort).not.toHaveBeenCalled();
      },
    );

    it("refuses view_library when the session lookup throws", async () => {
      vi.mocked(getCurrentProfile).mockRejectedValue(
        new Error("auth unavailable"),
      );

      const response = await POST(
        request({ eventId: EVENT_ID, eventName: "view_library", locale: "vi" }),
      );

      expect(response.status).toBe(401);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it.each(["view_book", "open_sample"])(
      "still accepts an anonymous %s",
      async (eventName) => {
        const response = await POST(request({ ...viewBook, eventName }));
        expect(response.status).toBe(202);
      },
    );
  });

  describe("durable quota", () => {
    it("charges an anonymous caller to the shared anonymous bucket", async () => {
      await POST(request(viewBook));
      expect(consumeAnalyticsQuota).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it("charges a signed-in caller to its profile bucket", async () => {
      signIn();
      await POST(request(viewBook));
      expect(consumeAnalyticsQuota).toHaveBeenCalledExactlyOnceWith(PROFILE_ID);
    });

    it("refuses an event over quota with 429 and writes nothing", async () => {
      vi.mocked(consumeAnalyticsQuota).mockResolvedValue("limited");

      const response = await POST(request(viewBook));

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: "rate_limited",
        requestId: expect.any(String),
      });
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("skips the insert and answers 503 when the quota cannot be checked", async () => {
      vi.mocked(consumeAnalyticsQuota).mockResolvedValue({ error: "PGRST301" });
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      const response = await POST(
        request(viewBook, { origin: SITE, "x-request-id": "req-quota-1" }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "unavailable",
        requestId: expect.any(String),
      });
      expect(trackEventBestEffort).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        "Analytics intake quota check failed.",
        {
          requestId: expect.any(String),
          code: "PGRST301",
        },
      );
    });

    it.each([
      ["a wrong origin", request(viewBook, { origin: "https://evil.example" })],
      ["an invalid body", request({ ...viewBook, title: "A book title" })],
      [
        "an anonymous session-bound event",
        request({ eventId: EVENT_ID, eventName: "view_library", locale: "vi" }),
      ],
    ])("is never consumed for %s", async (_case, req) => {
      await POST(req);
      expect(consumeAnalyticsQuota).not.toHaveBeenCalled();
    });
  });

  describe("per-instance client limiter", () => {
    it("refuses a client over its limit with 429 before the durable quota", async () => {
      const allow = vi
        .spyOn(analyticsIntakeLimiter, "allow")
        .mockReturnValue(false);

      const response = await POST(
        request(viewBook, { origin: SITE, "x-real-ip": CLIENT_IP }),
      );

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: "rate_limited",
        requestId: expect.any(String),
      });
      expect(allow).toHaveBeenCalledExactlyOnceWith(CLIENT_IP);
      expect(consumeAnalyticsQuota).not.toHaveBeenCalled();
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("keys on the first x-forwarded-for entry when x-real-ip is absent", async () => {
      const allow = vi
        .spyOn(analyticsIntakeLimiter, "allow")
        .mockReturnValue(true);

      await POST(
        request(viewBook, {
          origin: SITE,
          "x-forwarded-for": "198.51.100.1, 10.0.0.1",
        }),
      );

      expect(allow).toHaveBeenCalledExactlyOnceWith("198.51.100.1");
    });

    it("is skipped when there is no client address, leaving the durable quota", async () => {
      const allow = vi.spyOn(analyticsIntakeLimiter, "allow");

      const response = await POST(request(viewBook));

      expect(response.status).toBe(202);
      expect(allow).not.toHaveBeenCalled();
      expect(consumeAnalyticsQuota).toHaveBeenCalledOnce();
    });

    it("is not consulted for an anonymous session-bound event", async () => {
      const allow = vi.spyOn(analyticsIntakeLimiter, "allow");

      await POST(
        request(
          { eventId: EVENT_ID, eventName: "view_library", locale: "vi" },
          { origin: SITE, "x-real-ip": CLIENT_IP },
        ),
      );

      expect(allow).not.toHaveBeenCalled();
    });
  });

  describe("bounded body read", () => {
    function streamedRequest(
      chunks: Uint8Array[],
      headers: Record<string, string> = { origin: SITE },
    ) {
      const state = { pulled: 0, cancelled: false };
      // No read-ahead (highWaterMark 0): `pulled` counts only chunks the route actually read.
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (state.pulled >= chunks.length) {
              controller.close();
              return;
            }
            controller.enqueue(chunks[state.pulled]);
            state.pulled += 1;
          },
          cancel() {
            state.cancelled = true;
          },
        },
        { highWaterMark: 0 },
      );
      const req = new NextRequest(`${SITE}/api/analytics/events`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]);
      return { req, state };
    }

    it("rejects a chunked body over the limit without reading all of it", async () => {
      const chunks = Array.from({ length: 64 }, () =>
        new TextEncoder().encode("x".repeat(512)),
      );
      const { req, state } = streamedRequest(chunks);
      expect(req.headers.get("content-length")).toBeNull();

      const response = await POST(req);

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "too_large",
        requestId: expect.any(String),
      });
      expect(state.cancelled).toBe(true);
      // The third 512-byte chunk passes 1,024 bytes; the other 61 are never read.
      expect(state.pulled).toBe(3);
      expect(getCurrentProfile).not.toHaveBeenCalled();
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("accepts a normal chunked body", async () => {
      const text = JSON.stringify(viewBook);
      const encoded = new TextEncoder().encode(text);
      const { req } = streamedRequest([
        encoded.slice(0, 20),
        encoded.slice(20),
      ]);

      const response = await POST(req);

      expect(response.status).toBe(202);
      expect(trackEventBestEffort).toHaveBeenCalledOnce();
    });

    it("rejects a declared Content-Length over the limit before reading the body", async () => {
      const { req, state } = streamedRequest([new TextEncoder().encode("{}")], {
        origin: SITE,
        "content-length": "4096",
      });

      const response = await POST(req);

      expect(response.status).toBe(413);
      expect(state.pulled).toBe(0);
    });

    it("answers 400 when the client aborts mid-body", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"eventId":'));
          controller.error(new TypeError("terminated"));
        },
      });
      const req = new NextRequest(`${SITE}/api/analytics/events`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: SITE },
        body,
        duplex: "half",
      } as ConstructorParameters<typeof NextRequest>[1]);

      const response = await POST(req);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_request", requestId: expect.any(String) });
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("rejects a body that is not valid UTF-8", async () => {
      const { req } = streamedRequest([
        new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]),
      ]);

      const response = await POST(req);

      expect(response.status).toBe(400);
      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });
  });
});
