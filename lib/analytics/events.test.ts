// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEventNames, trackEventBestEffort } from "@/lib/analytics/events";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-request-id": "req-from-headers-1" })),
}));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const PROFILE_ID = "20000000-0000-4000-8000-000000000001";

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));

beforeEach(() => {
  vi.clearAllMocks();
  insert.mockResolvedValue({ error: null });
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createAdminClient>);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyticsEventNames", () => {
  it("lists only the application-owned events; triggers own progress, publish, and EPUB events", () => {
    expect([...analyticsEventNames]).toEqual([
      "view_book",
      "open_sample",
      "begin_checkout",
      "purchase",
      "payment_failed",
      "open_reader",
      "click_external_store",
      "change_reader_setting",
      "view_library",
      "share_quote",
      "view_quote",
    ]);
  });
});

describe("trackEventBestEffort", () => {
  it("inserts exactly the named columns into analytics_events", async () => {
    await trackEventBestEffort(
      {
        eventName: "begin_checkout",
        dedupeKey: `checkout/${ORDER_ID}`,
        profileId: PROFILE_ID,
        bookId: BOOK_ID,
        orderId: ORDER_ID,
        locale: "vi",
      },
      { requestId: "req-12345678" },
    );

    expect(from).toHaveBeenCalledExactlyOnceWith("analytics_events");
    expect(insert).toHaveBeenCalledExactlyOnceWith({
      event_name: "begin_checkout",
      dedupe_key: `checkout/${ORDER_ID}`,
      profile_id: PROFILE_ID,
      book_id: BOOK_ID,
      order_id: ORDER_ID,
      locale: "vi",
    });
  });

  it("writes the retailer column for click_external_store", async () => {
    await trackEventBestEffort({ eventName: "click_external_store", bookId: BOOK_ID, retailer: "tiki", locale: "vi" });

    expect(insert).toHaveBeenCalledExactlyOnceWith({
      event_name: "click_external_store",
      book_id: BOOK_ID,
      retailer: "tiki",
      locale: "vi",
    });
  });

  it("writes the shared_quote_id column for view_quote", async () => {
    const quoteId = "90000000-0000-4000-8000-000000000001";
    await trackEventBestEffort({ eventName: "view_quote", bookId: BOOK_ID, sharedQuoteId: quoteId, locale: "vi" });

    expect(insert).toHaveBeenCalledExactlyOnceWith({
      event_name: "view_quote",
      book_id: BOOK_ID,
      shared_quote_id: quoteId,
      locale: "vi",
    });
  });

  it("sends no key for a field the caller left out", async () => {
    await trackEventBestEffort({ eventName: "view_library", locale: "en", deviceClass: "mobile" });

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toEqual({ event_name: "view_library", locale: "en", device_class: "mobile" });
    expect(Object.keys(row)).not.toContain("profile_id");
  });

  it("treats a duplicate dedupe key as success and logs nothing", async () => {
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key value violates unique constraint" } });

    await expect(
      trackEventBestEffort({ eventName: "purchase", dedupeKey: `purchase/${ORDER_ID}`, orderId: ORDER_ID }),
    ).resolves.toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs any other insert error with the request ID and the code only", async () => {
    insert.mockResolvedValue({
      error: { code: "23503", message: 'Key (book_id)=(secret) is not present in table "books".' },
    });

    await expect(
      trackEventBestEffort({ eventName: "view_book", bookId: BOOK_ID, locale: "en" }, { requestId: "req-12345678" }),
    ).resolves.toBeUndefined();

    expect(console.error).toHaveBeenCalledExactlyOnceWith("Analytics event insert failed.", {
      requestId: "req-12345678",
      eventName: "view_book",
      code: "23503",
    });
  });

  it("swallows a thrown failure, such as a missing service-role configuration", async () => {
    vi.mocked(createAdminClient).mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
    });

    await expect(trackEventBestEffort({ eventName: "view_library", locale: "vi" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledExactlyOnceWith("Analytics event insert failed.", {
      requestId: "req-from-headers-1",
      eventName: "view_library",
      code: "exception",
    });
  });

  it("falls back to the request headers for the request ID", async () => {
    insert.mockResolvedValue({ error: { code: "42501", message: "permission denied" } });

    await trackEventBestEffort({ eventName: "view_library", locale: "vi" });

    expect(console.error).toHaveBeenCalledWith(
      "Analytics event insert failed.",
      expect.objectContaining({ requestId: "req-from-headers-1" }),
    );
  });
});
