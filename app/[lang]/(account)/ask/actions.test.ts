import { revalidatePath } from "next/cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitReaderQuestionAction } from "@/app/[lang]/(account)/ask/actions";
import { requireUser } from "@/lib/auth/session";
import { initialAdminFormState } from "@/lib/catalog/form";
import { QuestionTargetNotFoundError, submitReaderQuestion, TooManyOpenQuestionsError } from "@/lib/data/questions";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn().mockResolvedValue({ id: "u1" }) }));
vi.mock("@/lib/data/questions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/data/questions")>()),
  submitReaderQuestion: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const ID = "30000000-0000-4000-8000-000000000001";

function formWith(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

beforeEach(() => vi.clearAllMocks());

describe("submitReaderQuestionAction", () => {
  it("submits a book question and revalidates the ask page", async () => {
    const state = await submitReaderQuestionAction("vi", initialAdminFormState, formWith({ body: "Vì sao?", bookId: ID }));
    expect(requireUser).toHaveBeenCalledWith("vi", `/vi/ask?book=${ID}`);
    expect(submitReaderQuestion).toHaveBeenCalledWith({ body: "Vì sao?", bookId: ID }, "vi");
    expect(revalidatePath).toHaveBeenCalledWith("/vi/ask");
    expect(state.savedAt).not.toBeNull();
  });

  it("submits an idea question", async () => {
    await submitReaderQuestionAction("en", initialAdminFormState, formWith({ body: "Why?", ideaId: ID }));
    expect(submitReaderQuestion).toHaveBeenCalledWith({ body: "Why?", ideaId: ID }, "en");
  });

  it("returns a field error without writing when there is no target", async () => {
    const state = await submitReaderQuestionAction("vi", initialAdminFormState, formWith({ body: "Vì sao?" }));
    expect(requireUser).toHaveBeenCalledWith("vi", "/vi/library");
    expect(submitReaderQuestion).not.toHaveBeenCalled();
    expect(Object.keys(state.fieldErrors)).toEqual(["target"]);
    expect(state.savedAt).toBeNull();
  });

  it("returns a body field error for an empty question", async () => {
    const state = await submitReaderQuestionAction("vi", initialAdminFormState, formWith({ body: "", bookId: ID }));
    expect(submitReaderQuestion).not.toHaveBeenCalled();
    expect(Object.keys(state.fieldErrors)).toEqual(["body"]);
  });

  it("maps EB035 to too_many, a missing target to target_missing, anything else to failed", async () => {
    const form = () => formWith({ body: "Vì sao?", bookId: ID });
    vi.mocked(submitReaderQuestion).mockRejectedValueOnce(new TooManyOpenQuestionsError());
    expect((await submitReaderQuestionAction("vi", initialAdminFormState, form())).formError).toBe("too_many");
    vi.mocked(submitReaderQuestion).mockRejectedValueOnce(new QuestionTargetNotFoundError());
    expect((await submitReaderQuestionAction("vi", initialAdminFormState, form())).formError).toBe("target_missing");
    vi.mocked(submitReaderQuestion).mockRejectedValueOnce(new Error("boom"));
    expect((await submitReaderQuestionAction("vi", initialAdminFormState, form())).formError).toBe("failed");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
