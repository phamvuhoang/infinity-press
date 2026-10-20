// Shapes that public pages render. They hold no storage keys except the public cover URL, no
// publication IDs, and no entitlement data.

import type { Retailer } from "@/lib/analytics/browser";
import type { AlternateSlugs } from "@/lib/i18n/alternates";

export type CatalogEntityKind = "author" | "series" | "topic";

export type CatalogTopicRef = { slug: string; name: string };

export type CatalogBookCard = {
  bookId: string;
  slug: string;
  title: string;
  subtitle: string | null;
  shortDescription: string | null;
  // slug is null when the author has no public page in this locale.
  author: { name: string; slug: string | null };
  cover: { url: string; alt: string } | null;
  // Only active, in-window offers reach this type. priceMinor is what a buyer pays now: the sale
  // price while a sale runs (S19). listPriceMinor and saleEndsAt are set only while a sale lowers it.
  offer: { priceMinor: number; currency: string; listPriceMinor: number | null; saleEndsAt: string | null } | null;
  hasActivePublication: boolean;
  hasSample: boolean;
  series: { slug: string; name: string; position: number } | null;
  topics: CatalogTopicRef[];
  featured: boolean;
  shelfPosition: number | null;
  createdAt: string;
};

export type CatalogRetailLink = {
  id: string;
  retailer: Retailer;
  label: string | null;
  url: string;
  priceMinor: number | null;
  currency: string | null;
};

export type CatalogReviewSummary = { count: number; average: number };

export type CatalogBookPage = CatalogBookCard & {
  description: string | null;
  audience: string | null;
  keyIdeas: { title: string; summary: string }[];
  faq: { question: string; answer: string }[];
  seoTitle: string | null;
  seoDescription: string | null;
  alternateSlugs: AlternateSlugs;
  isbn: string | null;
  // Active links of a published book, in editorial order. The URL is the stored one; the page
  // decorates it with UTM parameters at render time.
  retailLinks: CatalogRetailLink[];
  // Published reviews only. Null when the book has none (or the stored value is malformed).
  reviewSummary: CatalogReviewSummary | null;
};

export type CatalogEntityPage = {
  kind: CatalogEntityKind;
  id: string;
  name: string;
  description: string | null;
  alternateSlugs: AlternateSlugs;
  // Authors only. Series and topics always report null for both.
  quote: string | null;
  image: { url: string; alt: string } | null;
  books: CatalogBookCard[];
};

// Home page blocks from board 1e. The hero image is operator-managed in /admin/merchandising; the
// topics are every published topic that already holds a book.
export type CatalogHomeHero = { desktopUrl: string; mobileUrl: string; alt: string };

export type CatalogHomeTopic = { slug: string; name: string; description: string | null };
