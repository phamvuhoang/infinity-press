// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initialGiftActionState, reissueGiftAction, resendGiftAction } from "@/app/admin/gifts/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { GiftAlreadyClaimedError, GiftNotFoundError, GiftNotSendableError, reissueGift, resendGift } from "@/lib/data/gifts";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/data/gifts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/data/gifts")>();
  return { ...original, resendGift: vi.fn(), reissueGift: vi.fn() };
});

const giftId = "f9000000-0000-0000-0000-000000000001";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const validReissue = (overrides: Record<string, string> = {}) =>
  form({ recipientEmail: "New@Example.test", locale: "vi", reason: "wrong address", ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("resendGiftAction", () => {
  it("gates on requireAdmin for its own page, before touching the data layer", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(resendGiftAction(giftId, initialGiftActionState, form({}))).rejects.toThrow("NEXT_FORBIDDEN");

    expect(resendGift).not.toHaveBeenCalled();
  });

  it("names the gifts page as the sign-in destination", async () => {
    await resendGiftAction(giftId, initialGiftActionState, form({}));

    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/gifts" });
  });

  it("resends and revalidates the list so the delivery state on screen is the new one", async () => {
    const result = await resendGiftAction(giftId, initialGiftActionState, form({}));

    expect(resendGift).toHaveBeenCalledWith(giftId);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/gifts");
    expect(result.status).toBe("done");
  });

  it("explains a gift that has nothing to resend instead of failing generically", async () => {
    vi.mocked(resendGift).mockRejectedValue(new GiftNotSendableError());

    const result = await resendGiftAction(giftId, initialGiftActionState, form({}));

    expect(result).toEqual({ status: "error", message: new GiftNotSendableError().message });
  });

  it("explains a gift that is gone", async () => {
    vi.mocked(resendGift).mockRejectedValue(new GiftNotFoundError());

    const result = await resendGiftAction(giftId, initialGiftActionState, form({}));

    expect(result).toEqual({ status: "error", message: new GiftNotFoundError().message });
  });

  it("does not leak an unexpected failure's text to the operator", async () => {
    vi.mocked(resendGift).mockRejectedValue(new Error("connection to db at 10.0.0.4 refused"));

    const result = await resendGiftAction(giftId, initialGiftActionState, form({}));

    expect(result.status).toBe("error");
    expect(result).not.toMatchObject({ message: expect.stringContaining("10.0.0.4") });
  });
});

describe("reissueGiftAction", () => {
  it("gates on requireAdmin independently of the page that rendered the form", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));

    await expect(reissueGiftAction(giftId, initialGiftActionState, validReissue())).rejects.toThrow("NEXT_FORBIDDEN");

    expect(reissueGift).not.toHaveBeenCalled();
  });

  it("normalizes the address and passes the reason through", async () => {
    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue());

    expect(reissueGift).toHaveBeenCalledWith(giftId, "new@example.test", "vi", "wrong address");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/gifts");
    expect(result.status).toBe("done");
  });

  it("requires a new address", async () => {
    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue({ recipientEmail: "   " }));

    expect(result.status).toBe("error");
    expect(reissueGift).not.toHaveBeenCalled();
  });

  it("refuses an address that is not one", async () => {
    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue({ recipientEmail: "not-an-address" }));

    expect(result.status).toBe("error");
    expect(reissueGift).not.toHaveBeenCalled();
  });

  it("requires a reason, because a reissue moves a paid-for gift to somebody else", async () => {
    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue({ reason: "   " }));

    expect(result).toEqual({ status: "error", message: expect.stringContaining("reason") });
    expect(reissueGift).not.toHaveBeenCalled();
  });

  it("falls back to the default locale rather than trusting an unknown one from the form", async () => {
    await reissueGiftAction(giftId, initialGiftActionState, validReissue({ locale: "fr" }));

    expect(reissueGift).toHaveBeenCalledWith(giftId, "new@example.test", "en", "wrong address");
  });

  it("sends the message in the language the form asked for", async () => {
    await reissueGiftAction(giftId, initialGiftActionState, validReissue({ locale: "ja" }));

    expect(reissueGift).toHaveBeenCalledWith(giftId, "new@example.test", "ja", "wrong address");
  });

  it("explains a claimed gift and points at the revocation route instead", async () => {
    vi.mocked(reissueGift).mockRejectedValue(new GiftAlreadyClaimedError());

    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue());

    expect(result).toEqual({ status: "error", message: new GiftAlreadyClaimedError().message });
  });

  it("never returns anything that could carry the new claim link", async () => {
    const result = await reissueGiftAction(giftId, initialGiftActionState, validReissue());

    expect(JSON.stringify(result)).not.toMatch(/gifts\/claim/);
  });
});
