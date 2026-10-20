import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderCompletionPanel } from "@/components/reader/reader-completion-panel";

afterEach(cleanup);

const copy = { finishedTitle: "Finished", finishedBody: "In your library", goToLibrary: "Library", notes: "Notes", highlights: "Highlights", bookmarks: "Bookmarks", relatedBooks: "More books", noRelatedBooks: "No recommendations", rateBook: "Rate this book", askAuthor: "Ask the author" };
const links = { reviewHref: "/vi/library/reviews/b1", askHref: "/vi/ask?book=b1" };

describe("ReaderCompletionPanel", () => {
  it("opens saved-item destinations and offers the library", async () => {
    const user = userEvent.setup();
    const onOpenSaved = vi.fn();
    render(<ReaderCompletionPanel copy={copy} libraryHref="/en/library" {...links} onOpenSaved={onOpenSaved} relatedBooks={[]} />);
    expect(screen.getByRole("link", { name: "Library" })).toHaveAttribute("href", "/en/library");
    await user.click(screen.getByRole("button", { name: "Notes" }));
    await user.click(screen.getByRole("button", { name: "Highlights" }));
    await user.click(screen.getByRole("button", { name: "Bookmarks" }));
    expect(onOpenSaved).toHaveBeenNthCalledWith(1, "notes");
    expect(onOpenSaved).toHaveBeenNthCalledWith(2, "bookmarks");
    expect(onOpenSaved).toHaveBeenNthCalledWith(3, "bookmarks");
    expect(screen.getByText("No recommendations")).toBeInTheDocument();
  });

  it("links to the review form and ask-the-author", () => {
    render(<ReaderCompletionPanel copy={copy} libraryHref="/en/library" {...links} onOpenSaved={vi.fn()} relatedBooks={[]} />);
    expect(screen.getByRole("link", { name: "Rate this book" })).toHaveAttribute("href", "/vi/library/reviews/b1");
    expect(screen.getByRole("link", { name: "Ask the author" })).toHaveAttribute("href", "/vi/ask?book=b1");
  });

  it("leaves ask-the-author out when the author does not take questions", () => {
    render(<ReaderCompletionPanel copy={copy} libraryHref="/en/library" {...links} askHref={null} onOpenSaved={vi.fn()} relatedBooks={[]} />);
    expect(screen.getByRole("link", { name: "Rate this book" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Ask the author" })).toBeNull();
  });

  it("uses an ivory-tinted hover surface for saved actions in dark mode", () => {
    render(<ReaderCompletionPanel copy={copy} dark libraryHref="/en/library" {...links} onOpenSaved={vi.fn()} relatedBooks={[]} />);
    expect(screen.getByRole("button", { name: "Notes" })).toHaveClass("hover:bg-ivory/10");
  });

  it("uses the dark surface foreground for muted completion copy", () => {
    render(<ReaderCompletionPanel copy={copy} dark libraryHref="/en/library" {...links} onOpenSaved={vi.fn()} relatedBooks={[]} />);

    expect(screen.getByText("In your library")).toHaveClass("text-current", "opacity-80");
    expect(screen.getByText("No recommendations")).toHaveClass("text-current", "opacity-80");
  });
});
