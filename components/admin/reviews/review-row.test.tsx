import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { moderateReviewAction, replyReviewAction } from "@/app/admin/reviews/actions";
import type { AdminReviewDTO } from "@/lib/data/admin-reviews";
import { ReviewRow } from "./review-row";

vi.mock("@/app/admin/reviews/actions", () => ({
  moderateReviewAction: vi.fn(),
  replyReviewAction: vi.fn(),
}));

const review: AdminReviewDTO = {
  id: "r1",
  revision: 7,
  bookId: "b1",
  bookTitle: "The Quiet Library",
  languageCode: "ja",
  reviewerName: "An Nguyen",
  rating: 4,
  body: "Lovely <b>read</b>.",
  locale: "en",
  status: "pending",
  authorReply: null,
  createdAt: "2026-09-30T08:00:00.000Z",
  publishedAt: null,
  replyEmailedAt: null,
};

function renderRow(overrides: Partial<AdminReviewDTO> = {}) {
  return render(
    <table>
      <tbody>
        <ReviewRow review={{ ...review, ...overrides }} />
      </tbody>
    </table>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(moderateReviewAction).mockResolvedValue({ fieldErrors: {}, formError: null, savedAt: 1 });
  vi.mocked(replyReviewAction).mockResolvedValue({ fieldErrors: {}, formError: null, savedAt: 1 });
});
afterEach(cleanup);

it("is a table row named by the book title with a link, the stars and an escaped body", () => {
  renderRow();
  const row = screen.getByRole("row", { name: /The Quiet Library/ });
  expect(within(row).getByRole("link", { name: "The Quiet Library (ja)" })).toHaveAttribute("href", "/admin/books/b1");
  expect(within(row).getByText("An Nguyen")).toBeInTheDocument();
  expect(within(row).getByText("★★★★☆")).toBeInTheDocument();
  expect(within(row).getByText("Lovely <b>read</b>.")).toBeInTheDocument();
});

it.each([
  ["pending", ["Publish", "Reject"]],
  ["published", ["Reject"]],
  ["rejected", ["Publish"]],
] as const)("shows the right moderation buttons for a %s review", (status, expected) => {
  renderRow({ status });
  for (const name of ["Publish", "Reject"]) {
    const query = screen.queryByRole("button", { name });
    if ((expected as readonly string[]).includes(name)) expect(query).toBeInTheDocument();
    else expect(query).not.toBeInTheDocument();
  }
  expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument();
});

it("posts a moderation form bound to the review id and target status", async () => {
  renderRow();
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  await waitFor(() => expect(moderateReviewAction).toHaveBeenCalledTimes(1));
  expect(vi.mocked(moderateReviewAction).mock.calls[0].slice(0, 3)).toEqual(["r1", "published", 7]);
});

it("keeps the reply form closed until the Reply button opens it, then posts it", async () => {
  renderRow({ authorReply: "Thanks!" });
  expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reply" })).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  const textarea = screen.getByLabelText("Reply");
  expect(textarea).toHaveValue("Thanks!");
  fireEvent.change(textarea, { target: { value: "Thank you for reading." } });
  fireEvent.click(screen.getByRole("button", { name: "Save reply" }));

  await waitFor(() => expect(replyReviewAction).toHaveBeenCalledTimes(1));
  const [id, , formData] = vi.mocked(replyReviewAction).mock.calls[0];
  expect(id).toBe("r1");
  expect((formData as FormData).get("reply")).toBe("Thank you for reading.");
});

it("tells the admin the reviewer will be emailed, under the reply field", () => {
  renderRow();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(screen.getByText("The reviewer is emailed once the review is published and the reply is saved.")).toBeInTheDocument();
});

it("shows when the reply was emailed, and nothing when it was not", () => {
  const { unmount } = renderRow({ authorReply: "Thanks!", replyEmailedAt: "2026-10-09T09:30:00.000Z" });
  expect(screen.getByText(/^Emailed /)).toBeInTheDocument();
  unmount();
  renderRow({ authorReply: "Thanks!" });
  expect(screen.queryByText(/^Emailed /)).not.toBeInTheDocument();
});
