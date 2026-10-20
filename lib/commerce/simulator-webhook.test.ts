// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyVerifiedPaymentEvent } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { buildSimulatedEventRequest, buildSimulatedEvents, signSimulatedEvent, SIMULATOR_SIGNATURE_HEADER } from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({ applyVerifiedPaymentEvent: vi.fn() }));
vi.mock("@/lib/analytics/events", () => ({ trackEventBestEffort: vi.fn() }));

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "req-12345678";

function env(overrides: Partial<{ appEnv: string; paymentProvider: string; simulatorSecret: string | null }> = {}) {
  return { appEnv: "test", paymentProvider: "simulator", simulatorSecret: SECRET, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

function validRequest(outcome: "succeeded" | "failed" | "cancelled" = "succeeded", eventId = "evt-1") {
  const [event] = buildSimulatedEvents({ id: ORDER_ID, totalMinor: 150000, currency: "VND" }, outcome, eventId, new Date("2026-09-15T00:00:00Z"));
  return buildSimulatedEventRequest(event, SECRET, REQUEST_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(trackEventBestEffort).mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSimulatorWebhook", () => {
  it.each([
    ["production", env({ appEnv: "production" }), "environment"],
    ["preview", env({ appEnv: "preview" }), "environment"],
    ["payments disabled", env({ paymentProvider: "disabled", simulatorSecret: null }), "provider"],
  ])("returns 404 when the simulator is off (%s)", async (_label, value, reason) => {
    vi.mocked(getServerEnv).mockReturnValue(value);
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(404);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("Simulator webhook is disabled.", { requestId: REQUEST_ID, reason });
  });

  it("returns 401 for a bad signature and applies nothing", async () => {
    const body = JSON.stringify({ orderId: ORDER_ID });
    const request = new Request("http://simulator.internal/", {
      method: "POST",
      headers: { [SIMULATOR_SIGNATURE_HEADER]: "sha256=bad" },
      body,
    });
    const response = await handleSimulatorWebhook(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "Simulator webhook rejected a signature.",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("returns 400 for a signed but malformed event", async () => {
    const body = JSON.stringify({ orderId: "not-a-uuid" });
    const request = new Request("http://simulator.internal/", {
      method: "POST",
      headers: { [SIMULATOR_SIGNATURE_HEADER]: signSimulatedEvent(body, SECRET) },
      body,
    });
    const response = await handleSimulatorWebhook(request);
    expect(response.status).toBe(400);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      "Simulator webhook received a malformed event.",
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("applies a valid event and returns the outcome with the request ID", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: ["e1"], orderStatus: "completed", paymentStatus: "succeeded" });
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(await response.json()).toEqual({ orderStatus: "completed", paymentStatus: "succeeded", requestId: REQUEST_ID });
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: "simulator", orderId: ORDER_ID, eventId: "evt-1" }));
  });

  it("returns 422 when the event does not match an order", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new PaymentEventRejectedError());
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(422);
  });

  it("returns 500 without database text and logs the request ID", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("relation secret_table does not exist"));
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
    expect(console.error).toHaveBeenCalledWith("Simulator webhook failed.", expect.objectContaining({ requestId: REQUEST_ID }));
  });

  describe("payment analytics", () => {
    it("records purchase, keyed by order, once the order is completed and paid", async () => {
      vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: ["e1"], orderStatus: "completed", paymentStatus: "succeeded" });

      await handleSimulatorWebhook(validRequest());

      expect(trackEventBestEffort).toHaveBeenCalledExactlyOnceWith(
        { eventName: "purchase", dedupeKey: `purchase/${ORDER_ID}`, orderId: ORDER_ID },
        { requestId: REQUEST_ID },
      );
      expect(vi.mocked(applyVerifiedPaymentEvent).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(trackEventBestEffort).mock.invocationCallOrder[0],
      );
    });

    it("records payment_failed, keyed by provider event, when the payment failed", async () => {
      vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: [], orderStatus: "pending", paymentStatus: "failed" });

      await handleSimulatorWebhook(validRequest("failed", "evt-fail-7"));

      expect(trackEventBestEffort).toHaveBeenCalledExactlyOnceWith(
        { eventName: "payment_failed", dedupeKey: "payment-failed/evt-fail-7", orderId: ORDER_ID },
        { requestId: REQUEST_ID },
      );
    });

    // The returned state decides, never the event's own status: a late failure against an order that
    // already completed re-reports the completed order, whose purchase row the order-keyed dedupe
    // key already holds, and no payment_failed is invented.
    it.each([
      ["a cancelled order", { orderStatus: "cancelled", paymentStatus: "cancelled" }, "cancelled", []],
      ["a late failure on a completed order", { orderStatus: "completed", paymentStatus: "succeeded" }, "failed", ["purchase"]],
      ["a failed event the order did not take", { orderStatus: "cancelled", paymentStatus: "cancelled" }, "failed", []],
    ] as const)("records only what the returned state says for %s", async (_label, outcome, status, expected) => {
      vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: [], ...outcome });

      await handleSimulatorWebhook(validRequest(status));

      const names = vi.mocked(trackEventBestEffort).mock.calls.map(([input]) => input.eventName);
      expect(names).toEqual(expected);
    });

    it("records nothing for a rejected or failed apply", async () => {
      vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new PaymentEventRejectedError());
      await handleSimulatorWebhook(validRequest());
      vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("boom"));
      await handleSimulatorWebhook(validRequest());

      expect(trackEventBestEffort).not.toHaveBeenCalled();
    });

    it("returns the same response when analytics fails", async () => {
      vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: ["e1"], orderStatus: "completed", paymentStatus: "succeeded" });
      vi.mocked(trackEventBestEffort).mockRejectedValue(new Error("analytics down"));

      const response = await handleSimulatorWebhook(validRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ orderStatus: "completed", paymentStatus: "succeeded", requestId: REQUEST_ID });
      expect(console.error).not.toHaveBeenCalledWith("Simulator webhook failed.", expect.anything());
    });
  });
});
