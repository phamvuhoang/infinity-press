// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORDER = "11111111-1111-4111-8111-111111111111";

const configureGift = vi.fn();
const removeGift = vi.fn();
const requireUser = vi.fn(async () => ({ id: "user" }));
const revalidatePath = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/auth/session", () => ({ requireUser }));
vi.mock("@/lib/commerce/gifts", async () => {
  const actual = await vi.importActual<typeof import("@/lib/commerce/gifts")>("@/lib/commerce/gifts");
  return { ...actual, configureGift, removeGift };
});

const { saveGiftAction, removeGiftAction } = await import("@/app/[lang]/(account)/checkout/[orderId]/gift-actions");
const { GiftNotConfigurableError } = await import("@/lib/commerce/gifts");

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const idle = { status: "idle" } as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("saveGiftAction", () => {
  it("gates on its own signed-in user before touching the order", async () => {
    await saveGiftAction("en", ORDER, idle, form({ recipientEmail: "friend@example.com" }));

    expect(requireUser).toHaveBeenCalled();
    expect(requireUser.mock.invocationCallOrder[0]).toBeLessThan(configureGift.mock.invocationCallOrder[0]);
  });

  it("sends an unknown locale home rather than acting on the order", async () => {
    await expect(saveGiftAction("de", ORDER, idle, form({ recipientEmail: "friend@example.com" }))).rejects.toThrow("REDIRECT:/vi");
    expect(configureGift).not.toHaveBeenCalled();
  });

  it("saves a normalized recipient and message, then revalidates the checkout", async () => {
    const state = await saveGiftAction(
      "en",
      ORDER,
      idle,
      form({ recipientEmail: "  Friend@Example.COM ", message: "  Happy birthday  " }),
    );

    expect(configureGift).toHaveBeenCalledExactlyOnceWith("en", ORDER, {
      recipientEmail: "friend@example.com",
      message: "Happy birthday",
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/en/checkout/${ORDER}`);
    expect(state).toEqual({ status: "saved" });
  });

  it("treats a blank message as no message", async () => {
    await saveGiftAction("en", ORDER, idle, form({ recipientEmail: "friend@example.com", message: "   " }));

    expect(configureGift).toHaveBeenCalledExactlyOnceWith("en", ORDER, {
      recipientEmail: "friend@example.com",
      message: null,
    });
  });

  it("reports a field error for an invalid address without calling the RPC", async () => {
    const state = await saveGiftAction("en", ORDER, idle, form({ recipientEmail: "not-an-address" }));

    expect(state).toEqual({ status: "invalid", recipientEmail: "invalidEmail", message: null });
    expect(configureGift).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a field error for an over-long message", async () => {
    const state = await saveGiftAction(
      "en",
      ORDER,
      idle,
      form({ recipientEmail: "friend@example.com", message: "x".repeat(501) }),
    );

    expect(state).toEqual({ status: "invalid", recipientEmail: null, message: "messageTooLong" });
    expect(configureGift).not.toHaveBeenCalled();
  });

  it("reports both field errors at once", async () => {
    const state = await saveGiftAction("en", ORDER, idle, form({ recipientEmail: "nope", message: "x".repeat(501) }));

    expect(state).toEqual({ status: "invalid", recipientEmail: "invalidEmail", message: "messageTooLong" });
  });

  it("turns the order's refusal into one unavailable state", async () => {
    configureGift.mockRejectedValueOnce(new GiftNotConfigurableError());

    const state = await saveGiftAction("en", ORDER, idle, form({ recipientEmail: "friend@example.com" }));

    expect(state).toEqual({ status: "unavailable" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("lets an unexpected failure through rather than reporting success", async () => {
    configureGift.mockRejectedValueOnce(new Error("configureGift: configure_gift failed: boom"));

    await expect(saveGiftAction("en", ORDER, idle, form({ recipientEmail: "friend@example.com" }))).rejects.toThrow("boom");
  });
});

describe("removeGiftAction", () => {
  it("gates, removes, revalidates and returns to idle", async () => {
    const state = await removeGiftAction("en", ORDER, { status: "saved" }, new FormData());

    expect(requireUser).toHaveBeenCalled();
    expect(removeGift).toHaveBeenCalledExactlyOnceWith("en", ORDER);
    expect(revalidatePath).toHaveBeenCalledWith(`/en/checkout/${ORDER}`);
    expect(state).toEqual({ status: "idle" });
  });

  it("sends an unknown locale home rather than removing anything", async () => {
    await expect(removeGiftAction("de", ORDER, idle, new FormData())).rejects.toThrow("REDIRECT:/vi");
    expect(removeGift).not.toHaveBeenCalled();
  });

  it("turns the order's refusal into one unavailable state", async () => {
    removeGift.mockRejectedValueOnce(new GiftNotConfigurableError());

    await expect(removeGiftAction("en", ORDER, idle, new FormData())).resolves.toEqual({ status: "unavailable" });
  });
});
