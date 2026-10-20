// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
const requireAdmin = vi.fn(async () => ({ id: "admin" }));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin }));

const {
  GiftAlreadyClaimedError,
  GiftNotFoundError,
  GiftNotSendableError,
  MAX_GIFT_QUERY_LENGTH,
  reissueGift,
  resendGift,
  searchAdminGifts,
} = await import("@/lib/data/gifts");
const { hashGiftToken } = await import("@/lib/commerce/gift-token");

const giftId = "f9000000-0000-0000-0000-000000000001";

const ROW = {
  gift_id: giftId,
  order_id: "f8000000-0000-0000-0000-000000000001",
  reference_code: "IB-A0001",
  purchaser_email: "purchaser@example.test",
  recipient_email: "recipient@example.test",
  item_titles: ["Admin One", "Admin Two"],
  item_count: 2,
  status: "sent",
  claim_locale: "vi",
  created_at: "2026-09-22T00:00:00Z",
  claimed_at: null,
  revoked_at: null,
  attempt_count: 5,
  last_error_code: "smtp_timeout",
  sent_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
});

describe("searchAdminGifts", () => {
  it("maps the RPC row to the DTO", async () => {
    rpc.mockResolvedValue({ data: [ROW], error: null });

    await expect(searchAdminGifts("IB-A0001")).resolves.toEqual([
      {
        id: giftId,
        orderId: "f8000000-0000-0000-0000-000000000001",
        referenceCode: "IB-A0001",
        purchaserEmail: "purchaser@example.test",
        recipientEmail: "recipient@example.test",
        itemTitles: ["Admin One", "Admin Two"],
        itemCount: 2,
        status: "sent",
        claimLocale: "vi",
        createdAt: "2026-09-22T00:00:00Z",
        claimedAt: null,
        revokedAt: null,
        attemptCount: 5,
        lastErrorCode: "smtp_timeout",
        sentAt: null,
      },
    ]);
  });

  it("authorizes before it has a client to query with", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(searchAdminGifts("IB-A0001")).rejects.toThrow("Forbidden");

    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("trims and bounds the query rather than passing a pasted document to the database", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await searchAdminGifts(`  ${"x".repeat(500)}  `);

    expect(rpc).toHaveBeenCalledWith("admin_search_gifts", { p_query: "x".repeat(MAX_GIFT_QUERY_LENGTH) });
  });

  it("sends an empty query for no query at all, which lists the newest gifts", async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    await searchAdminGifts(undefined);

    expect(rpc).toHaveBeenCalledWith("admin_search_gifts", { p_query: "" });
  });

  it("drops a claim locale it does not recognise rather than trusting a stored path", async () => {
    rpc.mockResolvedValue({ data: [{ ...ROW, claim_locale: "fr" }], error: null });

    await expect(searchAdminGifts("")).resolves.toMatchObject([{ claimLocale: null }]);
  });

  it("fails loudly rather than pretending there are no gifts", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });

    await expect(searchAdminGifts("")).rejects.toThrow(/searchAdminGifts/);
  });
});

describe("resendGift", () => {
  it("asks the database to retry the one delivery", async () => {
    await resendGift(giftId);

    expect(rpc).toHaveBeenCalledWith("admin_resend_gift", { p_gift_id: giftId });
  });

  it("authorizes before it has a client to mutate with", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(resendGift(giftId)).rejects.toThrow("Forbidden");

    expect(createClient).not.toHaveBeenCalled();
  });

  it("names EB030 as a gift with no delivery to retry", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB030", message: "is claimed" } });

    await expect(resendGift(giftId)).rejects.toBeInstanceOf(GiftNotSendableError);
  });

  it("names P0002 as a gift that is gone", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "does not exist" } });

    await expect(resendGift(giftId)).rejects.toBeInstanceOf(GiftNotFoundError);
  });

  it("does not disguise an unexpected failure as a known refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });

    await expect(resendGift(giftId)).rejects.toThrow(/resendGift/);
  });
});

describe("reissueGift", () => {
  it("sends the hash and the localized claim path, and never the token", async () => {
    await reissueGift(giftId, "new@example.test", "en", "wrong address");

    const [name, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(name).toBe("admin_reissue_gift");
    expect(args.p_gift_id).toBe(giftId);
    expect(args.p_recipient_email).toBe("new@example.test");
    expect(args.p_reason).toBe("wrong address");
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The path carries the raw token, and the hash must be the hash OF that token - otherwise the
    // recipient would be mailed a link that claims nothing.
    const token = args.p_claim_path.replace("/en/gifts/claim/", "");
    expect(args.p_claim_path).toBe(`/en/gifts/claim/${token}`);
    await expect(hashGiftToken(token)).resolves.toBe(args.p_token_hash);
  });

  it("returns nothing, so no caller can put the new token in front of a browser", async () => {
    await expect(reissueGift(giftId, "new@example.test", "vi", "wrong address")).resolves.toBeUndefined();
  });

  it("generates a different token on every call", async () => {
    await reissueGift(giftId, "new@example.test", "vi", "first");
    await reissueGift(giftId, "new@example.test", "vi", "second");

    const [, first] = rpc.mock.calls[0] as [string, Record<string, string>];
    const [, second] = rpc.mock.calls[1] as [string, Record<string, string>];
    expect(first.p_token_hash).not.toBe(second.p_token_hash);
  });

  it("builds the claim path in the locale it is given", async () => {
    await reissueGift(giftId, "new@example.test", "vi", "wrong address");

    const [, args] = rpc.mock.calls[0] as [string, Record<string, string>];
    expect(args.p_claim_path.startsWith("/vi/gifts/claim/")).toBe(true);
  });

  it("authorizes before it generates a token or has a client to mutate with", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("Forbidden"));

    await expect(reissueGift(giftId, "new@example.test", "vi", "wrong address")).rejects.toThrow("Forbidden");

    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("names EB031 as a gift that has already been claimed", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB031", message: "claimed" } });

    await expect(reissueGift(giftId, "new@example.test", "vi", "wrong address")).rejects.toBeInstanceOf(
      GiftAlreadyClaimedError,
    );
  });

  it("does not disguise an unexpected failure as a known refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "check violation" } });

    await expect(reissueGift(giftId, "new@example.test", "vi", "wrong address")).rejects.toThrow(/reissueGift/);
  });
});
