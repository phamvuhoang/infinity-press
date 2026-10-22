import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderSelectionToolbar } from "@/components/reader/reader-selection-toolbar";

afterEach(cleanup);
const copy = { highlightYellow: "Yellow", highlightGreen: "Green", highlightRose: "Rose", addNote: "Add note", copy: "Copy", share: "Share", askInfinity: "Ask Infinity", comingSoon: "Coming soon", copied: "Copied", copyFailed: "Copy failed", shareCancelled: "Share cancelled", quoteTruncated: "Quote shortened", shareUnavailable: "Share unavailable", shareCreated: "Public quote page created", sharePublic: "Sharing creates a public page", dismiss: "Keep reading", cancel: "Cancel", shareQuestionLabel: "Your question", textKind: { verbatim: "Verbatim", translation: "Translation", paraphrase: "Paraphrase" } };
const selection = { locator: { href: "/chapter.xhtml", progression: 0, totalProgression: 0, locations: {} }, text: "Selected text", rect: { x: -20, y: 10, width: 50, height: 20 } };
// With a card to mint, Share first opens the question dialog; its own Share button sends.
async function shareThroughDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Share" }));
  await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Share" }));
}

describe("ReaderSelectionToolbar", () => {
  it("keeps overlong selections available for Copy and Share with recoverable annotation feedback", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn(); const onAddNote = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ReaderSelectionToolbar copy={{ ...copy, annotationTooLong: "Select at most 1,000 characters to highlight or add a note." }} selection={{ ...selection, text: "x".repeat(1001), annotationText: null }} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} onHighlight={onHighlight} onAddNote={onAddNote} />);
    await user.click(screen.getByRole("button", { name: "Yellow" }));
    expect(screen.getByRole("status")).toHaveTextContent("Select at most 1,000");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onHighlight).not.toHaveBeenCalled(); expect(onAddNote).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Quote shortened");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });
  it("settles a pending selection on pointerdown, so the action reads the widened text", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    function Harness() {
      const [current, setCurrent] = useState({ ...selection, text: "Selected" });
      return <ReaderSelectionToolbar copy={copy} selection={current} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} onBeforeAction={() => setCurrent({ ...selection, text: "Selected text, widened" })} />;
    }
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("“Selected text, widened”"));
  });
  it("uses the same actions for a clipped anchored toolbar and touch action sheet", async () => {
    const user = userEvent.setup();
    const onHighlight = vi.fn();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} onHighlight={onHighlight} />);
    const toolbar = screen.getByRole("toolbar", { name: "Selected text" });
    expect(toolbar).toHaveStyle({ left: "0px" });
    await user.click(screen.getByRole("button", { name: "Green" }));
    expect(onHighlight).toHaveBeenCalledWith("green");
    expect(screen.getByRole("button", { name: "Ask Infinity" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Ask Infinity" })).toHaveAttribute("aria-describedby", "reader-ask-soon");
  });

  it("copies attributed text when Web Share is unavailable and announces failures", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(writeText).toHaveBeenCalledWith("“Selected text”\n- Book, Author\nhttps://example.test/book");
    expect(screen.getByRole("status")).toHaveTextContent("Share unavailable");
  });

  it("uses roving focus across selection actions", async () => {
    const user = userEvent.setup();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} />);
    const yellow = screen.getByRole("button", { name: "Yellow" });
    yellow.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Green" })).toHaveFocus();
  });

  it("clamps both axes, wraps focus while skipping disabled controls, and uses a touch sheet", async () => {
    const user = userEvent.setup(); const onAddNote = vi.fn();
    render(<ReaderSelectionToolbar copy={copy} selection={{ ...selection, rect: { x: 99, y: 200, width: 5, height: 5 } }} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} onAddNote={onAddNote} />);
    expect(screen.getByRole("toolbar")).toHaveStyle({ left: "0px", top: "56px" });
    screen.getByRole("button", { name: "Yellow" }).focus(); await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Keep reading" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Add note" })); expect(onAddNote).toHaveBeenCalledOnce();
    cleanup();
    render(<ReaderSelectionToolbar touch copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} />);
    expect(screen.getByRole("toolbar")).toHaveClass("bottom-0");
  });

  it("uses measured multi-row dimensions to clamp the right and lower edges", () => {
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 120, width: 300, height: 120, toJSON: () => ({}) });
    render(<ReaderSelectionToolbar copy={copy} selection={{ ...selection, rect: { x: 490, y: 490, width: 5, height: 5 } }} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 500, height: 500 }} />);
    expect(screen.getByRole("toolbar")).toHaveStyle({ left: "200px", top: "380px" });
    bounds.mockRestore();
  });

  it("keeps touch-sheet actions active", async () => {
    const user = userEvent.setup(); const onHighlight = vi.fn(); const onAddNote = vi.fn();
    render(<ReaderSelectionToolbar touch copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} onHighlight={onHighlight} onAddNote={onAddNote} />);
    await user.click(screen.getByRole("button", { name: "Rose" })); await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onHighlight).toHaveBeenCalledWith("rose"); expect(onAddNote).toHaveBeenCalledOnce();
  });

  it("announces both quote truncation and copy fallback, plus cancellation and clipboard failure", async () => {
    const user = userEvent.setup(); const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("blocked"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockRejectedValue(new DOMException("", "AbortError")) });
    render(<ReaderSelectionToolbar copy={copy} selection={{ ...selection, text: "x".repeat(301) }} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} />);
    await user.click(screen.getByRole("button", { name: "Share" })); expect(screen.getByRole("status")).toHaveTextContent("Share cancelled");
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined }); await user.click(screen.getByRole("button", { name: "Share" }));
    expect(screen.getByRole("status")).toHaveTextContent("Quote shortened"); expect(screen.getByRole("status")).toHaveTextContent("Share unavailable");
    await user.click(screen.getByRole("button", { name: "Copy" })); expect(screen.getByRole("status")).toHaveTextContent("Copy failed");
  });

  it("shares the card URL in place of the book URL when createShareUrl resolves", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const createShareUrl = vi.fn().mockResolvedValue("https://example.test/vi/q/AbCdEfGh12");
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await shareThroughDialog(user);
    expect(createShareUrl).toHaveBeenCalledWith({ quote: "Selected text", textKind: "verbatim", locator: selection.locator });
    expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n- Book, Author\nhttps://example.test/vi/q/AbCdEfGh12" });
    expect(screen.getByRole("status")).toHaveTextContent("Public quote page created");
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
  });

  it("falls back to the book URL, silently, when createShareUrl fails or returns null", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={vi.fn().mockRejectedValue(new Error("offline"))} />);
    await shareThroughDialog(user);
    expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n- Book, Author\nhttps://example.test/book" });
    expect(screen.getByRole("status")).not.toHaveTextContent("failed");
    cleanup();
    share.mockClear();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={vi.fn().mockResolvedValue(null)} />);
    await shareThroughDialog(user);
    expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n- Book, Author\nhttps://example.test/book" });
    expect(screen.getByRole("status")).not.toHaveTextContent("Public quote page created");
  });

  it("never calls createShareUrl for Copy", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const createShareUrl = vi.fn();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(createShareUrl).not.toHaveBeenCalled();
  });

  it("copies the card-URL text when navigator.share rejects for a reason other than cancel", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockRejectedValue(new DOMException("x", "NotAllowedError")) });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={vi.fn().mockResolvedValue("https://example.test/vi/q/AbCdEfGh12")} />);
    await shareThroughDialog(user);
    expect(writeText).toHaveBeenCalledWith("“Selected text”\n- Book, Author\nhttps://example.test/vi/q/AbCdEfGh12");
    expect(screen.getByRole("status")).toHaveTextContent("Public quote page created Share unavailable");
    expect(screen.getByRole("status")).not.toHaveTextContent("Copy failed");
  });

  it("tells the reader the quote becomes public before the mint settles", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={() => new Promise<string | null>(() => {})} />);
    const share = screen.getByRole("button", { name: "Share" });
    expect(share).toHaveAccessibleDescription("Sharing creates a public page");
    await user.click(share);
    void user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Share" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sharing creates a public page"));
    // Visible, not screen-reader-only: sighted readers must be told too.
    expect(screen.getByRole("status")).not.toHaveClass("sr-only");
  });

  it("still shares the book URL when the mint rejects after a delay", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    const slowFailure = () => new Promise<string | null>((_resolve, reject) => setTimeout(() => reject(new DOMException("timeout", "TimeoutError")), 50));
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={slowFailure} />);
    await shareThroughDialog(user);
    await waitFor(() => expect(share).toHaveBeenCalledWith({ text: "“Selected text”\n- Book, Author\nhttps://example.test/book" }));
  });

  it("asks for an optional question and the text kind before minting the card", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    const createShareUrl = vi.fn().mockResolvedValue("https://example.test/vi/q/AbCdEfGh12");
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(createShareUrl).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: "Verbatim" })).toBeChecked();
    const question = within(dialog).getByRole("textbox", { name: "Your question" });
    expect(question).toHaveAttribute("maxLength", "280");
    await user.type(question, "  Why?  ");
    await user.click(within(dialog).getByRole("radio", { name: "Paraphrase" }));
    await user.click(within(dialog).getByRole("button", { name: "Share" }));
    expect(createShareUrl).toHaveBeenCalledWith({ quote: "Selected text", question: "Why?", textKind: "paraphrase", locator: selection.locator });
  });

  it("mints nothing when the question dialog is cancelled", async () => {
    const user = userEvent.setup();
    const createShareUrl = vi.fn();
    render(<ReaderSelectionToolbar copy={copy} selection={selection} book={{ title: "Book", author: "Author", canonicalBookUrl: "https://example.test/book" }} viewport={{ width: 100, height: 100 }} createShareUrl={createShareUrl} />);
    await user.click(screen.getByRole("button", { name: "Share" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(createShareUrl).not.toHaveBeenCalled();
  });
});
