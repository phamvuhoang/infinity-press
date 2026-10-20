import { describe, expect, it } from "vitest";

import { type KnowledgeBlock, knowledgeBlockSchema, knowledgeBlocksSchema } from "@/lib/knowledge/blocks";

const bookId = "30000000-0000-4000-8000-000000000001";
const ideaId = "a0000000-0000-4000-8000-000000000001";
const imageKey = "knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp";

const validBlocks: Record<KnowledgeBlock["type"], KnowledgeBlock> = {
  paragraph: {
    type: "paragraph",
    content: [
      { text: "Read " },
      { text: "slowly", marks: ["emphasis", "strong"] },
      { text: " with ", link: { kind: "internal", entity: "book", slug: "harbour-lights" } },
      { text: "a guide", marks: ["strong"], link: { kind: "external", href: "https://example.com/guide?x=1" } },
    ],
  },
  heading: { type: "heading", level: 2, text: "Why attention matters" },
  list: {
    type: "list",
    ordered: true,
    items: [[{ text: "First" }], [{ text: "Second", link: { kind: "internal", entity: "topic", slug: "habits" } }]],
  },
  quote: { type: "quote", text: "Attention is the rarest form of generosity.", attribution: "Simone Weil" },
  book_quote: { type: "book_quote", bookId, text: "The harbour lights were on.", locatorLabel: "Chapter 3" },
  image: { type: "image", storageKey: imageKey, alt: "A lighthouse at dusk", width: 1200, height: 800 },
  book_card: { type: "book_card", bookId },
  idea_card: { type: "idea_card", ideaId },
};

function rejects(block: unknown) {
  return knowledgeBlockSchema.safeParse(block).success === false;
}

