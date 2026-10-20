import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatDate } from "@/lib/i18n/format";
import { SharedQuoteList } from "./shared-quote-list";

afterEach(cleanup);
const copy = { empty: "None yet", copyLink: "Copy link", copied: "Copied", remove: "Remove", views: "{count} views" };
const item = { id: "q1", code: "AbCdEfGh12", quote: "Một câu.", locale: "vi" as const, bookId: "b1", bookTitle: "Sách", createdAt: "2026-10-09T00:00:00Z", viewCount: 3 };

describe("SharedQuoteList", () => {
  it("renders the empty state", () => {
    render(<SharedQuoteList copy={copy} items={[]} locale="vi" removeAction={vi.fn()} siteUrl="https://books.example" />);
    expect(screen.getByText("None yet")).toBeInTheDocument();
  });

  it("lists a quote with its book, views, the card link, and a remove form bound to the code", async () => {
    const removeAction = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<SharedQuoteList copy={copy} items={[item]} locale="vi" removeAction={removeAction} siteUrl="https://books.example" />);
    expect(screen.getByText("“Một câu.”")).toBeInTheDocument();
    expect(screen.getByText(/Sách/)).toBeInTheDocument();
    expect(screen.getByText(/3 views/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(formatDate(item.createdAt, "vi")))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /AbCdEfGh12/ })).toHaveAttribute("href", "/vi/q/AbCdEfGh12");
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith("https://books.example/vi/q/AbCdEfGh12");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await vi.waitFor(() => expect(removeAction).toHaveBeenCalled());
    expect(removeAction.mock.calls[0][0]).toBe("AbCdEfGh12");
  });
});
