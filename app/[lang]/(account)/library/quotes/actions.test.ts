// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { removeSharedQuoteAction } from "@/app/[lang]/(account)/library/quotes/actions";
import { requireUser } from "@/lib/auth/session";
import { removeMySharedQuote } from "@/lib/data/shared-quotes";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/shared-quotes", () => ({ removeMySharedQuote: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("removeSharedQuoteAction", () => {
  it("gates on the session, removes the card, and revalidates the page", async () => {
    await removeSharedQuoteAction("vi", "AbCdEfGh12");
    expect(requireUser).toHaveBeenCalledWith("vi", "/vi/library/quotes");
    expect(removeMySharedQuote).toHaveBeenCalledWith("AbCdEfGh12");
    expect(revalidatePath).toHaveBeenCalledWith("/vi/library/quotes");
    expect(vi.mocked(requireUser).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(removeMySharedQuote).mock.invocationCallOrder[0]);
  });

  it("never reaches the DAL when the session gate rejects", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Error("NEXT_REDIRECT /vi/sign-in"));
    await expect(removeSharedQuoteAction("vi", "AbCdEfGh12")).rejects.toThrow("NEXT_REDIRECT");
    expect(removeMySharedQuote).not.toHaveBeenCalled();
  });
});