describe("knowledge block schema", () => {
  it.each(Object.entries(validBlocks))("accepts a valid %s block unchanged", (_type, block) => {
    expect(knowledgeBlockSchema.parse(block)).toEqual(block);
  });

  it("accepts every internal link entity kind", () => {
    for (const entity of ["book", "idea", "article", "author", "series", "topic"] as const) {
      expect(rejects({ type: "paragraph", content: [{ text: "x", link: { kind: "internal", entity, slug: "a-b-1" } }] })).toBe(
        false,
      );
    }
  });

  it("accepts a book-backed quote and a quote in an articles image path", () => {
    expect(rejects({ type: "quote", text: "Quoted.", bookId })).toBe(false);
    expect(
      rejects({ ...validBlocks.image, storageKey: imageKey.replace("knowledge/ideas/", "knowledge/articles/") }),
    ).toBe(false);
    expect(rejects({ ...validBlocks.image, storageKey: imageKey.replace(".webp", ".jpg") })).toBe(false);
    expect(rejects({ ...validBlocks.image, storageKey: imageKey.replace(".webp", ".png") })).toBe(false);
  });

  it("rejects unknown block types and unknown fields", () => {
    expect(rejects({ type: "html", html: "<p>hi</p>" })).toBe(true);
    expect(rejects({ type: "embed", url: "https://example.com" })).toBe(true);
    expect(rejects({ ...validBlocks.heading, html: "<b>x</b>" })).toBe(true);
    expect(rejects({ type: "heading", level: 1, text: "Top" })).toBe(true);
    expect(rejects({ type: "heading", level: 4, text: "Deep" })).toBe(true);
  });

  it("rejects duplicate and unknown marks", () => {
    expect(rejects({ type: "paragraph", content: [{ text: "x", marks: ["strong", "strong"] }] })).toBe(true);
    expect(rejects({ type: "paragraph", content: [{ text: "x", marks: ["underline"] }] })).toBe(true);
  });

  it.each([
    "/relative/path",
    "example.com",
    "//example.com/protocol-relative",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
    "mailto:someone@example.com",
    "ftp://example.com/file",
    "",
  ])("rejects the external href %j", (href) => {
    expect(rejects({ type: "paragraph", content: [{ text: "x", link: { kind: "external", href } }] })).toBe(true);
  });

  it.each(["", "Upper-Case", "trailing-", "-leading", "double--hyphen", "has space", "a/b", "../x", "slug?x=1"])(
    "rejects the internal slug %j",
    (slug) => {
      expect(rejects({ type: "paragraph", content: [{ text: "x", link: { kind: "internal", entity: "idea", slug } }] })).toBe(
        true,
      );
    },
  );

  it("rejects an unknown internal entity kind", () => {
    expect(rejects({ type: "paragraph", content: [{ text: "x", link: { kind: "internal", entity: "bundle", slug: "a" } }] })).toBe(
      true,
    );
  });

  const tag = "<script>alert(1)</script>";
  it.each([
    ["paragraph run", { type: "paragraph", content: [{ text: `a ${tag}` }] }],
    ["list item run", { type: "list", ordered: false, items: [[{ text: "<b>bold</b>" }]] }],
    ["heading", { type: "heading", level: 3, text: "<em>Heading</em>" }],
    ["quote text", { type: "quote", text: "<p>hi</p>", attribution: "Someone" }],
    ["quote attribution", { type: "quote", text: "hi", attribution: "<a href=x>Someone</a>" }],
    ["book quote text", { type: "book_quote", bookId, text: "<img src=x onerror=alert(1)>" }],
    ["book quote locator", { type: "book_quote", bookId, text: "Quote", locatorLabel: "</div>" }],
    ["image alt", { ...validBlocks.image, alt: "<svg onload=alert(1)>" }],
  ])("rejects raw HTML tags in the %s", (_field, block) => {
    expect(rejects(block)).toBe(true);
  });

  it("keeps ordinary angle characters that are not tags", () => {
    expect(rejects({ type: "paragraph", content: [{ text: "1 < 2 and 3 > 2, a <3 b" }] })).toBe(false);
    expect(knowledgeBlockSchema.parse({ type: "heading", level: 2, text: "x < y" })).toEqual({
      type: "heading",
      level: 2,
      text: "x < y",
    });
  });

  it("rejects blank and over-long text", () => {
    expect(rejects({ type: "paragraph", content: [] })).toBe(true);
    expect(rejects({ type: "paragraph", content: [{ text: "   " }] })).toBe(true);
    expect(rejects({ type: "paragraph", content: [{ text: "a".repeat(5000) }] })).toBe(false);
    expect(rejects({ type: "paragraph", content: [{ text: "a".repeat(5001) }] })).toBe(true);
    expect(rejects({ type: "heading", level: 2, text: "" })).toBe(true);
    expect(rejects({ ...validBlocks.image, alt: " " })).toBe(true);
  });

  it("rejects empty lists, empty list items, and more than 50 items", () => {
    expect(rejects({ type: "list", ordered: false, items: [] })).toBe(true);
    expect(rejects({ type: "list", ordered: false, items: [[]] })).toBe(true);
    const item = [{ text: "item" }];
    expect(rejects({ type: "list", ordered: false, items: Array.from({ length: 50 }, () => item) })).toBe(false);
    expect(rejects({ type: "list", ordered: false, items: Array.from({ length: 51 }, () => item) })).toBe(true);
  });

  it("rejects invalid UUID references", () => {
    expect(rejects({ type: "book_card" })).toBe(true);
    expect(rejects({ type: "book_card", bookId: "not-a-uuid" })).toBe(true);
    expect(rejects({ type: "idea_card", ideaId: "123" })).toBe(true);
    expect(rejects({ type: "book_quote", bookId: "x", text: "Quote" })).toBe(true);
    expect(rejects({ type: "quote", text: "Quote", bookId: "x" })).toBe(true);
  });

  it.each([
    "covers/books/a0000000-0000-4000-8000-000000000001/cover.webp",
    "knowledge/books/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp",
    "knowledge/ideas/../b0000000-0000-4000-8000-000000000002.webp",
    "knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.svg",
    "knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp/../x",
    "/knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp",
    "https://evil.test/knowledge/ideas/a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002.webp",
  ])("rejects the image storage key %j", (storageKey) => {
    expect(rejects({ ...validBlocks.image, storageKey })).toBe(true);
  });

  it("rejects non-positive or fractional image dimensions", () => {
    expect(rejects({ ...validBlocks.image, width: 0 })).toBe(true);
    expect(rejects({ ...validBlocks.image, height: -1 })).toBe(true);
    expect(rejects({ ...validBlocks.image, width: 10.5 })).toBe(true);
  });

  it("requires exactly one quote attribution source", () => {
    expect(rejects({ type: "quote", text: "Unattributed." })).toBe(true);
    expect(rejects({ type: "quote", text: "Blank.", attribution: "  " })).toBe(true);
    expect(rejects({ type: "quote", text: "Both.", attribution: "Someone", bookId })).toBe(true);
  });

  it("caps book-backed quotes at 300 grapheme clusters", () => {
    const within = "ắ".repeat(300);
    const over = "ắ".repeat(301);
    expect(rejects({ type: "book_quote", bookId, text: within })).toBe(false);
    expect(rejects({ type: "book_quote", bookId, text: over })).toBe(true);
    expect(rejects({ type: "quote", text: within, bookId })).toBe(false);
    expect(rejects({ type: "quote", text: over, bookId })).toBe(true);
    // A freely attributed quote is not a book quote and keeps the ordinary text limit.
    expect(rejects({ type: "quote", text: over, attribution: "Someone" })).toBe(false);
  });

  it("does not transform stored text", () => {
    const block = { type: "paragraph", content: [{ text: "  spaced  " }] };
    expect(knowledgeBlockSchema.parse(block)).toEqual(block);
  });
});

describe("knowledge block list", () => {
  it("accepts exactly 100 blocks and rejects 101", () => {
    const block = validBlocks.heading;
    expect(knowledgeBlocksSchema.safeParse(Array.from({ length: 100 }, () => block)).success).toBe(true);
    expect(knowledgeBlocksSchema.safeParse(Array.from({ length: 101 }, () => block)).success).toBe(false);
  });

  it("accepts an empty body and rejects a non-array", () => {
    expect(knowledgeBlocksSchema.parse([])).toEqual([]);
    expect(knowledgeBlocksSchema.safeParse({ type: "paragraph" }).success).toBe(false);
    expect(knowledgeBlocksSchema.safeParse("<p>html</p>").success).toBe(false);
  });

  it("parses every block type in one body", () => {
    expect(knowledgeBlocksSchema.parse(Object.values(validBlocks))).toEqual(Object.values(validBlocks));
  });
});
