import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "@/components/site-header";

// The account links are a client island that reads the browser session; SiteHeaderAccountNav has
// its own tests.
vi.mock("@/components/site-header-account-nav", () => ({ SiteHeaderAccountNav: () => null }));

afterEach(cleanup);

describe("SiteHeader", () => {
  it.each([
    ["en", { Books: "/en/books", Ideas: "/en/ideas", Articles: "/en/articles", Search: "/en/search" }],
    ["vi", { Sách: "/vi/books", "Ý tưởng": "/vi/ideas", "Bài viết": "/vi/articles", "Tìm kiếm": "/vi/search" }],
  ] as const)("links the %s sections, knowledge hub included", async (locale, links) => {
    render(await SiteHeader({ locale }));

    for (const [name, href] of Object.entries(links)) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
  });

  it.each([
    ["ideas", "Ideas"],
    ["articles", "Articles"],
    ["books", "Books"],
  ] as const)("marks %s as the current page and nothing else", async (current, name) => {
    render(await SiteHeader({ locale: "en", current }));

    expect(screen.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    for (const other of ["Books", "Ideas", "Articles", "Search"].filter((label) => label !== name)) {
      expect(screen.getByRole("link", { name: other })).not.toHaveAttribute("aria-current");
    }
  });

  it("switches to this page's alternate in the other locale when it exists", async () => {
    render(await SiteHeader({ locale: "en", alternates: { vi: "/vi/ideas/vi-sao-doc" } }));

    const switcher = screen.getByRole("link", { name: "Đọc bằng tiếng Việt" });
    expect(switcher).toHaveAttribute("href", "/vi/ideas/vi-sao-doc");
    expect(switcher).toHaveAttribute("hreflang", "vi");
  });

  it("switches to the other locale's home when this page has no alternate", async () => {
    render(await SiteHeader({ locale: "vi" }));

    const switcher = screen.getByRole("link", { name: "Read in English" });
    expect(switcher).toHaveAttribute("href", "/en");
    expect(switcher).toHaveAttribute("hreflang", "en");
  });
});
