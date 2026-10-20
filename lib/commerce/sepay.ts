import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { findOrderIdByReference } from "@/lib/access/grant";
import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
import type { Locale } from "@/lib/i18n/config";
import { getCommerceRoutes } from "@/lib/i18n/routes";

// SePay's hosted payment gateway, bank-transfer (VietQR) method only (S18 spec). The reader pays on
// SePay's page; SePay's notification (IPN) is the only thing that completes an order.
export type SepayConfig = { merchantId: string; secretKey: string; env: "sandbox" | "production" };

const CHECKOUT_URLS = {
  sandbox: "https://pay-sandbox.sepay.vn/v1/checkout/init",
  production: "https://pay.sepay.vn/v1/checkout/init",
} as const;

export function sepayCheckoutUrl(env: SepayConfig["env"]): string {
  return CHECKOUT_URLS[env];
}

// The amount is part of the invoice number because a coupon can reprice a pending order after a
// first trip to SePay, and SePay keys an order on this number. Unchanged order, same SePay order;
// repriced order, new one - with nothing stored (S18 spec 5.2).
const INVOICE_PATTERN = /^(IB-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5})-(\d+)$/;

export function buildSepayInvoiceNumber(referenceCode: string, totalMinor: number): string {
  return `${referenceCode}-${totalMinor}`;
}

export function parseSepayInvoiceNumber(value: string): { referenceCode: string; amountMinor: number } | null {
  const match = INVOICE_PATTERN.exec(value);
  return match ? { referenceCode: match[1], amountMinor: Number(match[2]) } : null;
}

// base64(HMAC-SHA256(secret, "k1=v1,k2=v2,...")) over the fields in the order they are posted.
// This is what sepay-pg-node 1.0.0 computes; the docs do not describe it. Every field this module
// sends is in SePay's signed set, so there is no filtering step.
export function signSepayFields(fields: ReadonlyArray<readonly [string, string]>, secretKey: string): string {
  return createHmac("sha256", secretKey)
    .update(fields.map(([name, value]) => `${name}=${value}`).join(","))
    .digest("base64");
}

// The form's inputs, in the order they must be rendered: the signature covers that order. Null for
// an order SePay cannot take. order_amount is the minor amount passed straight through, which is
// right for VND and 100x wrong for any currency with a minor unit - the same rule as
// buildVietQrImageUrl in lib/commerce/manual.ts.
export function buildSepayCheckoutFields(input: {
  order: { id: string; referenceCode: string; totalMinor: number; currency: string };
  locale: Locale;
  siteUrl: string;
  config: SepayConfig;
}): Array<[string, string]> | null {
  const { order, config } = input;
  if (order.currency !== "VND") return null;
  // A return to any of these never changes the order; the parameter only picks what the status
  // page says while the order is still pending.
  const statusUrl = `${input.siteUrl}${getCommerceRoutes(input.locale).checkoutStatus(order.id)}`;
  const fields: Array<[string, string]> = [
    ["operation", "PURCHASE"],
    ["payment_method", "BANK_TRANSFER"],
    ["order_invoice_number", buildSepayInvoiceNumber(order.referenceCode, order.totalMinor)],
    ["order_amount", String(order.totalMinor)],
    ["currency", "VND"],
    ["order_description", `Infinity Books ${order.referenceCode}`],
    ["success_url", `${statusUrl}?sepay=success`],
    ["error_url", `${statusUrl}?sepay=error`],
    ["cancel_url", `${statusUrl}?sepay=cancel`],
    ["merchant", config.merchantId],
  ];
  return [...fields, ["signature", signSepayFields(fields, config.secretKey)]];
}

export const SEPAY_SECRET_HEADER = "x-secret-key";

// The IPN's whole authentication: SePay sends the merchant secret in a header and signs nothing.
export function hasValidSepaySecret(header: string | null, secretKey: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(secretKey);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class MalformedSepayNotificationError extends Error {
  // What the body said about the payment, so an operator can find money the parser refused. Set by
  // parseSepayNotification once the body is known to be a JSON object; strings only, bounded.
  hints: Record<string, string> = {};

  constructor(reason: string) {
    super(`SePay notification is malformed (${reason})`);
    this.name = "MalformedSepayNotificationError";
  }
}

// A well-formed notification that is not a completed bank-transfer payment. Acknowledged and
// logged, never applied.
export class SepayNotificationIgnoredError extends Error {
  constructor(readonly reason: string) {
    super(`SePay notification ignored (${reason})`);
    this.name = "SepayNotificationIgnoredError";
  }
}

export type SepayPaidNotification = {
  referenceCode: string;
  invoiceNumber: string;
  eventId: string;
  externalPaymentId: string;
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new MalformedSepayNotificationError(field);
  return value;
}

function hint(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value).slice(0, 64) : undefined;
}

