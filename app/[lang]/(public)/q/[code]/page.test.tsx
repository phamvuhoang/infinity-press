import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import QuoteCardImage from "@/app/[lang]/(public)/q/[code]/opengraph-image";
import QuoteCardPage, { generateMetadata } from "@/app/[lang]/(public)/q/[code]/page";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getBookCardById } from "@/lib/data/catalog";
import { getSharedQuote } from "@/lib/data/shared-quotes";

const viewer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/catalog/book-edition-panel", () => ({
  BookEditionPanel: (props: Record<string, unknown>) => {
    viewer.props = props;
    return <p data-testid="viewer-action" />;
  },
}));
const analytics = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/analytics/analytics-event", () => ({
  AnalyticsEvent: (props: Record<string, unknown>) => {
    analytics.props = props;
    return null;
  },
}));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/app/[lang]/(public)/books/[slug]/actions", () => ({ buyEbookAction: vi.fn(), getFreeEbookAction: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/og", () => ({ ImageResponse: class {} }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: () => ({ siteUrl: "https://books.example" }) }));
vi.mock("@/lib/data/catalog", () => ({ getBookCardById: vi.fn() }));
vi.mock("@/lib/data/editions", () => ({
  getBookEditions: vi.fn(async () => [
    { editionId: "edition-1", languageCode: "en", epubLanguage: "en", isDefault: true, offer: null, hasSample: false },
    { editionId: "edition-2", languageCode: "ja", epubLanguage: "ja", isDefault: false, offer: null, hasSample: false },
  ]),
}));
vi.mock("@/lib/commerce/payment-provider", () => ({ arePaymentsEnabled: vi.fn(() => true) }));
vi.mock("@/lib/data/shared-quotes", () => ({ getSharedQuote: vi.fn() }));

const card = {
  id: "90000000-0000-4000-8000-000000000001",
  code: "AbCdEfGh12",
  quote: "Một câu đáng nhớ.",
  locale: "vi" as const,
  bookId: "30000000-0000-4000-8000-000000000001",
  createdAt: "2026-10-09T00:00:00+00:00",
  chunkOrdinal: 12,
  question: null,
  textKind: "verbatim" as const,
  editionId: "edition-1",
  chunkExists: true,
  sampleAllowsChunk: true,
  languages: [{ editionId: "edition-1", languageCode: "vi", ordinal: 12, sampleAllows: true }],
};
const book: CatalogBookCard = {
  bookId: card.bookId,
  slug: "sach-s16",
  title: "Sách S16",
  subtitle: null,
  shortDescription: null,
  author: { name: "Tác giả", slug: "tac-gia" },
  cover: null,
  offer: { priceMinor: 99000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasActivePublication: true,
  hasSample: true, editionId: "edition-1", languageCode: "en", isLanguageFallback: false, metadataLocale: "en",
  series: null,
  topics: [],
  featured: false,
  shelfPosition: null,
  createdAt: "",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSharedQuote).mockResolvedValue(card);
  vi.mocked(getBookCardById).mockResolvedValue(book);
});
afterEach(cleanup);

