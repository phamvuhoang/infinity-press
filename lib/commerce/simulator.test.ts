// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSimulatedEventRequest,
  buildSimulatedEvents,
  InvalidSimulatorSignatureError,
  isSimulatedOutcome,
  isSimulatorAllowedEnvironment,
  isSimulatorCheckoutEnabled,
  MalformedSimulatedEventError,
  signSimulatedEvent,
  SIMULATOR_SIGNATURE_HEADER,
  SimulatorProvider,
  SimulatorProviderEnvironmentError,
  SimulatorSecretMissingError,
} from "@/lib/commerce/simulator";

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const validPayload = {
  eventId: "evt-1",
  externalPaymentId: "pay-1",
  orderId: ORDER_ID,
  status: "succeeded" as const,
  amountMinor: 150000,
  currency: "VND",
  occurredAt: "2026-09-12T00:00:00.000Z",
};

function signedRequest(body: string, signature: string | null = signSimulatedEvent(body, SECRET)) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set(SIMULATOR_SIGNATURE_HEADER, signature);
  return new Request("https://simulator.local/events", { method: "POST", headers, body });
}

const provider = () => new SimulatorProvider({ appEnv: "local", simulatorSecret: SECRET });

// One predicate decides where the simulator may run. The provider, the simulate page, and the webhook
// all call it instead of restating the policy.
describe("isSimulatorAllowedEnvironment", () => {
  it.each(["local", "staging", "test"])("permits %s", (appEnv) => {
    expect(isSimulatorAllowedEnvironment(appEnv)).toBe(true);
  });

  it.each(["preview", "production"])("refuses %s", (appEnv) => {
    expect(isSimulatorAllowedEnvironment(appEnv)).toBe(false);
  });
});

describe("isSimulatorCheckoutEnabled", () => {
  it("needs the simulator provider in an allowed environment", () => {
    expect(isSimulatorCheckoutEnabled({ appEnv: "staging", paymentProvider: "simulator" })).toBe(true);
    expect(isSimulatorCheckoutEnabled({ appEnv: "staging", paymentProvider: "disabled" })).toBe(false);
    expect(isSimulatorCheckoutEnabled({ appEnv: "production", paymentProvider: "simulator" })).toBe(false);
  });
});

describe("SimulatorProvider construction", () => {
  it.each(["production", "preview"])("refuses appEnv=%s", (appEnv) => {
    expect(() => new SimulatorProvider({ appEnv, simulatorSecret: SECRET })).toThrow(SimulatorProviderEnvironmentError);
  });

  it("refuses to run without a secret", () => {
    expect(() => new SimulatorProvider({ appEnv: "local", simulatorSecret: null })).toThrow(SimulatorSecretMissingError);
  });

  it.each(["local", "staging", "test"])("constructs in %s", (appEnv) => {
    expect(() => new SimulatorProvider({ appEnv, simulatorSecret: SECRET })).not.toThrow();
  });
});

describe("SimulatorProvider.createSession", () => {
  it("sends the reader to the simulate page for the order", async () => {
    await expect(provider().createSession({ orderId: ORDER_ID, locale: "vi" })).resolves.toEqual({
      redirectUrl: `/vi/checkout/${ORDER_ID}/simulate`,
    });
  });
});

describe("SimulatorProvider.verifyEvent", () => {
  it("verifies a signed event and stamps its provider key", async () => {
    await expect(provider().verifyEvent(signedRequest(JSON.stringify(validPayload)))).resolves.toEqual({
      ...validPayload,
      provider: "simulator",
    });
  });

  it("rejects a body changed after signing", async () => {
    const signature = signSimulatedEvent(JSON.stringify(validPayload), SECRET);
    const tampered = signedRequest(JSON.stringify({ ...validPayload, amountMinor: 1 }), signature);
    await expect(provider().verifyEvent(tampered)).rejects.toThrow(InvalidSimulatorSignatureError);
  });

  it("rejects a signature made with another secret", async () => {
    const body = JSON.stringify(validPayload);
    const request = signedRequest(body, signSimulatedEvent(body, "another-secret-0123456789abcdefghij"));
    await expect(provider().verifyEvent(request)).rejects.toThrow(InvalidSimulatorSignatureError);
  });

  it("rejects a missing signature", async () => {
    await expect(provider().verifyEvent(signedRequest(JSON.stringify(validPayload), null))).rejects.toThrow(
      InvalidSimulatorSignatureError,
    );
  });

  it.each([
    ["not JSON", "not json"],
    ["missing eventId", JSON.stringify({ ...validPayload, eventId: undefined })],
    ["non-UUID orderId", JSON.stringify({ ...validPayload, orderId: "order-1" })],
    ["invalid status", JSON.stringify({ ...validPayload, status: "pending" })],
    ["non-integer amount", JSON.stringify({ ...validPayload, amountMinor: 1.5 })],
    ["negative amount", JSON.stringify({ ...validPayload, amountMinor: -1 })],
    ["missing currency", JSON.stringify({ ...validPayload, currency: undefined })],
  ])("rejects a signed but malformed event: %s", async (_label, body) => {
    await expect(provider().verifyEvent(signedRequest(body))).rejects.toThrow(MalformedSimulatedEventError);
  });
});

describe("simulated events", () => {
  const order = { id: ORDER_ID, totalMinor: 150000, currency: "VND" };
  const now = new Date("2026-09-15T00:00:00.000Z");

  it.each(["succeeded", "failed", "cancelled"] as const)("sends one %s event priced from the order", (outcome) => {
    expect(buildSimulatedEvents(order, outcome, "evt-1", now)).toEqual([
      {
        eventId: "evt-1",
        externalPaymentId: `sim_pay_${ORDER_ID}`,
        orderId: ORDER_ID,
        status: outcome,
        amountMinor: 150000,
        currency: "VND",
        occurredAt: "2026-09-15T00:00:00.000Z",
      },
    ]);
  });

  it("sends the same succeeded event twice for a duplicate", () => {
    const events = buildSimulatedEvents(order, "duplicate", "evt-1", now);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
    expect(events[0].status).toBe("succeeded");
  });

  it("recognizes only the four outcomes", () => {
    expect(["succeeded", "failed", "cancelled", "duplicate"].every(isSimulatedOutcome)).toBe(true);
    expect(isSimulatedOutcome("refunded")).toBe(false);
  });

  it("builds a request that verifyEvent accepts and that carries the request ID", async () => {
    const [event] = buildSimulatedEvents(order, "failed", "evt-2", now);
    const request = buildSimulatedEventRequest(event, SECRET, "req-12345678");
    expect(request.headers.get("x-request-id")).toBe("req-12345678");
    await expect(provider().verifyEvent(request)).resolves.toMatchObject({ eventId: "evt-2", status: "failed" });
  });
});
