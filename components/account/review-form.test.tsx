import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewForm } from "@/components/account/review-form";
import { initialAdminFormState } from "@/lib/catalog/form";

const copy = {
  ratingLabel: "Rating",
  bodyLabel: "Review",
  counter: "{count}/1000",
  save: "Save review",
  delete: "Delete review",
  states: { pending: "Pending", published: "Published", rejected: "Not published" },
  authorReply: "Reply from the author",
  errors: { notEntitled: "Own it first.", failed: "Could not save.", rating: "Pick a rating.", body: "Write a review." },
  saved: "Saved.",
};
const review = {
  id: "r1",
  rating: 4,
  body: "Hay",
  status: "pending" as const,
  authorReply: "Cảm ơn",
  authorReplyAt: "2026-10-01T00:00:00Z",
  publishedAt: null,
  updatedAt: "2026-10-01T00:00:00Z",
};
const noop = vi.fn(async () => initialAdminFormState);

afterEach(cleanup);

describe("ReviewForm", () => {
  it("renders five rating radios with the current value, the body limit, and a live counter", async () => {
    render(<ReviewForm action={noop} copy={copy} deleteAction={vi.fn()} review={review} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(5);
    expect(radios.every((radio) => radio.getAttribute("name") === "rating")).toBe(true);
    expect(screen.getByRole("radio", { name: "4/5" })).toBeChecked();
    const body = screen.getByLabelText("Review");
    expect(body).toHaveAttribute("maxlength", "1000");
    expect(body).toHaveValue("Hay");
    expect(screen.getByText("3/1000")).toBeInTheDocument();
    await userEvent.type(body, "!");
    expect(screen.getByText("4/1000")).toBeInTheDocument();
  });

  it("shows the review status and the author reply", () => {
    render(<ReviewForm action={noop} copy={copy} deleteAction={vi.fn()} review={review} />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Reply from the author")).toBeInTheDocument();
    expect(screen.getByText("Cảm ơn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete review" })).toBeInTheDocument();
  });

  it("starts empty for a reviewer with no review and offers no delete", () => {
    render(<ReviewForm action={noop} copy={copy} deleteAction={vi.fn()} review={null} />);
    expect(screen.getAllByRole("radio").every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(screen.queryByRole("button", { name: "Delete review" })).not.toBeInTheDocument();
  });

  it("submits through the action and shows the mapped not-entitled copy", async () => {
    const action = vi.fn(async () => ({ fieldErrors: {}, formError: "not_entitled", savedAt: null }));
    render(<ReviewForm action={action} copy={copy} deleteAction={vi.fn()} review={null} />);
    await userEvent.click(screen.getByRole("radio", { name: "5/5" }));
    await userEvent.type(screen.getByLabelText("Review"), "Great");
    await userEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(action).toHaveBeenCalledTimes(1);
    const sent = (action.mock.calls[0] as unknown as [unknown, FormData])[1];
    expect(sent.get("rating")).toBe("5");
    expect(sent.get("body")).toBe("Great");
    expect(await screen.findByText("Own it first.")).toBeInTheDocument();
  });

  it("maps field error keys to customer copy, never the schema's English", async () => {
    const action = vi.fn(async () => ({ fieldErrors: { rating: "Expected number", body: "Enter your review." }, formError: null, savedAt: null }));
    render(<ReviewForm action={action} copy={copy} deleteAction={vi.fn()} review={null} />);
    await userEvent.click(screen.getByRole("button", { name: "Save review" }));
    expect(await screen.findByText("Pick a rating.")).toBeInTheDocument();
    expect(screen.getByText("Write a review.")).toBeInTheDocument();
    expect(screen.queryByText("Enter your review.")).not.toBeInTheDocument();
  });
});
