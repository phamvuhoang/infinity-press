// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { simulatePaymentAction } from "@/app/[lang]/(account)/checkout/[orderId]/simulate/actions";
import { requireUser } from "@/lib/auth/session";
import { signSimulatedEvent, SIMULATOR_SIGNATURE_HEADER } from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));
vi.mock("@/lib/commerce/simulator-webhook", () => ({ handleSimulatorWebhook: vi.fn() }));

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bundleId: null,
  title: "A Book",
  items: [{ bookId: "30000000-0000-4000-8000-000000000001", title: "A Book", hasActiveEntitlement: false }],
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 129000,
  currency: "VND",
  subtotalMinor: 129000,
  discountMinor: 0,
  couponCode: null,
  createdAt: "2026-09-15T00:00:00Z",
  hasAllActiveEntitlements: false,
  referenceCode: "IB-ABCDE",
  provider: "simulator",
  claimedAt: null,
  declinedAt: null,
  declineReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({ appEnv: "test", paymentProvider: "simulator", simulatorSecret: SECRET } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
  vi.mocked(handleSimulatorWebhook).mockResolvedValue(new Response("{}", { status: 200 }));
});

describe("simulatePaymentAction", () => {
  it("delivers one signed event priced from the order, then shows the status", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "failed")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);

    expect(handleSimulatorWebhook).toHaveBeenCalledTimes(1);
    const request = vi.mocked(handleSimulatorWebhook).mock.calls[0][0];
    const body = await request.text();
    expect(request.headers.get(SIMULATOR_SIGNATURE_HEADER)).toBe(signSimulatedEvent(body, SECRET));
    expect(request.headers.get("x-request-id")).toBe("req-12345678");
    expect(JSON.parse(body)).toMatchObject({ orderId: ORDER_ID, status: "failed", amountMinor: 129000, currency: "VND" });
  });

  it("delivers the same event twice for Send duplicate", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "duplicate")).rejects.toThrow("NEXT_REDIRECT");
    const bodies = await Promise.all(vi.mocked(handleSimulatorWebhook).mock.calls.map(([request]) => request.text()));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it.each([
    ["production", { appEnv: "production", paymentProvider: "disabled", simulatorSecret: null }],
    ["payments disabled", { appEnv: "test", paymentProvider: "disabled", simulatorSecret: null }],
  ])("sends nothing when the simulator is off (%s)", async (_label, value) => {
    vi.mocked(getServerEnv).mockReturnValue(value as ReturnType<typeof getServerEnv>);
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown outcome", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "refunded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for a foreign order", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for a completed order", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, status: "completed" });
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for an order booked under another provider", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, provider: "manual" });
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for a pending order the reader already owns", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasAllActiveEntitlements: true });
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("logs a failed delivery with the request ID and still shows the status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(handleSimulatorWebhook).mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
    expect(error).toHaveBeenCalledWith("Simulated payment delivery failed.", expect.objectContaining({ requestId: "req-12345678", status: 500 }));
  });
});
