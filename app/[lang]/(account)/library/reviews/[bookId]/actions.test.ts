import { beforeEach, describe, expect, it, vi } from "vitest";

import { deleteBookReviewAction, submitBookReviewAction } from "@/app/[lang]/(account)/library/reviews/[bookId]/actions";
import { requireUser } from "@/lib/auth/session";
import { initialAdminFormState } from "@/lib/catalog/form";
import { deleteBookReview, NotEntitledToReviewError, submitBookReview } from "@/lib/data/reviews";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "u1" }) }));
vi.mock("@/lib/data/reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/reviews")>()),
  submitBookReview: vi.fn(),
  deleteBookReview: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

function formWith(rating: string, body: string) {
  const form = new FormData();
  form.set("rating", rating);
  form.set("body", body);
  return form;
}

beforeEach(() => vi.clearAllMocks());

describe("submitBookReviewAction", () => {
  it("submits a parsed review and revalidates", async () => {
    const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, formWith("4", "Hay"));
    expect(requireUser).toHaveBeenCalledWith("vi", "/vi/library/reviews/b1");
    expect(submitBookReview).toHaveBeenCalledWith("b1", { rating: 4, body: "Hay" }, "vi");
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/vi/library/reviews/b1");
    expect(revalidatePath).toHaveBeenCalledWith("/vi/library");
    expect(state.savedAt).not.toBeNull();
  });

  it("returns field errors without writing when the input is invalid", async () => {
    const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, formWith("9", ""));
    expect(submitBookReview).not.toHaveBeenCalled();
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["body", "rating"]);
    expect(state.savedAt).toBeNull();
  });

  it("maps NotEntitledToReviewError to a form error key", async () => {
    vi.mocked(submitBookReview).mockRejectedValueOnce(new NotEntitledToReviewError());
    const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, formWith("4", "Hay"));
    expect(state.formError).toBe("not_entitled");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("maps any other failure to the failed key", async () => {
    vi.mocked(submitBookReview).mockRejectedValueOnce(new Error("boom"));
    const state = await submitBookReviewAction("vi", "b1", initialAdminFormState, formWith("4", "Hay"));
    expect(state.formError).toBe("failed");
  });
});

describe("deleteBookReviewAction", () => {
  it("deletes, revalidates, and returns to the library", async () => {
    await deleteBookReviewAction("en", "b1");
    expect(requireUser).toHaveBeenCalledWith("en", "/en/library/reviews/b1");
    expect(deleteBookReview).toHaveBeenCalledWith("b1");
    expect(revalidatePath).toHaveBeenCalledWith("/[lang]", "layout");
    expect(redirect).toHaveBeenCalledWith("/en/library");
  });
});
