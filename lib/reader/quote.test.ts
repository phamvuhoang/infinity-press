import { afterEach, describe, expect, it } from "vitest";

import { buildAttributedQuote, isWithinBookQuoteLimit, MAX_BOOK_QUOTE_GRAPHEMES, splitGraphemes, truncateBookQuote } from "@/lib/reader/quote";

const input = {
  title: "Book",
  author: "Author",
  canonicalBookUrl: "https://example.test/en/books/book",
};

const originalSegmenterDescriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");

afterEach(() => {
  Object.defineProperty(Intl, "Segmenter", originalSegmenterDescriptor!);
});

describe("buildAttributedQuote", () => {
  it.each([
    [0, false],
    [299, false],
    [300, false],
    [301, true],
  ])("quotes %i ASCII characters and marks truncation at the cap", (length, truncated) => {
    const selection = "a".repeat(length);

    expect(buildAttributedQuote({ ...input, selection })).toEqual({
      text: `“${selection.slice(0, 300)}”\n- Book, Author\nhttps://example.test/en/books/book`,
      truncated,
    });
  });

  it("counts Vietnamese combining marks as graphemes", () => {
    const selection = "a\u0306\u0301".repeat(301);

    expect(buildAttributedQuote({ ...input, selection })).toEqual({
      text: `“${"a\u0306\u0301".repeat(300)}”\n- Book, Author\nhttps://example.test/en/books/book`,
      truncated: true,
    });
  });

  it("keeps joined emoji together while applying the grapheme cap", () => {
    const selection = "👩‍💻".repeat(301);

    expect(buildAttributedQuote({ ...input, selection })).toEqual({
      text: `“${"👩‍💻".repeat(300)}”\n- Book, Author\nhttps://example.test/en/books/book`,
      truncated: true,
    });
  });

  it("always places the exact attribution outside the quote cap", () => {
    expect(
      buildAttributedQuote({
        selection: "selected",
        title: "A title",
        author: "An author",
        canonicalBookUrl: "https://example.test/vi/books/a-title",
      }),
    ).toEqual({
      text: "“selected”\n- A title, An author\nhttps://example.test/vi/books/a-title",
      truncated: false,
    });
  });

  it("uses the documented Array.from code-point fallback when Segmenter is unavailable", () => {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });
    const selection = "👨‍👩‍👧‍👦".repeat(43);

    expect(buildAttributedQuote({ ...input, selection })).toEqual({
      text: `“${"👨‍👩‍👧‍👦".repeat(42)}👨‍👩‍👧‍`.concat(
        "”\n- Book, Author\nhttps://example.test/en/books/book",
      ),
      truncated: true,
    });
  });

  it("restores the original Intl.Segmenter property descriptor after stubbing", () => {
    expect(Object.getOwnPropertyDescriptor(Intl, "Segmenter")).toEqual(originalSegmenterDescriptor);
  });
});

describe("shared book-quote grapheme rules", () => {
  it("caps book quotes at 300 grapheme clusters", () => {
    expect(MAX_BOOK_QUOTE_GRAPHEMES).toBe(300);
  });

  it.each([
    [0, true],
    [300, true],
    [301, false],
  ])("accepts %i ASCII characters only within the cap", (length, within) => {
    expect(splitGraphemes("a".repeat(length))).toHaveLength(length);
    expect(isWithinBookQuoteLimit("a".repeat(length))).toBe(within);
  });

  it("counts a Vietnamese base letter with combining marks as one grapheme", () => {
    expect(splitGraphemes("a\u0306\u0301".repeat(301))).toHaveLength(301);
    expect(isWithinBookQuoteLimit("a\u0306\u0301".repeat(300))).toBe(true);
    expect(isWithinBookQuoteLimit("a\u0306\u0301".repeat(301))).toBe(false);
  });

  it("keeps joined emoji together", () => {
    expect(splitGraphemes("👩‍💻".repeat(3))).toEqual(["👩‍💻", "👩‍💻", "👩‍💻"]);
    expect(isWithinBookQuoteLimit("👩‍💻".repeat(300))).toBe(true);
    expect(isWithinBookQuoteLimit("👩‍💻".repeat(301))).toBe(false);
  });

  it("falls back to code points when Segmenter is unavailable", () => {
    Object.defineProperty(Intl, "Segmenter", { configurable: true, value: undefined });

    // One family emoji is seven code points without Segmenter.
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toHaveLength(7);
    expect(splitGraphemes("a\u0306\u0301")).toHaveLength(3);
    expect(isWithinBookQuoteLimit("a\u0306\u0301".repeat(100))).toBe(true);
    expect(isWithinBookQuoteLimit("a\u0306\u0301".repeat(101))).toBe(false);
  });
});

describe("truncateBookQuote", () => {
  it("keeps 300 grapheme clusters and reports the cut", () => {
    const cluster = "e\u0302\u0301"; // decomposed: e + combining circumflex + combining acute, one grapheme
    expect(truncateBookQuote(cluster.repeat(300))).toEqual({ quote: cluster.repeat(300), truncated: false });
    const cut = truncateBookQuote(cluster.repeat(301));
    expect(cut.truncated).toBe(true);
    expect(splitGraphemes(cut.quote)).toHaveLength(300);
    expect(cut.quote).toBe(cluster.repeat(300));
  });
});
