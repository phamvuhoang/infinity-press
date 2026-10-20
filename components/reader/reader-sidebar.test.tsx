import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderSidebar } from "@/components/reader/reader-sidebar";
import type { ReaderAnnotation } from "@/lib/reader/annotations";
import type { ReaderTocEntry } from "@/lib/reader/types";

afterEach(cleanup);

const copy = {
  contents: "Contents", contentsEmpty: "No contents", bookmarks: "Bookmarks", notes: "Notes",
  highlights: "Highlights", locationUnavailable: "Location unavailable", retry: "Retry", delete: "Delete",
  editBookmark: "Edit bookmark", editNote: "Edit note", yellow: "Yellow", green: "Green", rose: "Rose",
  emptyBookmarks: "No bookmarks", emptyNotes: "No notes", annotationsFailed: "Saved items are unavailable",
  loadingSavedItems: "Loading saved items…",
};
const toc: ReaderTocEntry[] = [{ title: "Chapter one", href: "c1.xhtml", children: [] }];
const highlight: ReaderAnnotation = {
  id: "d0000000-0000-4000-8000-000000000001", publicationId: "c0000000-0000-4000-8000-000000000001",
  kind: "highlight", selectedText: "A highlight", color: "yellow", noteText: null,
  locator: { href: "c1.xhtml", progression: 0, totalProgression: 0, locations: {} }, createdAt: "now", updatedAt: "now",
};

function renderSidebar() {
  const onNavigate = vi.fn();
  render(<ReaderSidebar copy={copy} currentHref="c1.xhtml#one" entries={toc} items={[{ key: "highlight", annotation: highlight, status: "synced", unresolved: true }]} loadState="ready" onDelete={vi.fn()} onEditBookmark={vi.fn()} onEditNote={vi.fn()} onNavigate={onNavigate} onNavigateToc={vi.fn()} onRecolor={vi.fn()} onRetry={vi.fn()} onRetryLoad={vi.fn()} />);
  return { onNavigate };
}

describe("ReaderSidebar", () => {
  it("keeps bookmark and highlight counts distinct while exposing highlights without notes", async () => {
    const user = userEvent.setup();
    renderSidebar();
    expect(screen.getByRole("tab", { name: "Contents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Chapter one" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
    expect(screen.getAllByText("Bookmarks (0)")).toHaveLength(2);
    expect(screen.getByText("Highlights (1)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "A highlight" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Notes (1)" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Notes (0)" })).toBeInTheDocument();
  });

  it("uses arrow and Home/End keys to move tabs and reports unavailable saved locations", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderSidebar();
    const contents = screen.getByRole("tab", { name: "Contents" });
    contents.focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Notes (0)" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(contents).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Bookmarks (0)" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "A highlight" }));
    expect(onNavigate).toHaveBeenCalledWith(highlight.locator);
    expect(screen.getByText("Location unavailable")).toBeInTheDocument();
  });

  it("offers a scoped retry after annotation loading fails", async () => {
    const user = userEvent.setup();
    const onRetryLoad = vi.fn();
    render(<ReaderSidebar copy={copy} currentHref={null} entries={[]} items={[]} loadState="error" onDelete={vi.fn()} onEditBookmark={vi.fn()} onEditNote={vi.fn()} onNavigate={vi.fn()} onNavigateToc={vi.fn()} onRecolor={vi.fn()} onRetry={vi.fn()} onRetryLoad={onRetryLoad} />);
    await user.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
    expect(screen.getByText("Saved items are unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryLoad).toHaveBeenCalledOnce();
  });

  it("announces saved items as loading instead of announcing an empty collection", async () => {
    const user = userEvent.setup();
    render(<ReaderSidebar copy={copy} currentHref={null} entries={[]} items={[]} loadState="loading" onDelete={vi.fn()} onEditBookmark={vi.fn()} onEditNote={vi.fn()} onNavigate={vi.fn()} onNavigateToc={vi.fn()} onRecolor={vi.fn()} onRetry={vi.fn()} onRetryLoad={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: "Bookmarks (0)" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved items…");
    expect(screen.queryByText("No bookmarks")).toBeNull();
  });

  it("uses dark-relative interaction and focus colors", () => {
    render(<ReaderSidebar copy={copy} currentHref="c1.xhtml" dark entries={toc} items={[]} loadState="ready" onDelete={vi.fn()} onEditBookmark={vi.fn()} onEditNote={vi.fn()} onNavigate={vi.fn()} onNavigateToc={vi.fn()} onRecolor={vi.fn()} onRetry={vi.fn()} onRetryLoad={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Chapter one" })).toHaveClass(
      "hover:bg-ivory/10",
      "focus-visible:outline-ivory",
    );
    expect(screen.getByRole("tab", { name: "Contents" })).toHaveClass(
      "aria-selected:border-ivory",
      "focus-visible:outline-ivory",
    );
  });
});
