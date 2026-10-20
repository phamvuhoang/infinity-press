// @vitest-environment node
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { answerQuestionAction, answerWithIdeaAction, archiveQuestionAction } from "@/app/admin/questions/actions";
import { requireAdmin } from "@/lib/auth/admin";
import { initialAdminFormState } from "@/lib/catalog/form";
import { revalidateKnowledgeHub } from "@/lib/catalog/revalidate";
import { DuplicateKnowledgeSlugError } from "@/lib/data/admin-knowledge";
import { AnswerDeliveryInProgressError, answerQuestion, answerQuestionWithIdea, archiveQuestion, QuestionUnavailableError } from "@/lib/data/admin-questions";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/catalog/revalidate", () => ({ revalidateKnowledgeHub: vi.fn() }));
vi.mock("@/lib/data/admin-knowledge", () => ({
  DuplicateKnowledgeSlugError: class DuplicateKnowledgeSlugError extends Error {
    constructor() {
      super("That slug is already used for this locale.");
    }
  },
}));
vi.mock("@/lib/data/admin-questions", async (original) => ({
  ...await original<typeof import("@/lib/data/admin-questions")>(),
  archiveQuestion: vi.fn(), answerQuestion: vi.fn(), answerQuestionWithIdea: vi.fn(),
}));

const QID = "11111111-1111-4111-8111-111111111111";
const IID = "22222222-2222-4222-8222-222222222222";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
const ideaForm = (overrides: Record<string, string> = {}) =>
  form({ locale: "en", slug: "why-quiet", question: " Why quiet? ", shortAnswer: "Because.", ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archiveQuestionAction", () => {
  it("archives and revalidates the inbox", async () => {
    await archiveQuestionAction(QID, new FormData());
    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/questions" });
    expect(archiveQuestion).toHaveBeenCalledWith(QID);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/questions");
  });

  it("never reaches the DAL when the admin gate denies", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(archiveQuestionAction(QID, new FormData())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(archiveQuestion).not.toHaveBeenCalled();
  });

  it("rejects a bound id that is not a uuid before the DAL", async () => {
    await expect(archiveQuestionAction("nope", new FormData())).rejects.toThrow();
    expect(archiveQuestion).not.toHaveBeenCalled();
  });
});

describe("answerQuestionAction", () => {
  it("links the idea and revalidates", async () => {
    const state = await answerQuestionAction(QID, initialAdminFormState, form({ ideaId: IID }));
    expect(answerQuestion).toHaveBeenCalledWith(QID, IID);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/questions");
    expect(state.savedAt).toEqual(expect.any(Number));
  });

  it("gates on the admin before parsing", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(answerQuestionAction(QID, initialAdminFormState, form({ ideaId: IID }))).rejects.toThrow("NEXT_FORBIDDEN");
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("rejects a missing or non-uuid idea before the DAL", async () => {
    for (const ideaId of ["", "not-a-uuid"]) {
      const state = await answerQuestionAction(QID, initialAdminFormState, form({ ideaId }));
      expect(state.fieldErrors.ideaId).toBeDefined();
    }
    expect(answerQuestion).not.toHaveBeenCalled();
  });

  it("explains a delivery lease conflict without changing the question", async () => {
    vi.mocked(answerQuestion).mockRejectedValueOnce(new AnswerDeliveryInProgressError());
    const state = await answerQuestionAction(QID, initialAdminFormState, form({ ideaId: IID }));
    expect(state.formError).toContain("Try again after delivery finishes");
    expect(state.savedAt).toBeNull();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("reports a known failure and hides raw database text", async () => {
    vi.mocked(answerQuestion).mockRejectedValueOnce(new QuestionUnavailableError());
    expect((await answerQuestionAction(QID, initialAdminFormState, form({ ideaId: IID }))).formError).toBe(
      "This question can no longer be answered.",
    );
    vi.mocked(answerQuestion).mockRejectedValueOnce(new Error("pg: secret detail"));
    const state = await answerQuestionAction(QID, initialAdminFormState, form({ ideaId: IID }));
    expect(state.formError).toBe("Something went wrong saving. Try again.");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("answerWithIdeaAction", () => {
  it("creates the idea, revalidates, then redirects to its editor", async () => {
    vi.mocked(answerQuestionWithIdea).mockResolvedValueOnce({ ideaId: IID });
    await expect(answerWithIdeaAction(QID, initialAdminFormState, ideaForm())).rejects.toThrow(`NEXT_REDIRECT:/admin/ideas/${IID}`);
    expect(requireAdmin).toHaveBeenCalledWith({ next: "/admin/questions" });
    expect(answerQuestionWithIdea).toHaveBeenCalledWith(QID, {
      locale: "en",
      slug: "why-quiet",
      question: "Why quiet?",
      shortAnswer: "Because.",
    });
    expect(revalidateKnowledgeHub).toHaveBeenCalledWith("idea", IID);
    expect(revalidatePath).toHaveBeenCalledWith("/admin/questions");
    expect(redirect).toHaveBeenCalledWith(`/admin/ideas/${IID}`);
  });

  it("gates on the admin before parsing", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("NEXT_FORBIDDEN"));
    await expect(answerWithIdeaAction(QID, initialAdminFormState, ideaForm())).rejects.toThrow("NEXT_FORBIDDEN");
    expect(answerQuestionWithIdea).not.toHaveBeenCalled();
  });

  it("returns field errors for an invalid slug or locale without calling the DAL", async () => {
    const state = await answerWithIdeaAction(QID, initialAdminFormState, ideaForm({ slug: "Not Kebab", locale: "fr" }));
    expect(state.fieldErrors.slug).toBeDefined();
    expect(state.fieldErrors.locale).toBeDefined();
    expect(answerQuestionWithIdea).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("maps a slug clash to a slug field error and does not redirect", async () => {
    vi.mocked(answerQuestionWithIdea).mockRejectedValueOnce(new DuplicateKnowledgeSlugError());
    const state = await answerWithIdeaAction(QID, initialAdminFormState, ideaForm());
    expect(state.fieldErrors.slug).toBe("That slug is already used for this locale.");
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("returns the not-new message, and a generic one for anything else", async () => {
    vi.mocked(answerQuestionWithIdea).mockRejectedValueOnce(new QuestionUnavailableError());
    expect((await answerWithIdeaAction(QID, initialAdminFormState, ideaForm())).formError).toBe(
      "This question can no longer be answered.",
    );
    vi.mocked(answerQuestionWithIdea).mockRejectedValueOnce(new Error("pg: secret detail"));
    expect((await answerWithIdeaAction(QID, initialAdminFormState, ideaForm())).formError).toBe(
      "Something went wrong saving. Try again.",
    );
  });
});
