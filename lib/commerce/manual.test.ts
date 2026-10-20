// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ManualProvider, ManualProviderEventError, buildVietQrImageUrl } from "@/lib/commerce/manual";

describe("ManualProvider", () => {
  it("sends the reader to the internal transfer page, never off site", async () => {
    const session = await new ManualProvider().createSession({
      orderId: "11111111-1111-4111-8111-111111111111",
      locale: "vi",
    });
    expect(session.redirectUrl).toBe("/vi/checkout/11111111-1111-4111-8111-111111111111/transfer");
  });

  it("refuses every inbound request: a manual event never arrives over HTTP", async () => {
    const request = new Request("http://internal/api/payments/manual/webhook", { method: "POST", body: "{}" });
    await expect(new ManualProvider().verifyEvent(request)).rejects.toBeInstanceOf(ManualProviderEventError);
  });
});

describe("buildVietQrImageUrl", () => {
  it("builds a static image URL carrying the account, amount in major units, and reference", () => {
    const url = new URL(
      buildVietQrImageUrl({
        bankCode: "970436",
        accountNumber: "0123456789",
        accountHolder: "CONG TY INFINITY BOOKS",
        amountMinor: 129000,
        currency: "VND",
        reference: "IB-7K3QX",
      })!,
    );
    expect(url.origin).toBe("https://img.vietqr.io");
    expect(url.pathname).toBe("/image/970436-0123456789-compact2.png");
    expect(url.searchParams.get("amount")).toBe("129000");
    expect(url.searchParams.get("addInfo")).toBe("IB-7K3QX");
    expect(url.searchParams.get("accountName")).toBe("CONG TY INFINITY BOOKS");
  });

  it("never emits a credential or a secret in the query string", () => {
    const url = buildVietQrImageUrl({
      bankCode: "970436",
      accountNumber: "0123456789",
      accountHolder: "CONG TY INFINITY BOOKS",
      amountMinor: 1,
      currency: "VND",
      reference: "IB-AAAAA",
    });
    expect(url).not.toMatch(/key|secret|token/i);
  });

  // The amount goes into the QR as major units. VND has no minor unit, so the order's minor amount
  // is already the major one; for a currency with two, the same line would encode 100 times the
  // money owed into a code a reader scans and pays. No QR rather than a wrong one - the bank
  // details printed beside it are complete on their own, which is why they are printed at all.
  it.each(["USD", "EUR", "JPY"])("declines to build a QR for %s, whose minor units are not major", (currency) => {
    expect(
      buildVietQrImageUrl({
        bankCode: "970436",
        accountNumber: "0123456789",
        accountHolder: "CONG TY INFINITY BOOKS",
        amountMinor: 129000,
        currency,
        reference: "IB-7K3QX",
      }),
    ).toBeNull();
  });
});
