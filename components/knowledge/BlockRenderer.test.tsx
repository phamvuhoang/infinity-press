import { readFileSync } from "node:fs";
import path from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BlockRenderer } from "@/components/knowledge/BlockRenderer";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import en from "@/lib/i18n/dictionaries/en.json";
import vi_ from "@/lib/i18n/dictionaries/vi.json";
import type { KnowledgeBlock, KnowledgeIdeaReference } from "@/lib/knowledge/blocks";

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const MISSING_BOOK_ID = "30000000-0000-4000-8000-000000000009";
const IDEA_ID = "a0000000-0000-4000-8000-000000000001";
const MISSING_IDEA_ID = "a0000000-0000-4000-8000-000000000009";
const IMAGE_KEY = "knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp";

const book: CatalogBookCard = {
  bookId: BOOK_ID,
  slug: "harbour-lights",
  title: "Harbour Lights",
  subtitle: null,
  shortDescription: null,
  author: { name: "Mai Tran", slug: "mai-tran" },
  cover: null,
  offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasActivePublication: true,
  hasSample: false,
  series: null,
  topics: [],
  featured: false,
  shelfPosition: null,
  createdAt: "2026-09-01T00:00:00+00:00",
};

const idea: KnowledgeIdeaReference = {
  ideaId: IDEA_ID,
  slug: "living-awake",
  question: "What does it mean to live awake?",
  shortAnswer: "To notice what is in front of you.",
};

const booksById = new Map([[BOOK_ID, book]]);
const ideasById = new Map([[IDEA_ID, idea]]);

