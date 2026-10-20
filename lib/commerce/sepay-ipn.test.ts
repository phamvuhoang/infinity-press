// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyVerifiedPaymentEvent, findOrderIdByReference, findPaymentExternalId } from "@/lib/access/grant";
import { trackEventBestEffort } from "@/lib/analytics/events";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { handleSepayIpn } from "@/lib/commerce/sepay-ipn";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({
  applyVerifiedPaymentEvent: vi.fn(),
  findOrderIdByReference: vi.fn(),
  findPaymentExternalId: vi.fn(),
}));
vi.mock("@/lib/analytics/events", () => ({ trackEventBestEffort: vi.fn() }));

const SECRET = "secret_test_key";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const sepay = { merchantId: "MERCHANT_TEST", secretKey: SECRET, env: "sandbox" } as const;

function env(overrides: Record<string, unknown> = {}) {
  return { appEnv: "test", paymentProvider: "sepay", sepay, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

const paid = {
  timestamp: 1757058220,
  notification_type: "ORDER_PAID",
  order: {
    order_id: "NPSETVI00101000042R",
    order_status: "CAPTURED",
    order_currency: "VND",
    order_amount: "89000.00",
    order_invoice_number: "IB-7K2MX-89000",
  },
  transaction: { transaction_id: "TXN-1", payment_method: "BANK_TRANSFER", transaction_status: "APPROVED" },
};

function ipn(body: unknown = paid, secret: string | null = SECRET): Request {
  return new Request("https://books.test/api/payments/sepay/ipn", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "req-12345678", ...(secret ? { "X-Secret-Key": secret } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.mocked(findOrderIdByReference).mockResolvedValue(ORDER_ID);
  vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementIds: ["e1"], orderStatus: "completed", paymentStatus: "succeeded" });
  vi.mocked(trackEventBestEffort).mockResolvedValue(undefined);
  // The payment row holds the SePay order that completed the order: this notification's own.
  vi.mocked(findPaymentExternalId).mockResolvedValue("NPSETVI00101000042R");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSepayIpn", () => {
  it("applies a paid order and answers the way SePay expects", async () => {
    const response = await handleSepayIpn(ipn());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(findOrderIdByReference).toHaveBeenCalledWith("IB-7K2MX");
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledWith({
      provider: "sepay",
      eventId: "TXN-1",
      externalPaymentId: "NPSETVI00101000042R",
      orderId: ORDER_ID,
      status: "succeeded",
      amountMinor: 89000,
      currency: "VND",
      occurredAt: "2025-09-05T07:43:40.000Z",
    });
    expect(trackEventBestEffort).toHaveBeenCalledWith(
      { eventName: "purchase", dedupeKey: `purchase/${ORDER_ID}`, orderId: ORDER_ID },
      expect.anything(),
    );
  });

  // apply_payment_event ignores a repeated event ID and returns the order as it stands.
  it("answers 200 for a repeat", async () => {
    await handleSepayIpn(ipn());
    const second = await handleSepayIpn(ipn());
    expect(second.status).toBe(200);
  });

  it("flags a paid cancelled order on first delivery and replay", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({
      entitlementIds: [], orderStatus: "cancelled", paymentStatus: "cancelled",
    });
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await handleSepayIpn(ipn());
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: "manual_resolution_required" });
    }
    expect(trackEventBestEffort).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      requestId: "req-12345678", orderId: ORDER_ID, eventId: "TXN-1",
      invoiceNumber: "IB-7K2MX-89000", externalPaymentId: "NPSETVI00101000042R",
      amountMinor: 89000, currency: "VND",
    }));
  });

  // The reader opened a QR, repriced the order with a coupon, and paid the second invoice; the
  // first QR is then paid too. The RPC records the event but, the order being completed, applies
  // nothing - so a 200 would bury money the reader paid twice. A repeat of the SAME SePay order is
  // the case above and stays 200.
  it("flags a different SePay order paid against an already completed order", async () => {
    vi.mocked(findPaymentExternalId).mockResolvedValue("NPSETVI00199999999R");
    const response = await handleSepayIpn(ipn());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "manual_resolution_required" });
    expect(trackEventBestEffort).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      requestId: "req-12345678", orderId: ORDER_ID, eventId: "TXN-1",
      invoiceNumber: "IB-7K2MX-89000", externalPaymentId: "NPSETVI00101000042R",
      recordedExternalPaymentId: "NPSETVI00199999999R", amountMinor: 89000, currency: "VND",
    }));
  });

  it("is 404 when SePay is not configured", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env({ sepay: null, paymentProvider: "manual" }));
    expect((await handleSepayIpn(ipn())).status).toBe(404);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  // A reader may be on SePay's page when the operator switches providers (spec 6.3).
  it("still settles when the deployment has moved to another provider", async () => {
    vi.mocked(getServerEnv).mockReturnValue(env({ paymentProvider: "manual" }));
    expect((await handleSepayIpn(ipn())).status).toBe(200);
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledOnce();
  });

  it.each([["missing", null], ["wrong", "not-the-secret"]])("is 401 for a %s secret, before any lookup", async (_label, secret) => {
    const response = await handleSepayIpn(ipn(paid, secret));
    expect(response.status).toBe(401);
    expect(findOrderIdByReference).not.toHaveBeenCalled();
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("is 400 for a malformed body", async () => {
    expect((await handleSepayIpn(ipn("{"))).status).toBe(400);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  // An authenticated notification can still fail parsing (a field SePay formats differently than
  // expected) while the money is already in the bank. The 400 must leave what an operator needs.
  it("logs the payment identifiers when an authenticated notification is malformed", async () => {
    const response = await handleSepayIpn(ipn({ ...paid, timestamp: "1757058220" }));

    expect(response.status).toBe(400);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requestId: "req-12345678",
        invoiceNumber: "IB-7K2MX-89000",
        externalPaymentId: "NPSETVI00101000042R",
        amount: "89000.00",
      }),
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(SECRET);
  });

  it("acknowledges a notification that is not a payment, without applying it", async () => {
    const response = await handleSepayIpn(ipn({ ...paid, notification_type: "TRANSACTION_VOID" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("is 422 when no order has that reference", async () => {
    vi.mocked(findOrderIdByReference).mockResolvedValue(null);
    expect((await handleSepayIpn(ipn())).status).toBe(422);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  // The reader paid an amount the order no longer has (a coupon was applied after the QR was
  // shown). The money is in the bank and the order is not completed, so the log is the only trail.
  it("logs what an operator needs when apply_payment_event refuses the event", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new PaymentEventRejectedError());
    const response = await handleSepayIpn(ipn());

    expect(response.status).toBe(422);
    expect(console.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        requestId: "req-12345678",
        orderId: ORDER_ID,
        invoiceNumber: "IB-7K2MX-89000",
        externalPaymentId: "NPSETVI00101000042R",
        amountMinor: 89000,
      }),
    );
  });

  it("is 500 for an unexpected failure, so SePay retries", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("database is down"));
    expect((await handleSepayIpn(ipn())).status).toBe(500);
  });

  it("never logs the secret or echoes it", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("boom"));
    const response = await handleSepayIpn(ipn());
    const logged = JSON.stringify([vi.mocked(console.error).mock.calls, vi.mocked(console.warn).mock.calls]);
    expect(logged).not.toContain(SECRET);
    expect(await response.text()).not.toContain(SECRET);
  });
});
