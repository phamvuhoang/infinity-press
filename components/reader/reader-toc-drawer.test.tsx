import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReaderTocDrawer } from "@/components/reader/reader-toc-drawer";
import type { ReaderTocEntry } from "@/lib/reader/types";

afterEach(cleanup);

const copy = {
  contents: "Contents",
  contentsTitle: "Contents",
  contentsEmpty: "This book has no table of contents.",
  close: "Close",
};

const entries: ReaderTocEntry[] = [
  {
    title: "Part One",
    href: "/api/reader/publications/p1/resources/c1.xhtml",
    children: [{ title: "A Beginning", href: "/api/reader/publications/p1/resources/c1.xhtml#a", children: [] }],
  },
  { title: "Part Two", href: "/api/reader/publications/p1/resources/c2.xhtml", children: [] },
];

describe("ReaderTocDrawer", () => {
  it("lists every entry, nested ones included", async () => {
    const user = userEvent.setup();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={entries} onNavigate={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("button", { name: "Part One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "A Beginning" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Part Two" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Part Two" })).toHaveClass("text-current");
  });

  it("marks the entry the reader is in", async () => {
    const user = userEvent.setup();
    render(
      <ReaderTocDrawer
        copy={copy}
        currentHref="/api/reader/publications/p1/resources/c2.xhtml#para-2"
        entries={entries}
        onNavigate={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByRole("button", { name: "Part Two" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Part One" })).not.toHaveAttribute("aria-current");
  });

  it("reports the chosen href and closes", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={entries} onNavigate={onNavigate} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));
    await user.click(screen.getByRole("button", { name: "Part Two" }));

    expect(onNavigate).toHaveBeenCalledWith("/api/reader/publications/p1/resources/c2.xhtml");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // A sample filtered down to a single resource can legitimately have no nav at all.
  it("says so when there is no table of contents", async () => {
    const user = userEvent.setup();
    render(<ReaderTocDrawer copy={copy} currentHref={null} entries={[]} onNavigate={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Contents" }));

    expect(screen.getByText("This book has no table of contents.")).toBeInTheDocument();
  });
});
