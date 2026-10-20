import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { RecommendationShelf } from "@/components/catalog/recommendation-shelf";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

function makeCard(bookId: string, slug: string, title: string): CatalogBookCard {
  return {
    bookId,
    slug,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "An Author", slug: "an-author" },
    cover: { url: `http://127.0.0.1:54321/storage/v1/object/public/covers/books/${bookId}/cover.png`, alt: `Cover of ${title}` },
    offer: null,
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
  };
}

const HEADING = "Related books";
const HEADING_ID = "recommendation-shelf-test";

it("renders no section and no heading for zero books", () => {
  const { container } = render(
    <RecommendationShelf books={[]} copy={en.catalog.book} headingId={HEADING_ID} heading={HEADING} locale="en" />,
  );
  expect(screen.queryByRole("heading", { name: HEADING })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: HEADING })).not.toBeInTheDocument();
  expect(container).toBeEmptyDOMElement();
});

it("renders exactly six list items when given eight books", () => {
  const books = Array.from({ length: 8 }, (_, index) => makeCard(`book-${index}`, `book-${index}`, `Book ${index}`));
  render(<RecommendationShelf books={books} copy={en.catalog.book} headingId={HEADING_ID} heading={HEADING} locale="en" />);
  expect(screen.getAllByRole("listitem")).toHaveLength(6);
});

it("preserves input link order, names the region by its heading, and keeps titles as focusable links", () => {
  // Input order (C, A, B) is neither alphabetical nor bookId order, so a component that
  // re-sorted by title or id would produce a different sequence than the one asserted below.
  const books = [makeCard("c", "book-c", "Book C"), makeCard("a", "book-a", "Book A"), makeCard("b", "book-b", "Book B")];
  render(<RecommendationShelf books={books} copy={en.catalog.book} headingId={HEADING_ID} heading={HEADING} locale="en" />);

  const region = screen.getByRole("region", { name: HEADING });
  expect(region).toBeVisible();
  expect(screen.getByRole("heading", { name: HEADING })).toBeVisible();

  const links = screen.getAllByRole("link");
  expect(links.map((link) => link.textContent)).toEqual(["Book C", "Book A", "Book B"]);
  for (const link of links) {
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href");
  }
});

it("gives the card list horizontal-overflow styling with fixed, non-shrinking card widths", () => {
  const books = [makeCard("a", "book-a", "Book A")];
  render(<RecommendationShelf books={books} copy={en.catalog.book} headingId={HEADING_ID} heading={HEADING} locale="en" />);
  const list = screen.getByRole("list");
  expect(list.className).toMatch(/overflow-x-auto/);

  const item = screen.getByRole("listitem");
  expect(item.className).toMatch(/shrink-0/);
  expect(item.className).toMatch(/\bw-40\b/);
});
