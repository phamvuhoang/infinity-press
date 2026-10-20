import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BookActionControl } from "@/components/catalog/book-action-control";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const EDITION_ID = "50000000-0000-4000-8000-000000000001";
const props = {
  readHref: `/en/read/editions/${EDITION_ID}`,
  bookPath: "/en/books/a-book",
  locale: "en" as const,
  copy: en.catalog.actions,
  getFreeAction: vi.fn(async () => undefined),
  buyAction: vi.fn(async () => undefined),
};

describe("BookActionControl", () => {
  it("links an entitled reader to the reader", () => {
    render(<BookActionControl {...props} action="read" signedIn />);
    expect(screen.getByRole("link", { name: "Read now" })).toHaveAttribute("href", `/en/read/editions/${EDITION_ID}`);
  });

  it("sends a signed-out reader to sign-in and back to the book", () => {
    render(<BookActionControl {...props} action="get_free" signedIn={false} />);
    expect(screen.getByRole("link", { name: "Get free" })).toHaveAttribute("href", "/en/sign-in?next=%2Fen%2Fbooks%2Fa-book");
  });

  it("gives a signed-in reader an enabled Get free or Buy submit button", () => {
    const { rerender } = render(<BookActionControl {...props} action="get_free" signedIn />);
    const getFree = screen.getByRole("button", { name: "Get free" });
    expect(getFree).toBeEnabled();
    expect(getFree).toHaveAttribute("type", "submit");
    expect(getFree.closest("form")).not.toBeNull();

    rerender(<BookActionControl {...props} action="buy" signedIn />);
    expect(screen.getByRole("button", { name: "Buy ebook" })).toBeEnabled();
  });

  it("shows coming soon and unavailable states without a link", () => {
    const { rerender } = render(<BookActionControl {...props} action="coming_soon" signedIn={false} />);
    expect(screen.getByRole("button", { name: "Coming soon" })).toBeDisabled();
    rerender(<BookActionControl {...props} action="unavailable" signedIn={false} />);
    expect(screen.getByText("Not available yet")).toBeVisible();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
