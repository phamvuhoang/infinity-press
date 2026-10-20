// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ManualProvider } from "@/lib/commerce/manual";
import { arePaymentsEnabled, getPaymentProvider, PaymentProviderDisabledError } from "@/lib/commerce/payment-provider";
import { SimulatorProvider } from "@/lib/commerce/simulator";

vi.mock("@/lib/access/grant", () => ({ findOrderIdByReference: vi.fn() }));

describe("payment provider selection", () => {
  it("treats only PAYMENT_PROVIDER=disabled as disabled", () => {
    expect(arePaymentsEnabled({ paymentProvider: "disabled" })).toBe(false);
    expect(arePaymentsEnabled({ paymentProvider: "simulator" })).toBe(true);
  });

  it("treats manual as payments enabled", () => {
    expect(arePaymentsEnabled({ paymentProvider: "manual" })).toBe(true);
  });

  it("fails closed when payments are disabled", () => {
    expect(() => getPaymentProvider({ appEnv: "production", paymentProvider: "disabled", simulatorSecret: null, sepay: null })).toThrow(
      PaymentProviderDisabledError,
    );
  });

  it("returns the simulator with its secret", () => {
    const provider = getPaymentProvider({ appEnv: "test", paymentProvider: "simulator", simulatorSecret: "test-simulator-secret-0123456789abcdef", sepay: null });
    expect(provider).toBeInstanceOf(SimulatorProvider);
  });

  it("builds a manual provider when PAYMENT_PROVIDER=manual, including in production", () => {
    const provider = getPaymentProvider({ appEnv: "production", paymentProvider: "manual", simulatorSecret: null, sepay: null });
    expect(provider).toBeInstanceOf(ManualProvider);
  });

  it("returns the SePay provider, which sends Pay to the hand-off page", async () => {
    const provider = getPaymentProvider({
      appEnv: "test",
      paymentProvider: "sepay",
      simulatorSecret: null,
      sepay: { merchantId: "M", secretKey: "s", env: "sandbox" },
    });
    expect(await provider.createSession({ orderId: "o1", locale: "vi" })).toEqual({ redirectUrl: "/vi/checkout/o1/sepay" });
  });
});
