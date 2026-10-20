// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getMyReaderQuestions,
  QuestionTargetNotFoundError,
  submitReaderQuestion,
  TooManyOpenQuestionsError,
} from "@/lib/data/questions";
import { createClient } from "@/lib/supabase/server";

vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ID = "30000000-0000-4000-8000-000000000001";

function rpcResult(data: unknown, error: { code?: string; message?: string } | null = null) {
  const rpc = vi.fn(async () => ({ data, error }));
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  return rpc;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("submitReaderQuestion", () => {
  it("passes NULL for the unused target and returns the new id", async () => {
    const rpc = rpcResult("q1");
    await expect(submitReaderQuestion({ body: "Why?", ideaId: ID }, "en")).resolves.toBe("q1");
    expect(rpc).toHaveBeenCalledWith("submit_reader_question", { p_book_id: null, p_idea_id: ID, p_body: "Why?", p_locale: "en" });
  });

  it("maps EB035 and P0002 to typed errors and anything else to a generic one", async () => {
    rpcResult(null, { code: "EB035" });
    await expect(submitReaderQuestion({ body: "x", bookId: ID }, "vi")).rejects.toBeInstanceOf(TooManyOpenQuestionsError);
    rpcResult(null, { code: "P0002" });
    await expect(submitReaderQuestion({ body: "x", bookId: ID }, "vi")).rejects.toBeInstanceOf(QuestionTargetNotFoundError);
    rpcResult(null, { code: "XX000", message: "secret detail" });
    await expect(submitReaderQuestion({ body: "x", bookId: ID }, "vi")).rejects.toThrow("submitReaderQuestion failed.");
  });
});

describe("getMyReaderQuestions", () => {
  it("parses the rpc payload", async () => {
    const row = {
      id: "q1",
      body: "Why?",
      locale: "vi",
      status: "answered",
      createdAt: "2026-10-01T00:00:00+00:00",
      target: { kind: "book", title: "Sách" },
      answer: { slug: "tra-loi" },
    };
    rpcResult([row]);
    await expect(getMyReaderQuestions()).resolves.toEqual([row]);
  });

  it("rejects a payload with an unknown status", async () => {
    rpcResult([{ id: "q1", body: "x", locale: "vi", status: "weird", createdAt: "x", target: { kind: "book", title: "" }, answer: null }]);
    await expect(getMyReaderQuestions()).rejects.toThrow();
  });
});
