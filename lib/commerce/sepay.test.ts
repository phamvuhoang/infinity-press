// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  buildSepayCheckoutFields,
  buildSepayInvoiceNumber,
  hasValidSepaySecret,
  MalformedSepayNotificationError,
  parseSepayInvoiceNumber,
  parseSepayNotification,
  sepayCheckoutUrl,
  SepayNotificationIgnoredError,
  signSepayFields,
} from "@/lib/commerce/sepay";

vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));

const config = { merchantId: "MERCHANT_TEST", secretKey: "secret_test_key", env: "sandbox" } as const;
const order = { id: "o1", referenceCode: "IB-7K2MX", totalMinor: 89000, currency: "VND" };

describe("buildSepayCheckoutFields", () => {
  it("produces the request the official SDK produces", () => {
    const fields = buildSepayCheckoutFields({ order, locale: "vi", siteUrl: "https://books.test", config });
    expect(fields).toEqual([
      ["operation", "PURCHASE"],
      ["payment_method", "BANK_TRANSFER"],
      ["order_invoice_number", "IB-7K2MX-89000"],
      ["order_amount", "89000"],
      ["currency", "VND"],
      ["order_description", "Infinity Books IB-7K2MX"],
      ["success_url", "https://books.test/vi/checkout/o1/status?sepay=success"],
      ["error_url", "https://books.test/vi/checkout/o1/status?sepay=error"],
      ["cancel_url", "https://books.test/vi/checkout/o1/status?sepay=cancel"],
      ["merchant", "MERCHANT_TEST"],
      ["signature", "hZ+asjDXkl1g9oKmfcJIpSTkbPAMP+e0gqcT04hvW2I="],
    ]);
  });

  it("never carries the secret", () => {
    const fields = buildSepayCheckoutFields({ order, locale: "en", siteUrl: "https://books.test", config });
    expect(JSON.stringify(fields)).not.toContain("secret_test_key");
  });

  // order_amount passes the minor amount through, which is 100x wrong for a currency with one.
  it("refuses a currency other than VND", () => {
    expect(
      buildSepayCheckoutFields({ order: { ...order, currency: "USD" }, locale: "en", siteUrl: "https://books.test", config }),
    ).toBeNull();
  });
});

describe("signSepayFields", () => {
  it("depends on field order", () => {
    const a = signSepayFields([["a", "1"], ["b", "2"]], "k");
    const b = signSepayFields([["b", "2"], ["a", "1"]], "k");
    expect(a).not.toBe(b);
  });
});

describe("sepayCheckoutUrl", () => {
  it("keeps sandbox and production apart", () => {
    expect(sepayCheckoutUrl("sandbox")).toBe("https://pay-sandbox.sepay.vn/v1/checkout/init");
    expect(sepayCheckoutUrl("production")).toBe("https://pay.sepay.vn/v1/checkout/init");
  });
});

describe("invoice number", () => {
  it("round-trips the reference and the amount", () => {
    const invoice = buildSepayInvoiceNumber("IB-7K2MX", 89000);
    expect(invoice).toBe("IB-7K2MX-89000");
    expect(parseSepayInvoiceNumber(invoice)).toEqual({ referenceCode: "IB-7K2MX", amountMinor: 89000 });
  });

  it.each(["IB-7K2MX", "IB-7K2MX-", "IB-7K2MX-12a", "XX-7K2MX-100", "IB-7K2M-100", "", "IB-7K2MX-100-1"])(
    "rejects %j",
    (value) => {
      expect(parseSepayInvoiceNumber(value)).toBeNull();
    },
  );
});

describe("hasValidSepaySecret", () => {
  it("accepts only the exact secret", () => {
    expect(hasValidSepaySecret("secret_test_key", "secret_test_key")).toBe(true);
    expect(hasValidSepaySecret("secret_test_kez", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret("secret", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret("", "secret_test_key")).toBe(false);
    expect(hasValidSepaySecret(null, "secret_test_key")).toBe(false);
  });
});

function notification(overrides: { root?: object; order?: object; transaction?: object } = {}): string {
  return JSON.stringify({
    timestamp: 1757058220,
    notification_type: "ORDER_PAID",
    order: {
      order_id: "NPSETVI00101000042R",
      order_status: "CAPTURED",
      order_currency: "VND",
      order_amount: "89000.00",
      order_invoice_number: "IB-7K2MX-89000",
      ...overrides.order,
    },
    transaction: {
      transaction_id: "TXN-1",
      payment_method: "BANK_TRANSFER",
      transaction_status: "APPROVED",
      ...overrides.transaction,
    },
    ...overrides.root,
  });
}

describe("parseSepayNotification", () => {
  it("maps a paid order", () => {
    expect(parseSepayNotification(notification())).toEqual({
      referenceCode: "IB-7K2MX",
      invoiceNumber: "IB-7K2MX-89000",
      eventId: "TXN-1",
      externalPaymentId: "NPSETVI00101000042R",
      amountMinor: 89000,
      currency: "VND",
      occurredAt: "2025-09-05T07:43:40.000Z",
    });
  });

  it.each([["89000.00"], ["89000"], [89000]])("reads order_amount %j as 89000", (amount) => {
    expect(parseSepayNotification(notification({ order: { order_amount: amount } })).amountMinor).toBe(89000);
  });

  // Never a rounded amount: apply_payment_event compares it to the order's total.
  it.each([["89000.50"], [""], [" "], ["-1"], ["1e5"], [null], [undefined], [89000.5]])(
    "rejects order_amount %j",
    (amount) => {
      expect(() => parseSepayNotification(notification({ order: { order_amount: amount } }))).toThrow(
        MalformedSepayNotificationError,
      );
    },
  );

  it.each([
    ["not json", "{"],
    ["a JSON string", '"x"'],
    ["no notification_type", notification({ root: { notification_type: undefined } })],
    ["no order", notification({ root: { order: null } })],
    ["no transaction", notification({ root: { transaction: "x" } })],
    ["a foreign invoice number", notification({ order: { order_invoice_number: "SUB_202509_001" } })],
    ["no payment_method", notification({ transaction: { payment_method: undefined } })],
    ["empty payment_method", notification({ transaction: { payment_method: "" } })],
    ["invalid payment_method", notification({ transaction: { payment_method: 7 } })],
    ["no transaction_id", notification({ transaction: { transaction_id: "" } })],
    ["no order_id", notification({ order: { order_id: 7 } })],
    ["no currency", notification({ order: { order_currency: "" } })],
    ["a string timestamp", notification({ root: { timestamp: "1757058220" } })],
    ["a zero timestamp", notification({ root: { timestamp: 0 } })],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseSepayNotification(raw)).toThrow(MalformedSepayNotificationError);
  });

  it.each([
    ["card payment", notification({ transaction: { payment_method: "CARD" } })],
    ["NAPAS payment", notification({ transaction: { payment_method: "NAPAS_BANK_TRANSFER" } })],
    ["another notification type", notification({ root: { notification_type: "TRANSACTION_VOID" } })],
    ["an order that is not captured", notification({ order: { order_status: "PENDING" } })],
    ["a transaction that is not approved", notification({ transaction: { transaction_status: "DECLINED" } })],
  ])("ignores %s", (_label, raw) => {
    expect(() => parseSepayNotification(raw)).toThrow(SepayNotificationIgnoredError);
  });
});
