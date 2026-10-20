import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderSavedItems } from "@/components/reader/reader-saved-items";
import type { ReaderAnnotation } from "@/lib/reader/annotations";

afterEach(cleanup);
const item: ReaderAnnotation = { id: "d0000000-0000-4000-8000-000000000001", publicationId: "c0000000-0000-4000-8000-000000000001", kind: "bookmark", label: "Chapter one", locator: { href: "/chapter.xhtml", progression: 0, totalProgression: 0, locations: {} }, createdAt: "now", updatedAt: "now" };
const copy = { contents: "Contents", bookmarks: "Bookmarks", notes: "Notes", highlights: "Highlights", unavailable: "Unavailable", retry: "Retry", delete: "Delete", editBookmark: "Edit bookmark", editNote: "Edit note", yellow: "Yellow", green: "Green", rose: "Rose", emptyBookmarks: "No bookmarks", emptyNotes: "No notes" };
describe("ReaderSavedItems", () => {
  it("labels tabs with counts and navigates without reading the engine", async () => {
    const user = userEvent.setup(); const onNavigate = vi.fn();
    render(<ReaderSavedItems copy={copy} items={[{ key: "client", annotation: item, status: "synced", unresolved: true }]} onNavigate={onNavigate} onDelete={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Bookmarks (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chapter one" }));
    expect(onNavigate).toHaveBeenCalledWith(item.locator);
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("keeps highlights in Bookmarks, shows notes separately, and exposes annotation actions", async () => {
    const user = userEvent.setup(); const onEditBookmark = vi.fn(); const onEditNote = vi.fn(); const onRecolor = vi.fn(); const onRetry = vi.fn(); const onDelete = vi.fn();
    const highlight: ReaderAnnotation = { ...item, id: "d0000000-0000-4000-8000-000000000002", kind: "highlight", selectedText: "A highlight", color: "yellow", noteText: "A note" };
    render(<ReaderSavedItems copy={copy} items={[{ key: "bookmark", annotation: item, status: "synced", unresolved: false }, { key: "highlight", annotation: highlight, status: "unsynced", unresolved: false }]} onNavigate={vi.fn()} onDelete={onDelete} onRetry={onRetry} onEditBookmark={onEditBookmark} onEditNote={onEditNote} onRecolor={onRecolor} />);
    expect(screen.getByRole("tab", { name: "Bookmarks (2)" })).toBeInTheDocument();
    expect(screen.getByText("Highlights (1)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit bookmark" })); expect(onEditBookmark).toHaveBeenCalledWith("bookmark");
    await user.click(screen.getByRole("button", { name: "Green" })); expect(onRecolor).toHaveBeenCalledWith("highlight", "green");
    await user.click(screen.getByRole("button", { name: "Edit note" })); expect(onEditNote).toHaveBeenCalledWith("highlight");
    await user.click(screen.getByRole("button", { name: "Retry" })); await user.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(onRetry).toHaveBeenCalledWith("highlight"); expect(onDelete).toHaveBeenCalled();
    await user.click(screen.getByRole("tab", { name: "Notes (1)" })); expect(screen.getByText("A highlight")).toBeInTheDocument();
  });
});
