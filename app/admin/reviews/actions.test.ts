// @vitest-environment node
import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { moderateReviewAction, replyReviewAction } from "@/app/admin/reviews/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { moderateReview, replyReview, StaleReviewError } from "@/lib/data/admin-reviews";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/data/admin-reviews", async (original) => ({
  ...await original<typeof import("@/lib/data/admin-reviews")>(), moderateReview: vi.fn(), replyReview: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moderateReviewAction", () => {
  it("publishes and revalidates the storefront and the admin list", async () => {
    await moderateReviewAction("r1", "published", 7, initialAdminFormState, new FormData());
    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/reviews" });
    expect(moderateReview).toHaveBeenCalledWith("r1", "published", 7);
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
  });

  it("refreshes a stale review and asks the moderator to read it again", async () => {
    vi.mocked(moderateReview).mockRejectedValueOnce(new StaleReviewError());
    const state = await moderateReviewAction("r1", "published", 7, initialAdminFormState, new FormData());
    expect(state.formError).toContain("Read the refreshed review");
    expect(state.savedAt).toBeNull();
    expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
    expect(revalidatePath).not.toHaveBeenCalledWith("/[lang]", "layout");
  });

  it("never reaches the DAL when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(moderateReviewAction("r1", "rejected", 7, initialAdminFormState, new FormData())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(moderateReview).not.toHaveBeenCalled();
  });

  it("rejects an unknown status before the DAL", async () => {
    expect((await moderateReviewAction("r1", "deleted" as never, 7, initialAdminFormState, new FormData())).formError).toBeTruthy();
    expect(moderateReview).not.toHaveBeenCalled();
  });
});

describe("replyReviewAction", () => {
  it("rejects an html reply before the DAL", async () => {
    const form = new FormData();
    form.set("reply", "<b>x</b>");
    const state = await replyReviewAction("r1", initialAdminFormState, form);
    expect(state.fieldErrors.reply).toBeDefined();
    expect(replyReview).not.toHaveBeenCalled();
  });

  it("gates on the admin before parsing", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(replyReviewAction("r1", initialAdminFormState, new FormData())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(replyReview).not.toHaveBeenCalled();
  });

  it("saves a trimmed reply and revalidates", async () => {
    const form = new FormData();
    form.set("reply", "  Thank you!  ");
    const state = await replyReviewAction("r1", initialAdminFormState, form);
    expect(replyReview).toHaveBeenCalledWith("r1", "Thank you!");
    expect(state.savedAt).toEqual(expect.any(Number));
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/admin/reviews");
  });

  it("normalises a blank reply to null so it clears the reply", async () => {
    const form = new FormData();
    form.set("reply", "   ");
    const state = await replyReviewAction("r1", initialAdminFormState, form);
    expect(replyReview).toHaveBeenCalledWith("r1", null);
    expect(state.formError).toBeNull();
  });

  it("rejects a reply over 1000 characters", async () => {
    const form = new FormData();
    form.set("reply", "a".repeat(1001));
    const state = await replyReviewAction("r1", initialAdminFormState, form);
    expect(state.fieldErrors.reply).toBeDefined();
    expect(replyReview).not.toHaveBeenCalled();
  });

  it("returns a generic error without raw database text when the DAL fails", async () => {
    vi.mocked(replyReview).mockRejectedValueOnce(new Error("pg: secret detail"));
    const form = new FormData();
    form.set("reply", "ok");
    const state = await replyReviewAction("r1", initialAdminFormState, form);
    expect(state.formError).toBe("Something went wrong saving. Try again.");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
