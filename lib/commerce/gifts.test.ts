// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashGiftToken } from "@/lib/commerce/gift-token";

const rpc = vi.fn();
// Every step is recorded in one list, because the ORDER is the property under test: a Server
// Action that built its session client before checking the session would run the RPC for whoever
// asked, and the RPC's own auth.uid() gate is a backstop, not the gate.
const calls: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    calls.push("createClient");
    return { rpc };
  },
}));
vi.mock("@/lib/auth/session", () => ({
  requireUser: vi.fn(async () => {
    calls.push("requireUser");
    return { id: "user" };
  }),
}));

const { configureGift, removeGift, getMyOrderGift, claimGift, GiftNotConfigurableError, GiftClaimRejectedError } =
  await import("@/lib/commerce/gifts");

const ORDER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  rpc.mockReset();
  calls.length = 0;
});

describe("configureGift", () => {
  it("sends only the hash and the localized claim path, and returns nothing", async () => {
    rpc.mockResolvedValue({ data: null, error: null });

    await expect(configureGift("en", ORDER, { recipientEmail: "friend@example.test", message: "Enjoy" })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe("configure_gift");
    expect(Object.keys(args).sort()).toEqual([
      "p_claim_path",
      "p_message",
      "p_order_id",
      "p_recipient_email",
      "p_token_hash",
    ]);
    expect(args.p_order_id).toBe(ORDER);
    expect(args.p_recipient_email).toBe("friend@example.test");
    expect(args.p_message).toBe("Enjoy");
    // The shape gifts_claim_token_hash_check enforces, which no base64url token can satisfy.
    expect(args.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("puts a freshly generated token in the claim path and its hash in the row", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await configureGift("vi", ORDER, { recipientEmail: "friend@example.test", message: null });

    const args = rpc.mock.calls[0][1] as { p_claim_path: string; p_token_hash: string };
    const [, token] = args.p_claim_path.match(/^\/vi\/gifts\/claim\/([A-Za-z0-9_-]{43})$/) ?? [];
    expect(token).toBeDefined();
    // The one link between the two values: the path carries the token, the row carries its hash,
    // and nothing carries both.
    expect(await hashGiftToken(token as string)).toBe(args.p_token_hash);
    expect(args.p_claim_path).not.toContain(args.p_token_hash);
  });

  it("generates a different token every time, so a replaced gift retires the old link", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await configureGift("en", ORDER, { recipientEmail: "a@example.test", message: null });
    await configureGift("en", ORDER, { recipientEmail: "a@example.test", message: null });

    const first = (rpc.mock.calls[0][1] as { p_token_hash: string }).p_token_hash;
    const second = (rpc.mock.calls[1][1] as { p_token_hash: string }).p_token_hash;
    expect(first).not.toBe(second);
  });

  it("requires a user before it creates a client", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await configureGift("en", ORDER, { recipientEmail: "friend@example.test", message: null });
    expect(calls).toEqual(["requireUser", "createClient"]);
  });

  it("maps the lifecycle refusal to a named safe error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB028", message: "not a pending order of the caller" } });
    await expect(configureGift("en", ORDER, { recipientEmail: "friend@example.test", message: null })).rejects.toBeInstanceOf(
      GiftNotConfigurableError,
    );
  });

  it("treats a session with no profile as the same refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "P0002", message: "no profile" } });
    await expect(configureGift("en", ORDER, { recipientEmail: "friend@example.test", message: null })).rejects.toBeInstanceOf(
      GiftNotConfigurableError,
    );
  });

  it("never puts the token or the claim path in the message of an unexpected failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    const error = (await configureGift("en", ORDER, { recipientEmail: "friend@example.test", message: null }).catch(
      (caught: unknown) => caught,
    )) as Error;
    const args = rpc.mock.calls[0][1] as { p_claim_path: string; p_token_hash: string };
    expect(error.message).not.toContain(args.p_claim_path);
    expect(error.message).not.toContain(args.p_token_hash);
  });
});

describe("removeGift", () => {
  it("passes the order and requires a user first", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(removeGift("en", ORDER)).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith("remove_gift", { p_order_id: ORDER });
    expect(calls).toEqual(["requireUser", "createClient"]);
  });

  it("maps EB028 to the same named error configuring does", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB028", message: "no removable gift" } });
    await expect(removeGift("en", ORDER)).rejects.toBeInstanceOf(GiftNotConfigurableError);
  });
});

describe("getMyOrderGift", () => {
  it("returns the three safe checkout fields", async () => {
    rpc.mockResolvedValue({
      data: [{ recipient_email: "friend@example.test", message: "Enjoy", status: "pending" }],
      error: null,
    });
    await expect(getMyOrderGift("en", ORDER)).resolves.toEqual({
      recipientEmail: "friend@example.test",
      message: "Enjoy",
      status: "pending",
    });
    expect(rpc).toHaveBeenCalledWith("get_my_order_gift", { p_order_id: ORDER });
  });

  it("returns null for an order with no gift", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    await expect(getMyOrderGift("en", ORDER)).resolves.toBeNull();
  });
});

describe("claimGift", () => {
  it("passes the raw URL token to the RPC and maps the books it granted", async () => {
    rpc.mockResolvedValue({
      data: [
        { book_id: "book-1", title: "One", entitlement_id: "ent-1", already_owned: false },
        { book_id: "book-2", title: "Two", entitlement_id: "ent-2", already_owned: true },
      ],
      error: null,
    });
    await expect(claimGift("vi", "raw-token")).resolves.toEqual([
      { bookId: "book-1", title: "One", entitlementId: "ent-1", alreadyOwned: false },
      { bookId: "book-2", title: "Two", entitlementId: "ent-2", alreadyOwned: true },
    ]);
    expect(rpc).toHaveBeenCalledWith("claim_gift", { p_token: "raw-token" });
    expect(calls).toEqual(["requireUser", "createClient"]);
  });

  it("turns EB029 into one refusal that says nothing about why", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "EB029", message: "no claimable gift for this token" } });
    const error = (await claimGift("vi", "raw-token").catch((caught: unknown) => caught)) as Error;
    expect(error).toBeInstanceOf(GiftClaimRejectedError);
    expect(error.message).not.toMatch(/claimed|revoked|unknown|expired/i);
  });

  it("never puts the token in the message of an unexpected failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "boom" } });
    const error = (await claimGift("vi", "raw-token").catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("raw-token");
  });
});
