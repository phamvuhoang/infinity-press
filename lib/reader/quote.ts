// The one book-quote length rule (S5.5): a quote from a book is at most 300 Unicode grapheme
// clusters. Reader quotes and editorial `book_quote` blocks (S12) both use these helpers, so the
// two limits cannot drift apart.
export const MAX_BOOK_QUOTE_GRAPHEMES = 300;

export function splitGraphemes(text: string): string[] {
  return typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (part) => part.segment)
    : // Array.from is intentionally a code-point fallback and can split a grapheme cluster.
      Array.from(text);
}

export function isWithinBookQuoteLimit(text: string): boolean {
  return splitGraphemes(text).length <= MAX_BOOK_QUOTE_GRAPHEMES;
}

export function truncateBookQuote(text: string): { quote: string; truncated: boolean } {
  const units = splitGraphemes(text);
  return { quote: units.slice(0, MAX_BOOK_QUOTE_GRAPHEMES).join(""), truncated: units.length > MAX_BOOK_QUOTE_GRAPHEMES };
}

export function buildAttributedQuote(input: {
  selection: string;
  title: string;
  author: string;
  canonicalBookUrl: string;
}): { text: string; truncated: boolean } {
  const { quote, truncated } = truncateBookQuote(input.selection);
  return { text: `“${quote}”\n- ${input.title}, ${input.author}\n${input.canonicalBookUrl}`, truncated };
}
