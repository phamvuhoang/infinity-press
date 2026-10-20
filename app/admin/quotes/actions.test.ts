// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { removeSharedQuoteAction } from "@/app/admin/quotes/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { adminRemoveSharedQuote } from "@/lib/data/admin-shared-quotes";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/admin-shared-quotes", () => ({ adminRemoveSharedQuote: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("removeSharedQuoteAction", () => {
  it("removes the card and revalidates the list", async () => {
    await removeSharedQuoteAction("AbCdEfGh12", new FormData());
    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/quotes" });
    expect(adminRemoveSharedQuote).toHaveBeenCalledWith("AbCdEfGh12");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/quotes");
  });

  it("never reaches the DAL when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(removeSharedQuoteAction("AbCdEfGh12", new FormData())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(adminRemoveSharedQuote).not.toHaveBeenCalled();
  });
});
