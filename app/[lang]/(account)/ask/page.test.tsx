import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AskPage from "@/app/[lang]/(account)/ask/page";
import { requireUser } from "@/lib/auth/session";
import { getBookAcceptsQuestions, getBookCardById } from "@/lib/data/catalog";
import { getPublishedIdeaById } from "@/lib/data/knowledge";
import { getMyReaderQuestions } from "@/lib/data/questions";

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
vi.mock("@/lib/data/catalog", () => ({ getBookCardById: vi.fn(), getBookAcceptsQuestions: vi.fn(async () => true) }));
vi.mock("@/lib/data/knowledge", () => ({ getPublishedIdeaById: vi.fn() }));
vi.mock("@/lib/data/questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/questions")>()),
  getMyReaderQuestions: vi.fn(),
}));

const ID = "30000000-0000-4000-8000-000000000001";
const OTHER = "30000000-0000-4000-8000-000000000002";
const params = Promise.resolve({ lang: "vi" });
const page = (searchParams: { book?: string | string[]; idea?: string | string[] }) =>
  AskPage({ params, searchParams: Promise.resolve(searchParams) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getBookCardById).mockResolvedValue({ bookId: ID, slug: "sach", title: "Sách" } as Awaited<ReturnType<typeof getBookCardById>>);
  vi.mocked(getPublishedIdeaById).mockResolvedValue({ ideaId: ID, slug: "y", question: "Vì sao?" } as Awaited<ReturnType<typeof getPublishedIdeaById>>);
  vi.mocked(getMyReaderQuestions).mockResolvedValue([]);
});

afterEach(cleanup);

describe("AskPage", () => {
  it("asks about a book", async () => {
    render(await page({ book: ID }));
    expect(requireUser).toHaveBeenCalledWith("vi", `/vi/ask?book=${ID}`);
    expect(getBookCardById).toHaveBeenCalledWith("vi", ID);
    expect(screen.getByText("Về: Sách")).toBeInTheDocument();
    expect(screen.getByLabelText("Câu hỏi của bạn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gửi câu hỏi" })).toBeInTheDocument();
  });

  it("asks about an idea and lists the reader's questions with an answer link", async () => {
    vi.mocked(getMyReaderQuestions).mockResolvedValue([
      {
        id: "q1",
        body: "Vì sao?",
        locale: "vi",
        status: "answered",
        createdAt: "2026-10-01T00:00:00Z",
        target: { kind: "idea", title: "Vì sao?" },
        answer: { slug: "tra-loi" },
      },
    ]);
    render(await page({ idea: ID }));
    expect(getPublishedIdeaById).toHaveBeenCalledWith("vi", ID);
    expect(screen.getByText("Đã trả lời")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Đọc câu trả lời" })).toHaveAttribute("href", "/vi/ideas/tra-loi");
  });

  it("keeps the textarea the only element labelled \"Câu hỏi của bạn\" when questions are listed", async () => {
    vi.mocked(getMyReaderQuestions).mockResolvedValue([
      {
        id: "q1",
        body: "Vì sao?",
        locale: "vi",
        status: "new",
        createdAt: "2026-10-01T00:00:00Z",
        target: { kind: "book", title: "Sách" },
        answer: null,
      },
    ]);
    render(await page({ book: ID }));
    expect(screen.getByRole("heading", { name: "Câu hỏi của bạn" })).toBeInTheDocument();
    const labelled = screen.getAllByLabelText("Câu hỏi của bạn");
    expect(labelled).toHaveLength(1);
    expect(labelled[0].tagName).toBe("TEXTAREA");
  });

  it.each([
    ["neither", {}],
    ["both", { book: ID, idea: OTHER }],
    ["a malformed id", { book: "nope" }],
    ["a repeated param", { book: [ID, OTHER] }],
  ])("404s with %s", async (_label, searchParams) => {
    await expect(page(searchParams)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireUser).not.toHaveBeenCalled();
  });

  it("404s when the book or idea is not published in this locale", async () => {
    vi.mocked(getBookCardById).mockResolvedValue(null);
    await expect(page({ book: ID })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getPublishedIdeaById).mockResolvedValue(null);
    await expect(page({ idea: ID })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("404s a book whose author does not take questions", async () => {
    vi.mocked(getBookAcceptsQuestions).mockResolvedValueOnce(false);
    await expect(page({ book: ID })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("reads nothing when the session gate rejects", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(page({ book: ID })).rejects.toThrow("NEXT_REDIRECT");
    expect(getMyReaderQuestions).not.toHaveBeenCalled();
  });
});
