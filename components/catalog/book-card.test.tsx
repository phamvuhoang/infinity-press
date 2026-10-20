import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { BookCard } from "@/components/catalog/book-card";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import en from "@/lib/i18n/dictionaries/en.json";

afterEach(cleanup);

const card: CatalogBookCard = {
  bookId: "30000000-0000-4000-8000-000000000001",
  slug: "harbour-lights",
  title: "Harbour Lights",
  subtitle: null,
  shortDescription: null,
  author: { name: "Mai Tran", slug: "mai-tran" },
  cover: { url: "http://127.0.0.1:54321/storage/v1/object/public/covers/books/x/cover.png", alt: "Cover of Harbour Lights" },
  offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasActivePublication: true,
  hasSample: false, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
  series: null,
  topics: [],
  featured: false,
  shelfPosition: null,
  createdAt: "2026-09-01T00:00:00+00:00",
};

it("names the card link by the title alone and marks a free book", () => {
  render(<BookCard card={card} copy={en.catalog.book} locale="en" />);
  expect(screen.getByRole("link", { name: "Harbour Lights" })).toHaveAttribute("href", "/en/books/harbour-lights");
  expect(screen.getByText("Mai Tran")).toBeVisible();
  expect(screen.getByText("Free")).toBeVisible();
});

it("shows a sale price with the list price struck through and both labelled for screen readers", () => {
  const onSale = { ...card, offer: { priceMinor: 90300, currency: "VND", listPriceMinor: 129000, saleEndsAt: null } };
  const { container } = render(<BookCard card={onSale} copy={en.catalog.book} locale="vi" />);
  const struck = container.querySelector("del");
  expect(struck).toHaveTextContent("List price: 129.000");
  expect(struck?.parentElement).toHaveTextContent(/^Sale price: 90\.300\s₫/);
});

it("names the language of the EPUB on every card", () => {
  render(<BookCard card={{ ...card, languageCode: "ja" }} copy={en.catalog.book} locale="en" />);
  expect(screen.getByText("日本語")).toBeInTheDocument();
});
