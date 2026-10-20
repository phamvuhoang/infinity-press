import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { publishBookAction, unpublishBookAction, type PublishActionResult } from "@/app/admin/books/[bookId]/publish-actions";
import { PublishPanel } from "./publish-panel";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/admin/books/[bookId]/publish-actions", () => ({ publishBookAction: vi.fn(), unpublishBookAction: vi.fn() }));

const bookId = "3a1b2c3d-0000-4000-8000-000000000001";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

it("disables publishing an incomplete draft and links each missing item to its editor section", () => {
  render(<PublishPanel bookId={bookId} issues={["missing_localization", "missing_author", "missing_cover", "missing_publication"]} status="draft" />);
  expect(screen.getByRole("button", { name: "Publish book" })).toBeDisabled();
  for (const [name, href] of [
    ["Add a localization with a title, slug, and description.", "#localizations"],
    ["Set a primary author with localized copy.", "#details"],
    ["Upload a cover image.", "#cover"],
    ["Publish an EPUB for at least one edition.", "#editions"],
  ]) expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
  expect(screen.getAllByRole("listitem")).toHaveLength(4);
});

it.each(["draft", "archived"] as const)("confirms before publishing a ready %s book and announces success", async (status) => {
  vi.mocked(publishBookAction).mockResolvedValue({ ok: true, message: "Book published." });
  render(<PublishPanel bookId={bookId} issues={[]} status={status} />);
  expect(screen.getByText("Everything required for publishing is in place.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Publish book" }));
  expect(window.confirm).toHaveBeenCalledWith("Publish this book? It becomes visible on the storefront.");
  await waitFor(() => expect(screen.getByTestId("book-publish-message")).toHaveTextContent("Book published."));
  expect(screen.getByRole("status")).toHaveTextContent("Book published.");
  expect(publishBookAction).toHaveBeenCalledWith(bookId);
  expect(unpublishBookAction).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledOnce();
});

it("allows a published book to be unpublished even with missing readiness items", async () => {
  vi.mocked(unpublishBookAction).mockResolvedValue({ ok: true, message: "Book unpublished." });
  render(<PublishPanel bookId={bookId} issues={["missing_publication"]} status="published" />);
  fireEvent.click(screen.getByRole("button", { name: "Unpublish book" }));
  expect(window.confirm).toHaveBeenCalledWith("Unpublish this book? It disappears from the storefront and readers can no longer open it.");
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Book unpublished."));
  expect(unpublishBookAction).toHaveBeenCalledWith(bookId);
  expect(publishBookAction).not.toHaveBeenCalled();
});

it.each(["draft", "published"] as const)("does not mutate a %s book after canceling confirmation", (status) => {
  vi.mocked(window.confirm).mockReturnValue(false);
  render(<PublishPanel bookId={bookId} issues={[]} status={status} />);
  fireEvent.click(screen.getByRole("button"));
  expect(publishBookAction).not.toHaveBeenCalled();
  expect(unpublishBookAction).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
});

it("disables duplicate submissions while pending, then shows database readiness issues and allows retry", async () => {
  let resolve!: (result: PublishActionResult) => void;
  vi.mocked(publishBookAction).mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<PublishPanel bookId={bookId} issues={[]} status="draft" />);
  fireEvent.click(screen.getByRole("button", { name: "Publish book" }));
  await waitFor(() => expect(screen.getByRole("button")).toBeDisabled());
  await act(async () => resolve({ ok: false, error: "This book is not ready to publish.", issues: ["missing_cover"] }));
  expect(screen.getByRole("alert")).toHaveTextContent("This book is not ready to publish.");
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toHaveAttribute("href", "#cover");
  expect(refresh).not.toHaveBeenCalled();
  expect(screen.getByRole("button")).toBeEnabled();
  vi.mocked(publishBookAction).mockResolvedValue({ ok: true, message: "Book published." });
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Book published."));
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("keeps the current checklist on generic failure", async () => {
  vi.mocked(unpublishBookAction).mockResolvedValue({ ok: false, error: "Something went wrong. Try again.", issues: [] });
  render(<PublishPanel bookId={bookId} issues={["missing_cover"]} status="published" />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again."));
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toBeVisible();
  expect(refresh).not.toHaveBeenCalled();
});

it("replaces a failed publish checklist when refreshed editor data fixes the missing item", async () => {
  vi.mocked(publishBookAction).mockResolvedValue({ ok: false, error: "This book is not ready to publish.", issues: ["missing_cover"] });
  const { rerender } = render(<PublishPanel bookId={bookId} issues={[]} status="draft" />);
  fireEvent.click(screen.getByRole("button", { name: "Publish book" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("link", { name: "Upload a cover image." })).toBeVisible();
  rerender(<PublishPanel bookId={bookId} issues={[]} status="draft" />);
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Publish book" })).toBeEnabled();
});

it("recovers a rejected action with a safe error and enabled retry control", async () => {
  vi.mocked(publishBookAction).mockRejectedValue(new Error("private transport detail"));
  render(<PublishPanel bookId={bookId} issues={[]} status="draft" />);
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Try again."));
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());
  expect(screen.queryByText(/private transport/)).not.toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
});
