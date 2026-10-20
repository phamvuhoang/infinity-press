import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { KnowledgeRelationsForm } from "@/components/admin/knowledge/knowledge-relations-form";
import type { AdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

const books = [
  { id: "book-a", title: "Sách một", published: true },
  { id: "book-b", title: "Sách hai", published: false },
  { id: "book-c", title: "Sách ba", published: true },
];
const ideas = [
  { id: "idea-a", title: "Ý một" },
  { id: "idea-b", title: "Ý hai" },
];
const topics = [
  { id: "topic-a", name: "Thói quen" },
  { id: "topic-b", name: "Trí nhớ" },
];

function capture() {
  const submissions: FormData[] = [];
  const action = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return { fieldErrors: {}, formError: null, savedAt: submissions.length };
  };
  return { submissions, action };
}

const hidden = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLInputElement>(`input[type='hidden'][name='${name}']`)].map((input) => input.value);

it("keeps an idea's book and related-idea order and posts topics as a set", async () => {
  const { submissions, action } = capture();
  const { container } = render(
    <KnowledgeRelationsForm
      action={action}
      books={books}
      defaults={{ bookIds: ["book-a", "book-b"], ideaIds: ["idea-a"], topicIds: ["topic-b"] }}
      ideas={ideas}
      kind="idea"
      topics={topics}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Move Sách hai (not published) up" }));
  fireEvent.change(screen.getByLabelText("Add a book"), { target: { value: "book-c" } });
  fireEvent.click(screen.getByRole("button", { name: "Add book" }));
  fireEvent.change(screen.getByLabelText("Add an idea"), { target: { value: "idea-b" } });
  fireEvent.click(screen.getByRole("button", { name: "Add idea" }));
  fireEvent.click(screen.getByRole("button", { name: "Move Ý hai up" }));
  fireEvent.click(screen.getByLabelText("Thói quen"));

  expect(hidden(container, "bookIds")).toEqual(["book-b", "book-a", "book-c"]);
  expect(hidden(container, "relatedIdeaIds")).toEqual(["idea-b", "idea-a"]);
  expect(hidden(container, "ideaIds")).toEqual([]);

  fireEvent.submit(container.querySelector("form")!);
  await waitFor(() => expect(submissions).toHaveLength(1));
  expect(submissions[0].getAll("bookIds")).toEqual(["book-b", "book-a", "book-c"]);
  expect(submissions[0].getAll("relatedIdeaIds")).toEqual(["idea-b", "idea-a"]);
  expect([...submissions[0].getAll("topicIds")].sort()).toEqual(["topic-a", "topic-b"]);
  await screen.findByTestId("form-saved");
});

it("posts an article's ordered books and ideas under the article field names", () => {
  const { action } = capture();
  const { container } = render(
    <KnowledgeRelationsForm
      action={action}
      books={books}
      defaults={{ bookIds: ["book-c"], ideaIds: ["idea-a", "idea-b"], topicIds: [] }}
      ideas={ideas}
      kind="article"
      topics={topics}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Move Ý một down" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Sách ba" }));

  expect(hidden(container, "ideaIds")).toEqual(["idea-b", "idea-a"]);
  expect(hidden(container, "relatedIdeaIds")).toEqual([]);
  expect(hidden(container, "bookIds")).toEqual([]);
  expect(screen.getByText("No books yet.")).toBeInTheDocument();
});

it("offers only options that are not already chosen", () => {
  const { action } = capture();
  render(
    <KnowledgeRelationsForm
      action={action}
      books={books}
      defaults={{ bookIds: ["book-a"], ideaIds: [], topicIds: [] }}
      ideas={ideas}
      kind="idea"
      topics={topics}
    />,
  );

  const choices = Array.from(screen.getByLabelText<HTMLSelectElement>("Add a book").options).map((option) => option.text);
  expect(choices).toEqual(["Choose a book", "Sách hai (not published)", "Sách ba"]);
});

it("shows a relation error on its field and keeps the selection", async () => {
  const action = async (): Promise<AdminFormState> => ({
    fieldErrors: { relatedIdeaIds: "An idea cannot relate to itself." },
    formError: null,
    savedAt: null,
  });
  const { container } = render(
    <KnowledgeRelationsForm
      action={action}
      books={books}
      defaults={{ bookIds: ["book-a"], ideaIds: ["idea-a"], topicIds: [] }}
      ideas={ideas}
      kind="idea"
      topics={topics}
    />,
  );

  fireEvent.click(screen.getByLabelText("Trí nhớ"));
  fireEvent.submit(container.querySelector("form")!);

  expect(await screen.findByText("An idea cannot relate to itself.")).toHaveAttribute("role", "alert");
  expect(screen.getByLabelText("Trí nhớ")).toBeChecked();
  expect(hidden(container, "relatedIdeaIds")).toEqual(["idea-a"]);
});
