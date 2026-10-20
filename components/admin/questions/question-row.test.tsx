import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { answerQuestionAction, answerWithIdeaAction, archiveQuestionAction } from "@/app/admin/questions/actions";
import type { AdminQuestionDTO } from "@/lib/data/admin-questions";
import { QuestionRow } from "./question-row";

vi.mock("@/app/admin/questions/actions", () => ({
  archiveQuestionAction: vi.fn(),
  answerQuestionAction: vi.fn(),
  answerWithIdeaAction: vi.fn(),
}));

const question: AdminQuestionDTO = {
  id: "q1",
  body: "Why is it <i>so</i> quiet?",
  locale: "vi",
  status: "new",
  createdAt: "2026-09-30T08:00:00.000Z",
  askerName: "An Nguyen",
  bookId: "b1",
  bookTitle: "The Quiet Library",
  ideaId: null,
  ideaQuestion: null,
  answerIdeaId: null,
};
const ideas = [
  { id: "i1", label: "What is silence?" },
  { id: "i2", label: "slug-only (draft)" },
];

function renderRow(overrides: Partial<AdminQuestionDTO> = {}) {
  return render(
    <table>
      <tbody>
        <QuestionRow ideas={ideas} question={{ ...question, ...overrides }} />
      </tbody>
    </table>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(answerQuestionAction).mockResolvedValue({ fieldErrors: {}, formError: null, savedAt: 1 });
  vi.mocked(answerWithIdeaAction).mockResolvedValue({ fieldErrors: {}, formError: null, savedAt: 1 });
});
afterEach(cleanup);

it("is a row named by its target with asker, an escaped body and a link to the book", () => {
  renderRow();
  const row = screen.getByRole("row", { name: /The Quiet Library/ });
  expect(within(row).getByRole("link", { name: "The Quiet Library" })).toHaveAttribute("href", "/admin/books/b1");
  expect(within(row).getByText("An Nguyen")).toBeInTheDocument();
  expect(within(row).getByText("Why is it <i>so</i> quiet?")).toBeInTheDocument();
});

it("links an idea question to the asked idea", () => {
  renderRow({ bookId: null, bookTitle: null, ideaId: "i9", ideaQuestion: "What is silence?" });
  expect(screen.getByRole("link", { name: "What is silence?" })).toHaveAttribute("href", "/admin/ideas/i9");
});

it("handles a target whose book and idea were deleted", () => {
  renderRow({ bookId: null, bookTitle: null, askerName: null });
  expect(screen.getByRole("row", { name: /Deleted/ })).toBeInTheDocument();
  expect(screen.getByText("Reader")).toBeInTheDocument();
});

it("posts archive bound to the question id", async () => {
  renderRow();
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(archiveQuestionAction).toHaveBeenCalledTimes(1));
  expect(vi.mocked(archiveQuestionAction).mock.calls[0][0]).toBe("q1");
});

it("keeps the new-idea form closed, then opens it prefilled with the body and the question locale", async () => {
  renderRow();
  expect(screen.queryByLabelText("Slug")).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "Answer with a new idea" });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);

  const row = screen.getByRole("row", { name: /The Quiet Library/ });
  expect(within(row).getByLabelText("Locale")).toHaveValue("vi");
  expect(within(row).getByLabelText("Question")).toHaveValue("Why is it <i>so</i> quiet?");
  fireEvent.change(within(row).getByLabelText("Slug"), { target: { value: "why-quiet" } });
  fireEvent.change(within(row).getByLabelText("Short answer"), { target: { value: "Because." } });
  fireEvent.click(within(row).getByRole("button", { name: "Create idea" }));

  await waitFor(() => expect(answerWithIdeaAction).toHaveBeenCalledTimes(1));
  const [id, , data] = vi.mocked(answerWithIdeaAction).mock.calls[0];
  expect(id).toBe("q1");
  expect(Object.fromEntries(data as FormData)).toEqual({
    locale: "vi",
    slug: "why-quiet",
    question: "Why is it <i>so</i> quiet?",
    shortAnswer: "Because.",
  });
});

it("truncates a long body to the idea question limit", () => {
  renderRow({ body: "x".repeat(450) });
  fireEvent.click(screen.getByRole("button", { name: "Answer with a new idea" }));
  expect(screen.getByLabelText("Question")).toHaveValue("x".repeat(300));
});

it("links an existing idea through the Link to idea form", async () => {
  renderRow();
  const select = screen.getByLabelText("Idea");
  expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
    "Choose an idea",
    "What is silence?",
    "slug-only (draft)",
  ]);
  fireEvent.change(select, { target: { value: "i1" } });
  fireEvent.click(screen.getByRole("button", { name: "Link idea" }));
  await waitFor(() => expect(answerQuestionAction).toHaveBeenCalledTimes(1));
  const [id, , data] = vi.mocked(answerQuestionAction).mock.calls[0];
  expect(id).toBe("q1");
  expect((data as FormData).get("ideaId")).toBe("i1");
});

it("keeps labels unique across rows", () => {
  render(
    <table>
      <tbody>
        <QuestionRow ideas={ideas} question={question} />
        <QuestionRow ideas={ideas} question={{ ...question, id: "q2", bookTitle: "Other" }} />
      </tbody>
    </table>,
  );
  const row = screen.getByRole("row", { name: /Other/ });
  expect(within(row).getByLabelText("Idea")).toBeInTheDocument();
  expect(screen.getAllByLabelText("Idea")).toHaveLength(2);
});

it("shows only a link to the answering idea once answered", () => {
  renderRow({ status: "answered", answerIdeaId: "i1" });
  expect(screen.getByRole("link", { name: "View answer" })).toHaveAttribute("href", "/admin/ideas/i1");
  expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Answer with a new idea" })).not.toBeInTheDocument();
});

it("shows no controls for an archived question", () => {
  renderRow({ status: "archived" });
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