describe("quote card page", () => {
  it("renders the quote, attribution links, the viewer action, the sample link, and the view event", async () => {
    render(await QuoteCardPage({ params: Promise.resolve({ lang: "en", code: "AbCdEfGh12" }) }));
    expect(screen.getByText("“Một câu đáng nhớ.”")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sách S16" })).toHaveAttribute("href", "/vi/books/sach-s16");
    // The sample link is the edition panel's, built from the slug and the edition it sells.
    expect(viewer.props).toMatchObject({ bookId: card.bookId, bookSlug: "sach-s16", locale: "vi", selectable: false });
    expect((viewer.props!.editions as { editionId: string }[]).map((edition) => edition.editionId)).toEqual(["edition-1"]);
    expect(analytics.props).toEqual({ eventName: "view_quote", sharedQuoteId: card.id, bookId: card.bookId, locale: "vi" });
    // The card loads the book in ITS locale, not the path's.
    expect(getBookCardById).toHaveBeenCalledWith("vi", card.bookId);
  });

  it("404s when the card or the book is missing", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue(null);
    await expect(QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getSharedQuote).mockResolvedValue(card);
    vi.mocked(getBookCardById).mockResolvedValue(null);
    await expect(QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("is noindex,follow with the canonical on the book page and leaves the OG image to the file convention", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(metadata.alternates?.canonical).toBe("https://books.example/vi/books/sach-s16");
    expect(metadata.title).toBe("“Một câu đáng nhớ.” - Sách S16");
    expect(metadata.openGraph?.url).toBe("https://books.example/vi/q/AbCdEfGh12");
    // The sibling image is injected by the file convention at a hashed path; a hand-built
    // `/opengraph-image` URL would 404 and would override nothing.
    expect(metadata.openGraph).not.toHaveProperty("images");
  });

  it("cuts a long quote in the title at 60 graphemes without splitting a cluster", async () => {
    // Decomposed: e + combining circumflex + combining acute is one grapheme, three code points.
    const e = "ế";
    vi.mocked(getSharedQuote).mockResolvedValue({ ...card, quote: e.repeat(80) });
    const metadata = await generateMetadata({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) });
    expect(metadata.title).toBe(`“${e.repeat(60)}…” - Sách S16`);
  });
});

describe("quote card passage", () => {
  const continueName = "Đọc tiếp từ đây";

  it("links to the sample reader at the shared passage and shows the question and the kind", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue({ ...card, question: "Vì sao tác giả nói vậy?", textKind: "paraphrase" });
    render(await QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) }));
    expect(screen.getByRole("link", { name: continueName })).toHaveAttribute("href", "/vi/read-sample/sach-s16?edition=edition-1&anchor=12");
    expect(screen.getByText("Vì sao tác giả nói vậy?")).toBeInTheDocument();
    expect(screen.getByText("Diễn giải")).toBeInTheDocument();
    // One language only: no "read in" choice.
    expect(screen.queryByText("Đọc bằng")).not.toBeInTheDocument();
  });

  it.each([
    ["the chunk is gone", { chunkExists: false, sampleAllowsChunk: false }],
    ["the sample refuses the chunk", { sampleAllowsChunk: false }],
  ])("hides the continue link when %s", async (_name, change) => {
    vi.mocked(getSharedQuote).mockResolvedValue({ ...card, ...change });
    render(await QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) }));
    expect(screen.queryByRole("link", { name: continueName })).not.toBeInTheDocument();
    expect(screen.getByText("Nguyên văn")).toBeInTheDocument();
  });

  it("offers each aligned language, linking only where its sample allows the passage", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue({
      ...card,
      languages: [
        { editionId: "edition-1", languageCode: "vi", ordinal: 12, sampleAllows: true },
        { editionId: "edition-2", languageCode: "en", ordinal: 30, sampleAllows: true },
        { editionId: "edition-3", languageCode: "ja", ordinal: 41, sampleAllows: false },
      ],
    });
    render(await QuoteCardPage({ params: Promise.resolve({ lang: "vi", code: "AbCdEfGh12" }) }));
    expect(screen.getByText("Đọc bằng")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "English" })).toHaveAttribute("href", "/vi/read-sample/sach-s16?edition=edition-2&anchor=30");
    expect(screen.getByRole("link", { name: "Tiếng Việt" })).toHaveAttribute("href", "/vi/read-sample/sach-s16?edition=edition-1&anchor=12");
    expect(screen.queryByRole("link", { name: "日本語" })).not.toBeInTheDocument();
    expect(screen.getByText("日本語")).toBeInTheDocument();
  });
});

describe("quote card image", () => {
  it("404s when the card or the book is missing", async () => {
    vi.mocked(getSharedQuote).mockResolvedValue(null);
    await expect(QuoteCardImage({ params: Promise.resolve({ code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    vi.mocked(getSharedQuote).mockResolvedValue(card);
    vi.mocked(getBookCardById).mockResolvedValue(null);
    await expect(QuoteCardImage({ params: Promise.resolve({ code: "AbCdEfGh12" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
