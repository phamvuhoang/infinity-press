import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleSelector } from "@/components/locale-selector";

describe("LocaleSelector", () => {
  afterEach(cleanup);

  it("links every other locale by its native name and marks the current one", () => {
    render(<LocaleSelector alternates={{ ja: "/ja/books/hon" }} label="Choose language" locale="en" />);
    const nav = screen.getByRole("navigation", { name: "Choose language" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByText("English")).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("href", "/ja/books/hon");
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("hrefLang", "ja");
  });

  it("falls back to the other locale's home when the page has no translation there", () => {
    render(<LocaleSelector label="Choose language" locale="en" />);
    expect(screen.getByRole("link", { name: "Tiếng Việt" })).toHaveAttribute("href", "/vi");
    expect(screen.getByRole("link", { name: "日本語" })).toHaveAttribute("href", "/ja");
    expect(screen.queryByRole("link", { name: "English" })).toBeNull();
  });
});
