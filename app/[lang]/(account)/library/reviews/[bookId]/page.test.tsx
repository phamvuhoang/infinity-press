import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ReviewPage from "@/app/[lang]/(account)/library/reviews/[bookId]/page";
import { requireUser } from "@/lib/auth/session";
import { getActiveEntitlementBookIds, getBookCardById } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getMyBookReview } from "@/lib/data/reviews";

vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/components/site-footer", () => ({ SiteFooter: () => null }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/data/catalog", () => ({ getActiveEntitlementBookIds: vi.fn(), getBookCardById: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/data/reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/reviews")>()),
  getMyBookReview: vi.fn(),
}));

const bookId = "00000000-0000-4000-8000-0000000000b1";
const params = Promise.resolve({ lang: "vi", bookId });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getBookCardById).mockResolvedValue({ bookId, slug: "sach", title: "Sách" } as Awaited<ReturnType<typeof getBookCardById>>);
  vi.mocked(getCurrentProfile).mockResolvedValue({ id: "p1" } as Awaited<ReturnType<typeof getCurrentProfile>>);
  vi.mocked(getMyBookReview).mockResolvedValue(null);
});

afterEach(cleanup);

describe("ReviewPage", () => {
  it("shows the form to an owner", async () => {
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([bookId]));
    render(await ReviewPage({ params }));
    expect(getActiveEntitlementBookIds).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("button", { name: "Lưu đánh giá" })).toBeInTheDocument();
  });

  it("shows only the not-owned message to a non-owner", async () => {
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set());
    render(await ReviewPage({ params }));
    expect(screen.getByText(/Bạn cần sở hữu cuốn sách này để đánh giá/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Về trang sách" })).toHaveAttribute("href", "/vi/books/sach");
    expect(screen.queryByRole("button", { name: "Lưu đánh giá" })).not.toBeInTheDocument();
  });

  it("keeps a revoked owner's review readable and deletable without edit controls", async () => {
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set());
    vi.mocked(getMyBookReview).mockResolvedValue({
      id: "r1", rating: 4, body: "My earlier review", status: "published",
      authorReply: "Thank you", authorReplyAt: "2026-10-01T00:00:00Z",
      publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
    });
    render(await ReviewPage({ params }));
    expect(screen.getByText("My earlier review")).toBeInTheDocument();
    expect(screen.getByText("Thank you")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Xoá đánh giá" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Lưu đánh giá" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("returns not found for a non-uuid book id after the session gate, before any read", async () => {
    await expect(ReviewPage({ params: Promise.resolve({ lang: "vi", bookId: "not-a-uuid" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireUser).toHaveBeenCalled();
    expect(getBookCardById).not.toHaveBeenCalled();
    expect(getMyBookReview).not.toHaveBeenCalled();
  });

  it("reads nothing when the session gate rejects", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(ReviewPage({ params })).rejects.toThrow("NEXT_REDIRECT");
    expect(getMyBookReview).not.toHaveBeenCalled();
  });
});
