import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { RelatedBooksPicker, type RelatedBookOption } from "@/components/admin/book-editor/related-books-picker";
import type { AdminFormState } from "@/lib/catalog/form";

afterEach(cleanup);

const atlas: RelatedBookOption = { id: "b1000000-0000-4000-8000-000000000001", title: "Atlas of quiet", authorName: "Phuong Bui", status: "published" };
const bright: RelatedBookOption = { id: "b1000000-0000-4000-8000-000000000002", title: "Bright mornings", authorName: "Linh Tran", status: "published" };
const chasing: RelatedBookOption = { id: "b1000000-0000-4000-8000-000000000003", title: "Chasing rivers", authorName: "Minh Le", status: "draft" };
const books = [atlas, bright, chasing];

const noop = async (): Promise<AdminFormState> => ({ fieldErrors: {}, formError: null, savedAt: null });

// The hidden fields ARE the saved order: the action reads them in document order and the RPC
// renumbers that list 1..N, so every ordering assertion here reads them rather than the labels.
const pinned = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[name="relatedBookIds"]')).map((input) => input.value);

const row = (title: string) => screen.getByRole("listitem", { name: new RegExp(title) });

it("posts the saved pin order and says which pin is a draft", () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[bright.id, atlas.id]} />);

  expect(pinned()).toEqual([bright.id, atlas.id]);
  expect(screen.queryByRole("listitem", { name: /Chasing rivers/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("Pin another book"), { target: { value: chasing.id } });
  fireEvent.click(screen.getByRole("button", { name: "Add book" }));
  expect(row("Chasing rivers")).toHaveTextContent("draft");
});

it("appends an added book and drops a removed one", () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[bright.id, atlas.id]} />);

  fireEvent.change(screen.getByLabelText("Pin another book"), { target: { value: chasing.id } });
  fireEvent.click(screen.getByRole("button", { name: "Add book" }));
  expect(pinned()).toEqual([bright.id, atlas.id, chasing.id]);

  fireEvent.click(screen.getByRole("button", { name: "Remove Bright mornings from the pinned books" }));
  expect(pinned()).toEqual([atlas.id, chasing.id]);
  expect(screen.queryByRole("button", { name: "Remove Bright mornings from the pinned books" })).toBeNull();
});

// jsdom implements no DataTransfer, so a dragged row gets one explicitly. Firefox refuses to start
// a drag at all unless dragstart writes to it, which is the only reason the component touches it.
function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(), dropEffect: "move", effectAllowed: "move" };
}

it("hands Firefox a drag payload, without which no drag starts at all", () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);
  const transfer = dataTransfer();

  fireEvent.dragStart(row("Atlas of quiet"), { dataTransfer: transfer });

  expect(transfer.setData).toHaveBeenCalledWith("text/plain", atlas.id);
});

it("reaches the same order by dragging a pin and by moving it with the keyboard", () => {
  const { unmount } = render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);

  fireEvent.dragStart(row("Atlas of quiet"), { dataTransfer: dataTransfer() });
  fireEvent.dragOver(row("Chasing rivers"));
  fireEvent.drop(row("Chasing rivers"));
  const dragged = pinned();
  expect(dragged).toEqual([chasing.id, atlas.id]);
  unmount();

  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);
  fireEvent.click(screen.getByRole("button", { name: "Move Atlas of quiet down" }));
  expect(pinned()).toEqual(dragged);
});

it("disables the move buttons that would push a pin past either end", () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);

  expect(screen.getByRole("button", { name: "Move Atlas of quiet up" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Move Atlas of quiet down" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Move Chasing rivers up" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Move Chasing rivers down" })).toBeDisabled();
});

it("hands focus to the opposite button when a move disables the one just pressed", async () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);

  // Chasing rivers lands at the top, so "Move up" is about to be disabled and cannot hold focus.
  fireEvent.click(screen.getByRole("button", { name: "Move Chasing rivers up" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Chasing rivers down" })));

  // And back to the bottom, where "Move down" is the one that becomes disabled.
  fireEvent.click(screen.getByRole("button", { name: "Move Chasing rivers down" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Chasing rivers up" })));
});

it("announces the new position of a moved pin", async () => {
  render(<RelatedBooksPicker action={noop} books={books} pinnedBookIds={[atlas.id, bright.id, chasing.id]} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Chasing rivers up" }));

  const announcement = await screen.findByTestId("related-books-announcement");
  expect(announcement).toHaveTextContent("Moved Chasing rivers to position 2 of 3.");
  expect(announcement).toHaveAttribute("aria-live", "polite");
});

it("keeps a rejected order for the retry and confirms the save that succeeds", async () => {
  const submissions: FormData[] = [];
  const save = async (_state: AdminFormState, data: FormData): Promise<AdminFormState> => {
    submissions.push(data);
    return submissions.length === 1
      ? { fieldErrors: {}, formError: "Something went wrong saving. Try again.", savedAt: null }
      : { fieldErrors: {}, formError: null, savedAt: 1 };
  };
  render(<RelatedBooksPicker action={save} books={books} pinnedBookIds={[atlas.id, chasing.id]} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Chasing rivers up" }));
  const form = screen.getByRole("button", { name: "Save editorial pins" }).closest("form")!;
  fireEvent.submit(form);

  await screen.findByRole("alert");
  expect(pinned()).toEqual([chasing.id, atlas.id]);

  fireEvent.submit(form);
  await expect(screen.findByTestId("form-saved")).resolves.toHaveTextContent("Saved.");
  expect(submissions.map((data) => data.getAll("relatedBookIds"))).toEqual([
    [chasing.id, atlas.id],
    [chasing.id, atlas.id],
  ]);
});

it("shows a rejected list the error that explains how to correct it", async () => {
  const reject = async (): Promise<AdminFormState> => ({
    fieldErrors: { relatedBookIds: "Each related book can appear once." },
    formError: null,
    savedAt: null,
  });
  render(<RelatedBooksPicker action={reject} books={books} pinnedBookIds={[atlas.id]} />);

  fireEvent.submit(screen.getByRole("button", { name: "Save editorial pins" }).closest("form")!);

  await screen.findByText("Each related book can appear once.");
  expect(screen.getByRole("list")).toHaveAccessibleDescription("Each related book can appear once.");
});
