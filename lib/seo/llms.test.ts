import { describe, expect, it } from "vitest";

import { buildLlmsText, truncateDescription } from "@/lib/seo/llms";

describe("truncateDescription", () => {
  it("collapses newlines and cuts at a word boundary with an ellipsis", () => {
    const long = "Một câu rất dài\nvới xuống dòng ".repeat(20);
    const out = truncateDescription(long)!;
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });
  it("returns null for blank input", () => {
    expect(truncateDescription("  \n ")).toBeNull();
    expect(truncateDescription(null)).toBeNull();
  });
  it("leaves a short text whole, with all whitespace runs collapsed", () => {
    expect(truncateDescription("a \t\r\n\n b")).toBe("a b");
  });
  it("hard-cuts a long text with no space and still adds one ellipsis", () => {
    const out = truncateDescription("x".repeat(500))!;
    expect(out).toBe(`${"x".repeat(200)}…`);
  });
});

describe("buildLlmsText", () => {
  it("renders the locale sections, groups, and entry lines", () => {
    const text = buildLlmsText({
      siteUrl: "https://books.example",
      sections: [
        { locale: "vi", heading: "Infinity Books", intro: "Sách của Phương Bùi.", groups: [
          { heading: "Books", entries: [{ title: "Sách một", path: "/vi/books/sach-mot", description: "Mô tả\nhai dòng" }] },
          { heading: "Ideas", entries: [] },
        ] },
        { locale: "en", heading: "English", intro: "Books by Phuong Bui.", groups: [
          { heading: "Books", entries: [{ title: "Book one", path: "/en/books/book-one", description: null }] },
        ] },
      ],
    });
    expect(text).toBe([
      "# Infinity Books",
      "",
      "> Sách của Phương Bùi.",
      "",
      "## Books",
      "- [Sách một](https://books.example/vi/books/sach-mot): Mô tả hai dòng",
      "",
      "## English",
      "",
      "> Books by Phuong Bui.",
      "",
      "### Books",
      "- [Book one](https://books.example/en/books/book-one)",
      "",
    ].join("\n"));
  });

  it("emits exactly one line per entity even when title and description contain line breaks", () => {
    const text = buildLlmsText({
      siteUrl: "https://books.example",
      sections: [
        { locale: "vi", heading: "H", intro: "I", groups: [
          { heading: "Books", entries: [{ title: "Tựa\n[dài]\r\nhai dòng", path: "/vi/books/a", description: "Một\n\nHai\r\nBa" }] },
        ] },
      ],
    });
    const entryLines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(entryLines).toEqual(["- [Tựa dài hai dòng](https://books.example/vi/books/a): Một Hai Ba"]);
  });

  it("skips an entity whose title is empty after cleaning, and a group left empty by that", () => {
    const text = buildLlmsText({
      siteUrl: "https://books.example",
      sections: [
        { locale: "vi", heading: "H", intro: "I", groups: [
          { heading: "Books", entries: [{ title: " [] \n", path: "/vi/books/a", description: "x" }] },
        ] },
      ],
    });
    expect(text).not.toContain("- [](");
    expect(text).not.toContain("## Books");
  });
});