export function parseSepayNotification(raw: string): SepayPaidNotification {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new MalformedSepayNotificationError("json");
  }
  if (!isRecord(body)) throw new MalformedSepayNotificationError("json");

  try {
    return parseNotificationBody(body);
  } catch (error) {
    if (error instanceof MalformedSepayNotificationError) {
      const order = isRecord(body.order) ? body.order : {};
      const found = {
        invoiceNumber: hint(order.order_invoice_number),
        externalPaymentId: hint(order.order_id),
        amount: hint(order.order_amount),
      };
      error.hints = Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined)) as Record<
        string,
        string
      >;
    }
    throw error;
  }
}

function parseNotificationBody(body: Record<string, unknown>): SepayPaidNotification {
  const type = text(body.notification_type, "notification_type");
  if (type !== "ORDER_PAID") throw new SepayNotificationIgnoredError(`notification_type=${type}`);

  const { order, transaction, timestamp } = body;
  if (!isRecord(order)) throw new MalformedSepayNotificationError("order");
  if (!isRecord(transaction)) throw new MalformedSepayNotificationError("transaction");
  if (order.order_status !== "CAPTURED" || transaction.transaction_status !== "APPROVED") {
    throw new SepayNotificationIgnoredError(
      `order_status=${String(order.order_status)} transaction_status=${String(transaction.transaction_status)}`,
    );
  }

  const method = text(transaction.payment_method, "payment_method");
  if (method !== "BANK_TRANSFER") throw new SepayNotificationIgnoredError(`payment_method=${method}`);

  const invoiceNumber = text(order.order_invoice_number, "order_invoice_number");
  const invoice = parseSepayInvoiceNumber(invoiceNumber);
  if (!invoice) throw new MalformedSepayNotificationError("order_invoice_number");

  // "89000.00", "89000", or 89000. Anything with a fraction is refused rather than rounded:
  // apply_payment_event compares this to the order's total.
  const amountText = typeof order.order_amount === "number" ? String(order.order_amount) : order.order_amount;
  if (typeof amountText !== "string" || !/^\d+(\.0+)?$/.test(amountText)) {
    throw new MalformedSepayNotificationError("order_amount");
  }
  const amountMinor = Number(amountText);
  if (!Number.isSafeInteger(amountMinor)) throw new MalformedSepayNotificationError("order_amount");

  if (typeof timestamp !== "number" || !Number.isInteger(timestamp) || timestamp <= 0) {
    throw new MalformedSepayNotificationError("timestamp");
  }

  return {
    referenceCode: invoice.referenceCode,
    invoiceNumber,
    eventId: text(transaction.transaction_id, "transaction_id"),
    externalPaymentId: text(order.order_id, "order_id"),
    amountMinor,
    currency: text(order.order_currency, "order_currency"),
    occurredAt: new Date(timestamp * 1000).toISOString(),
  };
}

export class InvalidSepaySecretError extends Error {
  constructor() {
    super("SepayProvider.verifyEvent: missing or invalid X-Secret-Key");
    this.name = "InvalidSepaySecretError";
  }
}

// SePay took a payment for a reference no order has. The fields are what an operator needs to
// find the money.
export class SepayOrderNotFoundError extends Error {
  constructor(
    readonly invoiceNumber: string,
    readonly externalPaymentId: string,
  ) {
    super("SepayProvider.verifyEvent: no order has this reference");
    this.name = "SepayOrderNotFoundError";
  }
}

export class SepayProvider implements PaymentProvider {
  constructor(private readonly config: SepayConfig) {}

  // SePay's checkout takes a signed form POST, which a redirect cannot carry, so Pay lands on a
  // page of ours that posts it.
  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutSepay(input.orderId) };
  }

  // The secret is checked before the body is parsed and before any database read. The invoice
  // number rides along for the handler's logs; it is not part of the provider-neutral event.
  async verifyEvent(request: Request): Promise<VerifiedPaymentEvent & { invoiceNumber: string }> {
    if (!hasValidSepaySecret(request.headers.get(SEPAY_SECRET_HEADER), this.config.secretKey)) {
      throw new InvalidSepaySecretError();
    }
    const paid = parseSepayNotification(await request.text());
    const orderId = await findOrderIdByReference(paid.referenceCode);
    if (!orderId) throw new SepayOrderNotFoundError(paid.invoiceNumber, paid.externalPaymentId);
    return {
      provider: "sepay",
      eventId: paid.eventId,
      externalPaymentId: paid.externalPaymentId,
      orderId,
      status: "succeeded",
      amountMinor: paid.amountMinor,
      currency: paid.currency,
      occurredAt: paid.occurredAt,
      invoiceNumber: paid.invoiceNumber,
    };
  }
}
