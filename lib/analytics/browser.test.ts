import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANALYTICS_EVENTS_PATH, deviceClassForViewportWidth, sendAnalyticsEvent } from "@/lib/analytics/browser";

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

async function blobJson(blob: Blob): Promise<unknown> {
  return JSON.parse(await blob.text());
}

describe("deviceClassForViewportWidth", () => {
  it.each([
    [320, "mobile"],
    [639, "mobile"],
    [640, "tablet"],
    [1023, "tablet"],
    [1024, "desktop"],
    [2560, "desktop"],
  ])("classifies %ipx as %s", (width, expected) => {
    expect(deviceClassForViewportWidth(width)).toBe(expected);
  });

  it.each([Number.NaN, -1, 0, Number.POSITIVE_INFINITY])("returns nothing for the unusable width %s", (width) => {
    expect(deviceClassForViewportWidth(width)).toBeUndefined();
  });
});

describe("sendAnalyticsEvent", () => {
  let sendBeacon: ReturnType<typeof vi.fn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, writable: true, value: sendBeacon });
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    vi.spyOn(crypto, "randomUUID").mockReturnValue("0f8fad5b-d9cb-469f-a165-70867728950e");
    setViewportWidth(1280);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a JSON Blob through sendBeacon with a client event ID and a coarse device class", async () => {
    sendAnalyticsEvent({ eventName: "view_book", bookId: BOOK_ID, locale: "vi" });

    expect(sendBeacon).toHaveBeenCalledOnce();
    const [url, blob] = sendBeacon.mock.calls[0] as [string, Blob];
    expect(url).toBe(ANALYTICS_EVENTS_PATH);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
    await expect(blobJson(blob)).resolves.toEqual({
      eventId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      eventName: "view_book",
      bookId: BOOK_ID,
      locale: "vi",
      deviceClass: "desktop",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends neither the viewport size nor the user agent", async () => {
    setViewportWidth(390);
    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });

    const body = JSON.stringify(await blobJson(sendBeacon.mock.calls[0][1] as Blob));
    expect(body).not.toContain("390");
    expect(body).not.toContain(navigator.userAgent);
    expect(JSON.parse(body)).toMatchObject({ deviceClass: "mobile" });
  });

  it("falls back to a keepalive fetch when the beacon is refused", async () => {
    sendBeacon.mockReturnValue(false);

    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANALYTICS_EVENTS_PATH);
    expect(init).toMatchObject({
      method: "POST",
      keepalive: true,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(init.body as string)).toMatchObject({ eventName: "view_library", locale: "en" });
  });

  it("falls back to fetch when sendBeacon is missing or throws", () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, writable: true, value: undefined });
    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });

    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        throw new TypeError("blocked");
      }),
    });
    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("never throws or rejects when the network fails", async () => {
    sendBeacon.mockReturnValue(false);
    fetchSpy.mockRejectedValue(new TypeError("offline"));

    expect(() => sendAnalyticsEvent({ eventName: "view_library", locale: "en" })).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await Promise.resolve();
  });

  it("uses a fresh event ID for every event", async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");

    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });
    sendAnalyticsEvent({ eventName: "view_library", locale: "en" });

    const ids = await Promise.all(
      sendBeacon.mock.calls.map(async (call) => ((await blobJson(call[1] as Blob)) as { eventId: string }).eventId),
    );
    expect(ids).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });
});
