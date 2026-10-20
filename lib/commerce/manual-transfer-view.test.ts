import { describe, expect, it } from "vitest";

import { resolveManualTransferState } from "@/lib/commerce/manual-transfer-view";

const DECLINED = "2026-09-20T10:00:00+00:00";
const BEFORE = "2026-09-20T09:00:00+00:00";
const AFTER = "2026-09-20T11:00:00+00:00";

describe("resolveManualTransferState", () => {
  it("waits for the reader when nothing has been reported", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "pending", claimedAt: null, declinedAt: null }),
    ).toBe("awaiting_transfer");
  });

  it("waits for us once the reader has reported a transfer", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "pending", claimedAt: BEFORE, declinedAt: null }),
    ).toBe("awaiting_confirmation");
  });

  it("is declined when an admin marked the money as not received", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", claimedAt: null, declinedAt: DECLINED }),
    ).toBe("declined");
  });

  it("keeps declined ahead of a claim the decline already answered", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", claimedAt: BEFORE, declinedAt: DECLINED }),
    ).toBe("declined");
  });

  // The rule this function used to get wrong. payment_status stays 'failed' for good - nothing
  // resets it - so a reader who transfers again and reports it again was shown the decline banner
  // and the report button for ever, on the screen the runbook tells them to use as many times as
  // it takes. Recency, not precedence: a report made after the decline is news the decline cannot
  // speak to.
  it("returns to awaiting confirmation when the reader reports again after a decline", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", claimedAt: AFTER, declinedAt: DECLINED }),
    ).toBe("awaiting_confirmation");
  });

  it("treats a claim with no decline behind it as current", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", claimedAt: AFTER, declinedAt: null }),
    ).toBe("awaiting_confirmation");
  });

  // A tie is the pre-decline claim, not a new one: reject_manual_payment deletes the claim in the
  // same transaction that writes the decline, so anything not strictly newer predates it.
  it("counts a claim stamped at the decline's own instant as answered", () => {
    expect(
      resolveManualTransferState({ orderStatus: "pending", paymentStatus: "failed", claimedAt: DECLINED, declinedAt: DECLINED }),
    ).toBe("declined");
  });

  // Offsets differ between the two columns only in theory, but string comparison would get this
  // backwards if they ever did, so the comparison is on instants.
  it("compares instants, not strings, across time zone offsets", () => {
    expect(
      resolveManualTransferState({
        orderStatus: "pending",
        paymentStatus: "failed",
        claimedAt: "2026-09-20T18:00:00+07:00",
        declinedAt: "2026-09-20T12:00:00+00:00",
      }),
    ).toBe("declined");
  });

  it("is confirmed for a completed order regardless of the claim", () => {
    for (const claimedAt of [AFTER, null]) {
      expect(
        resolveManualTransferState({ orderStatus: "completed", paymentStatus: "succeeded", claimedAt, declinedAt: null }),
      ).toBe("confirmed");
    }
  });

  it("is cancelled for a cancelled order, which outranks every other signal", () => {
    expect(
      resolveManualTransferState({ orderStatus: "cancelled", paymentStatus: "failed", claimedAt: AFTER, declinedAt: DECLINED }),
    ).toBe("cancelled");
  });
});
