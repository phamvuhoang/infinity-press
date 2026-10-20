import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BundleMembersForm } from "@/components/admin/bundle-editor/members-form";
import type { AdminFormState } from "@/lib/catalog/form";
import type { AdminBundleMemberDTO } from "@/lib/data/bundles";

afterEach(cleanup);

const members: AdminBundleMemberDTO[] = [
  { editionId: "book-a", bookId: "book-a", languageCode: "en", position: 1, title: "Cuốn một", canonicalKey: "first", published: true },
  { editionId: "book-b", bookId: "book-b", languageCode: "en", position: 2, title: "Cuốn hai", canonicalKey: "second", published: false },
  { editionId: "book-c", bookId: "book-c", languageCode: "en", position: 3, title: "Cuốn ba", canonicalKey: "third", published: true },
];

const books = members.map((member) => ({ id: member.editionId, title: member.title, published: member.published }));

const noop = async (): Promise<AdminFormState> => ({ fieldErrors: {}, formError: null, savedAt: null });

function postedOrder(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLInputElement>("input[type='hidden'][name='editionIds']")].map((input) => input.value);
}

it("moves a member and posts the whole reordered list", () => {
  const { container } = render(<BundleMembersForm action={noop} books={books} members={members} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Cuốn ba up" }));

  expect(postedOrder(container)).toEqual(["book-a", "book-c", "book-b"]);
});

// The button that performed the move becomes disabled at the boundary, so without explicit focus
// management the keyboard user is dropped onto <body> and ejected from the list after every move.
it("keeps focus inside the list after a move to the top", async () => {
  render(<BundleMembersForm action={noop} books={books} members={members} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Cuốn hai up" }));

  await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  // "Move up" is now disabled for this row, so focus lands on the row's other direction control.
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Cuốn hai down" }));
});

it("keeps focus on the same control for a move that is not to a boundary", async () => {
  render(<BundleMembersForm action={noop} books={books} members={members} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Cuốn một down" }));

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move Cuốn một down" })));
});

it("announces the new position", async () => {
  render(<BundleMembersForm action={noop} books={books} members={members} />);

  fireEvent.click(screen.getByRole("button", { name: "Move Cuốn ba up" }));

  const status = await screen.findByTestId("bundle-members-announcement");
  expect(status).toHaveTextContent("Moved Cuốn ba to position 2 of 3.");
  expect(status).toHaveAttribute("aria-live", "polite");
});

it("names the book each control acts on, so two rows are distinguishable", () => {
  render(<BundleMembersForm action={noop} books={books} members={members} />);

  expect(screen.getByRole("button", { name: "Remove Cuốn một from the bundle" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove Cuốn hai from the bundle" })).toBeInTheDocument();
});

it("announces a removal and drops the book from the posted list", async () => {
  const { container } = render(<BundleMembersForm action={noop} books={books} members={members} />);

  fireEvent.click(screen.getByRole("button", { name: "Remove Cuốn hai from the bundle" }));

  expect(postedOrder(container)).toEqual(["book-a", "book-c"]);
  await waitFor(() =>
    expect(screen.getByTestId("bundle-members-announcement")).toHaveTextContent("Removed Cuốn hai from the bundle."),
  );
});

it("associates the server's membership error with the list", async () => {
  const reject = async (): Promise<AdminFormState> => ({
    fieldErrors: { editionIds: "Each edition can appear once." },
    formError: null,
    savedAt: null,
  });
  render(<BundleMembersForm action={reject} books={books} members={members} />);

  fireEvent.submit(screen.getByRole("button", { name: "Save members" }).closest("form")!);

  await screen.findByText("Each edition can appear once.");
  expect(screen.getByRole("list")).toHaveAccessibleDescription("Each edition can appear once.");
});
