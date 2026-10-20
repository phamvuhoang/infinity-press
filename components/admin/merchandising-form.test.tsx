import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { FeaturedBookForm, ShelfForm } from "@/components/admin/merchandising-form";
import type { AdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

it("associates a rejected shelf with the error that explains how to correct it", async () => {
  const reject = async (): Promise<AdminFormState> => ({ fieldErrors: { bookIds: "Choose each book only once." }, formError: null, savedAt: null });
  render(<ShelfForm action={reject} books={[]} shelfBookIds={[]} />);
  fireEvent.submit(screen.getByRole("button", { name: "Save shelf" }).closest("form")!);
  await screen.findByText("Choose each book only once.");
  expect(screen.getByRole("list")).toHaveAccessibleDescription("Choose each book only once.");
});

const books = [
  { id: "3a1b2c3d-0000-4000-8000-000000000001", title: "A deliberately very long book title that must have room to wrap" },
  { id: "3a1b2c3d-0000-4000-8000-000000000002", title: "Second book" },
];

it("connects the featured selection to its server validation error", async () => {
  const reject = async (): Promise<AdminFormState> => ({ fieldErrors: { bookIds: "The featured slot holds one book." }, formError: null, savedAt: null });
  render(<FeaturedBookForm action={reject} books={books} featuredBookId={null} />);

  fireEvent.submit(screen.getByRole("button", { name: "Save featured book" }).closest("form")!);

  const field = screen.getByLabelText("Featured book");
  await waitFor(() => expect(field).toHaveAccessibleDescription("The featured slot holds one book."));
  expect(field).toHaveAttribute("aria-invalid", "true");
});

it("preserves a replacement featured selection for the retry after a failed save", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1
      ? { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }
      : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  render(<FeaturedBookForm action={save} books={books} featuredBookId={books[0].id} />);

  fireEvent.change(screen.getByLabelText("Featured book"), { target: { value: books[1].id } });
  fireEvent.submit(screen.getByRole("button", { name: "Save featured book" }).closest("form")!);
  await screen.findByRole("alert");
  fireEvent.submit(screen.getByRole("button", { name: "Save featured book" }).closest("form")!);

  await expect(screen.findByRole("status")).resolves.toHaveTextContent("Saved.");
  expect(submissions.map((data) => data.get("bookIds"))).toEqual([books[1].id, books[1].id]);
});

it("preserves clearing an existing featured selection for the retry after a failed save", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1
      ? { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }
      : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  render(<FeaturedBookForm action={save} books={books} featuredBookId={books[0].id} />);

  fireEvent.change(screen.getByLabelText("Featured book"), { target: { value: "" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save featured book" }).closest("form")!);
  await screen.findByRole("alert");
  fireEvent.submit(screen.getByRole("button", { name: "Save featured book" }).closest("form")!);

  await expect(screen.findByRole("status")).resolves.toHaveTextContent("Saved.");
  expect(submissions.map((data) => data.get("bookIds"))).toEqual(["", ""]);
});

it("preserves a reordered shelf after a failed save and submits the order on retry", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1
      ? { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }
      : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  render(<ShelfForm action={save} books={books} shelfBookIds={[books[0].id]} />);

  fireEvent.change(screen.getByLabelText("Add a book to the shelf"), { target: { value: books[1].id } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getAllByRole<HTMLButtonElement>("button", { name: "Move down" }).find((button) => !button.disabled)!);
  fireEvent.submit(screen.getByRole("button", { name: "Save shelf" }).closest("form")!);

  await screen.findByRole("alert");
  expect(Array.from(document.querySelectorAll<HTMLInputElement>('input[name="bookIds"]')).map((input) => input.value)).toEqual([books[1].id, books[0].id]);

  fireEvent.submit(screen.getByRole("button", { name: "Save shelf" }).closest("form")!);
  await expect(screen.findByRole("status")).resolves.toHaveTextContent("Saved.");
  expect(submissions[1].getAll("bookIds")).toEqual([books[1].id, books[0].id]);
});