function renderBlocks(blocks: KnowledgeBlock[], locale: "vi" | "en" = "en") {
  return render(
    <BlockRenderer
      blocks={blocks}
      bookCopy={locale === "en" ? en.catalog.book : vi_.catalog.book}
      booksById={booksById}
      ideasById={ideasById}
      locale={locale}
    />,
  );
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("BlockRenderer", () => {
  it("renders a paragraph with nested emphasis, strong, and links", () => {
    const { container } = renderBlocks([
      {
        type: "paragraph",
        content: [
          { text: "Plain " },
          { text: "soft", marks: ["emphasis"] },
          { text: " loud", marks: ["strong"] },
          { text: " both", marks: ["strong", "emphasis"] },
          { text: "a book", marks: ["emphasis", "strong"], link: { kind: "internal", entity: "book", slug: "harbour-lights" } },
          { text: "elsewhere", link: { kind: "external", href: "https://example.com/read?x=1" } },
        ],
      },
    ]);

    const paragraph = container.querySelector("p")!;
    expect(paragraph).toHaveTextContent("Plain soft loud botha bookelsewhere");
    expect(within(paragraph).getByText("soft").tagName).toBe("EM");
    expect(within(paragraph).getByText("loud").tagName).toBe("STRONG");
    // Text is wrapped in <em>, then <strong>, then the link.
    const both = within(paragraph).getByText("both");
    expect(both.tagName).toBe("EM");
    expect(both.parentElement!.tagName).toBe("STRONG");

    const bookLink = screen.getByRole("link", { name: "a book" });
    expect(bookLink).toHaveAttribute("href", "/en/books/harbour-lights");
    expect(bookLink.querySelector("strong > em")).toHaveTextContent("a book");

    const external = screen.getByRole("link", { name: "elsewhere" });
    expect(external).toHaveAttribute("href", "https://example.com/read?x=1");
    expect(external).toHaveAttribute("rel", "noopener noreferrer");
  });

  it.each([
    ["book", "/vi/books/sach"],
    ["idea", "/vi/ideas/sach"],
    ["article", "/vi/articles/sach"],
    ["author", "/vi/authors/sach"],
    ["series", "/vi/series/sach"],
    ["topic", "/vi/topics/sach"],
  ] as const)("routes an internal %s link under the locale", (entity, href) => {
    renderBlocks([{ type: "paragraph", content: [{ text: "liên kết", link: { kind: "internal", entity, slug: "sach" } }] }], "vi");
    expect(screen.getByRole("link", { name: "liên kết" })).toHaveAttribute("href", href);
  });

  it("escapes angle characters as text", () => {
    const { container } = renderBlocks([{ type: "paragraph", content: [{ text: "1 < 2 & 3 > 2" }] }]);
    expect(container.querySelector("p")!.textContent).toBe("1 < 2 & 3 > 2");
    expect(container.innerHTML).toContain("1 &lt; 2 &amp; 3 &gt; 2");
  });

  it("renders level 2 and level 3 headings", () => {
    renderBlocks([
      { type: "heading", level: 2, text: "Second" },
      { type: "heading", level: 3, text: "Third" },
    ]);
    expect(screen.getByRole("heading", { level: 2, name: "Second" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Third" })).toBeVisible();
  });

  it("renders ordered and unordered lists", () => {
    const { container } = renderBlocks([
      { type: "list", ordered: true, items: [[{ text: "One" }], [{ text: "Two", marks: ["strong"] }]] },
      { type: "list", ordered: false, items: [[{ text: "Dot" }]] },
    ]);
    const ordered = container.querySelector("ol")!;
    expect(within(ordered).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["One", "Two"]);
    expect(within(ordered).getByText("Two").tagName).toBe("STRONG");
    expect(within(container.querySelector("ul")!).getByRole("listitem")).toHaveTextContent("Dot");
  });

  it("renders a freely attributed quote", () => {
    const { container } = renderBlocks([{ type: "quote", text: "Attention is generosity.", attribution: "Simone Weil" }]);
    expect(container.querySelector("blockquote")).toHaveTextContent("Attention is generosity.");
    expect(container.querySelector("figcaption")).toHaveTextContent("Simone Weil");
  });

  it("attributes a book-backed quote to the localized book, author, and canonical link", () => {
    const { container } = renderBlocks([{ type: "quote", text: "The lights were on.", bookId: BOOK_ID }], "vi");
    expect(container.querySelector("blockquote")).toHaveTextContent("The lights were on.");
    const caption = container.querySelector("figcaption")!;
    expect(within(caption).getByRole("link", { name: "Harbour Lights" })).toHaveAttribute("href", "/vi/books/harbour-lights");
    expect(caption).toHaveTextContent("Mai Tran");
  });

  it("renders a book quote with title, author, canonical link, and locator", () => {
    const { container } = renderBlocks([
      { type: "book_quote", bookId: BOOK_ID, text: "The harbour was quiet.", locatorLabel: "Chapter 3" },
    ]);
    expect(container.querySelector("blockquote")).toHaveTextContent("The harbour was quiet.");
    const caption = container.querySelector("figcaption")!;
    expect(within(caption).getByRole("link", { name: "Harbour Lights" })).toHaveAttribute("href", "/en/books/harbour-lights");
    expect(caption).toHaveTextContent("Mai Tran");
    expect(caption).toHaveTextContent("Chapter 3");
  });

  it("renders an image with its stored alt text and dimensions from the covers bucket", () => {
    renderBlocks([{ type: "image", storageKey: IMAGE_KEY, alt: "A lighthouse", width: 1200, height: 800 }]);
    const image = screen.getByRole("img", { name: "A lighthouse" });
    expect(image).toHaveAttribute("width", "1200");
    expect(image).toHaveAttribute("height", "800");
    expect(image.getAttribute("src")).toBe(`http://127.0.0.1:54321/storage/v1/object/public/covers/${IMAGE_KEY}`);
  });

  it("renders a book card through the shared BookCard", () => {
    renderBlocks([{ type: "book_card", bookId: BOOK_ID }]);
    expect(screen.getByRole("link", { name: "Harbour Lights" })).toHaveAttribute("href", "/en/books/harbour-lights");
    expect(screen.getByText("Mai Tran", { selector: "p" })).toBeVisible();
    expect(screen.getByText("Free")).toBeVisible();
  });

  it("renders a linked idea card", () => {
    renderBlocks([{ type: "idea_card", ideaId: IDEA_ID }], "vi");
    expect(screen.getByRole("link", { name: idea.question })).toHaveAttribute("href", "/vi/ideas/living-awake");
    expect(screen.getByText(idea.shortAnswer)).toBeVisible();
  });

  it("omits blocks whose references are not published in this locale", () => {
    const { container } = renderBlocks([
      { type: "book_card", bookId: MISSING_BOOK_ID },
      { type: "idea_card", ideaId: MISSING_IDEA_ID },
      { type: "quote", text: "Unattributable.", bookId: MISSING_BOOK_ID },
      { type: "book_quote", bookId: MISSING_BOOK_ID, text: "Also unattributable.", locatorLabel: "p. 4" },
      { type: "heading", level: 2, text: "Still here" },
    ]);
    expect(container).not.toHaveTextContent("Unattributable.");
    expect(container).not.toHaveTextContent("Also unattributable.");
    expect(container.querySelector("blockquote, figure, article, a")).toBeNull();
    expect(screen.getByRole("heading", { name: "Still here" })).toBeVisible();
  });

  it("renders every block type in order and never serializes blocks into the DOM", () => {
    const { container } = renderBlocks([
      { type: "heading", level: 2, text: "Heading" },
      { type: "paragraph", content: [{ text: "Paragraph" }] },
      { type: "list", ordered: false, items: [[{ text: "Item" }]] },
      { type: "quote", text: "Quote", attribution: "Someone" },
      { type: "book_quote", bookId: BOOK_ID, text: "Book quote" },
      { type: "image", storageKey: IMAGE_KEY, alt: "Image", width: 10, height: 10 },
      { type: "book_card", bookId: BOOK_ID },
      { type: "idea_card", ideaId: IDEA_ID },
    ]);
    expect(container.firstElementChild!.children).toHaveLength(8);
    expect(container.innerHTML).not.toContain("storageKey");
    expect(container.innerHTML).not.toContain("&quot;type&quot;");
  });

  it("throws on a block type outside the contract instead of rendering it", () => {
    const bogus = { type: "html", html: "<script>alert(1)</script>" } as unknown as KnowledgeBlock;
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderBlocks([bogus])).toThrow(/Unsupported knowledge block/);
  });

  it("has no raw-HTML path in its source", () => {
    const source = readFileSync(path.join(__dirname, "BlockRenderer.tsx"), "utf8");
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("innerHTML");
    expect(source).not.toMatch(/case\s+["']html["']/);
    expect(source).not.toMatch(/^["']use client["']/m);
  });
});
