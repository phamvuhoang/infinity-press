import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { removeSharedQuoteAction } from "@/app/admin/quotes/actions";
import { QuoteList } from "./quote-list";

vi.mock("@/app/admin/quotes/actions", () => ({ removeSharedQuoteAction: vi.fn() }));
afterEach(cleanup);

const item = { id: "q1", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi" as const, bookId: "b1", createdAt: "2026-10-09T00:00:00.000Z", bookTitle: "Sách", ownerEmail: "o@example.test", viewCount: 2 };

it("renders a row per card with the book link, owner, views, the public link, and a Remove form", async () => {
  render(<QuoteList items={[item]} />);
  const row = screen.getByRole("row", { name: /Sách/ });
  expect(within(row).getByRole("link", { name: "Sách" })).toHaveAttribute("href", "/admin/books/b1");
  expect(within(row).getByText("o@example.test")).toBeInTheDocument();
  expect(within(row).getByRole("link", { name: "AbCdEfGh12" })).toHaveAttribute("href", "/vi/q/AbCdEfGh12");
  fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(removeSharedQuoteAction).toHaveBeenCalled());
  expect(vi.mocked(removeSharedQuoteAction).mock.calls[0][0]).toBe("AbCdEfGh12");
});

it("says so when there is nothing", () => {
  render(<QuoteList items={[]} />);
  expect(screen.getByText("No shared quotes.")).toBeInTheDocument();
});
