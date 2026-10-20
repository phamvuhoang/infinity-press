import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderAnnotationEditor } from "@/components/reader/reader-annotation-editor";

afterEach(cleanup);
const copy = { addBookmark: "Add bookmark", editBookmark: "Edit bookmark", bookmarkLabel: "Chapter title", bookmarkFallback: "Bookmark", save: "Save", cancel: "Cancel", note: "Note", delete: "Delete" };
describe("ReaderAnnotationEditor", () => {
  it("uses the shared dialog, defaults a bookmark label from its chapter title, and returns focus", async () => {
    const user = userEvent.setup(); const onSave = vi.fn();
    render(<ReaderAnnotationEditor copy={copy} trigger={<button type="button">Bookmark</button>} mode="bookmark" chapterTitle="Chapter one" onSave={onSave} />);
    const trigger = screen.getByRole("button", { name: "Bookmark" }); await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "Chapter title" })).toHaveValue("Chapter one");
    await user.keyboard("{Escape}"); expect(trigger).toHaveFocus();
  });

  it("uses localized bookmark fallback and code-point limits", async () => {
    const user = userEvent.setup(); const onSave = vi.fn();
    render(<ReaderAnnotationEditor copy={copy} trigger={<button type="button">Bookmark</button>} mode="bookmark" onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Bookmark" }));
    expect(screen.getByRole("textbox", { name: "Chapter title" })).toHaveValue("Bookmark");
    await user.clear(screen.getByRole("textbox", { name: "Chapter title" }));
    await user.type(screen.getByRole("textbox", { name: "Chapter title" }), "😀".repeat(121));
    expect(screen.getByRole("textbox", { name: "Chapter title" })).toHaveValue("😀".repeat(120));
  });

  it("preserves a non-empty note verbatim, normalizes only empty notes, and calls delete", async () => {
    const user = userEvent.setup(); const onSave = vi.fn(); const onDelete = vi.fn();
    render(<ReaderAnnotationEditor copy={copy} trigger={<button type="button">Note</button>} mode="note" onSave={onSave} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Note" }));
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.type(note, "  keep spaces  "); await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("  keep spaces  ");
    await user.click(screen.getByRole("button", { name: "Note" })); await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("limits notes by 5000 Unicode code points and saves an empty note as null", async () => {
    const user = userEvent.setup(); const onSave = vi.fn();
    render(<ReaderAnnotationEditor copy={copy} trigger={<button type="button">Note</button>} mode="note" onSave={onSave} />);
    await user.click(screen.getByRole("button", { name: "Note" }));
    const note = screen.getByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "😀".repeat(5001) } });
    expect(note).toHaveValue("😀".repeat(5000));
    fireEvent.change(note, { target: { value: "" } }); await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });
});
