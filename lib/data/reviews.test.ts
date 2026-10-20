// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChooseEditionToReviewError,
  deleteBookReview,
  getBookReviews,
  getMyBookReview,
  NotEntitledToReviewError,
  submitBookReview,
} from "@/lib/data/reviews";
import { createPublicClient } from "@/lib/supabase/public";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/public", () => ({ createPublicClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const mine = {
  id: "80000000-0000-4000-8000-000000000001",
  rating: 4,
  body: "Hay",
  status: "pending",
  authorReply: null,
  authorReplyAt: null,
  publishedAt: null,
  updatedAt: "2026-10-01T00:00:00+00:00",
};
const pub = {
  id: mine.id,
  reviewerName: "An",
  rating: 5,
  body: "Hay",
  authorReply: null,
  authorReplyAt: null,
  publishedAt: "2026-10-01T00:00:00+00:00",
  languageCode: "ja",
};

function rpcResult(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  vi.mocked(createPublicClient).mockReturnValue({ rpc } as unknown as ReturnType<typeof createPublicClient>);
  return rpc;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("review DAL", () => {
  it("reads public reviews with the limit and shows none for an unparseable payload", async () => {
    const rpc = rpcResult([pub]);
    expect(await getBookReviews(BOOK_ID, 3)).toEqual([pub]);
    expect(rpc).toHaveBeenCalledWith("catalog_book_reviews", { p_book_id: BOOK_ID, p_limit: 3 });
    rpcResult([{ id: 1 }]);
    expect(await getBookReviews(BOOK_ID, 4)).toEqual([]);
  });

  it("returns null when the reader has no review and parses one when they do", async () => {
    rpcResult(null);
    expect(await getMyBookReview(BOOK_ID)).toBeNull();
    rpcResult(mine);
    expect(await getMyBookReview(BOOK_ID)).toEqual(mine);
  });

  it("maps EB034 to NotEntitledToReviewError and other errors to a generic failure", async () => {
    const input = { rating: 4, body: "Hay" };
    rpcResult(null, { code: "EB034", message: "no entitlement" });
    await expect(submitBookReview(BOOK_ID, input, "vi")).rejects.toBeInstanceOf(NotEntitledToReviewError);
    rpcResult(null, { code: "XX000", message: "boom" });
    await expect(submitBookReview(BOOK_ID, input, "vi")).rejects.toThrow("submitBookReview failed.");
  });

  it("passes the locale through on submit and returns the parsed review", async () => {
    const rpc = rpcResult(mine);
    expect(await submitBookReview(BOOK_ID, { rating: 4, body: "Hay" }, "en")).toEqual(mine);
    expect(rpc).toHaveBeenCalledWith("submit_book_review", {
      p_book_id: BOOK_ID,
      p_rating: 4,
      p_body: "Hay",
      p_locale: "en",
    });
  });

  it("treats deleting a missing review (P0002) as success but surfaces other errors", async () => {
    rpcResult(null, { code: "P0002" });
    await expect(deleteBookReview(BOOK_ID)).resolves.toBeUndefined();
    rpcResult(null, { code: "XX000" });
    await expect(deleteBookReview(BOOK_ID)).rejects.toThrow("deleteBookReview failed.");
  });

  it("sends the edition only when the reader named one", async () => {
    const rpc = rpcResult(mine);
    await getMyBookReview(BOOK_ID);
    expect(rpc).toHaveBeenLastCalledWith("get_my_book_review", { p_book_id: BOOK_ID });
    await getMyBookReview(BOOK_ID, "edition-1");
    expect(rpc).toHaveBeenLastCalledWith("get_my_book_review", { p_book_id: BOOK_ID, p_edition_id: "edition-1" });
    await deleteBookReview(BOOK_ID, "edition-1");
    expect(rpc).toHaveBeenLastCalledWith("delete_book_review", { p_book_id: BOOK_ID, p_edition_id: "edition-1" });
  });

  it("turns EB042 into ChooseEditionToReviewError", async () => {
    rpcResult(null, { code: "EB042", message: "x" });
    await expect(getMyBookReview(BOOK_ID)).rejects.toBeInstanceOf(ChooseEditionToReviewError);
    await expect(submitBookReview(BOOK_ID, { rating: 5, body: "Hay" }, "vi")).rejects.toBeInstanceOf(ChooseEditionToReviewError);
  });
});
