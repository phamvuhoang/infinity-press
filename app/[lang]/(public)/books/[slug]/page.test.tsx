import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BookPage from "@/app/[lang]/(public)/books/[slug]/page";
import type { CatalogBookPage } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookPage } from "@/lib/data/catalog";
import { getKnowledgeForBook } from "@/lib/data/knowledge";
import { getBookAcceptsQuestions } from "@/lib/data/catalog";
import { getBookReviews } from "@/lib/data/reviews";
import type { KnowledgeLinkSummary } from "@/lib/knowledge/public-types";

// The viewer action is a client component that corrects the prerendered public action; this test
// only checks which public action the page hands it.
const viewer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("@/components/catalog/viewer-book-action", () => ({
  ViewerBookAction: (props: Record<string, unknown>) => {
    viewer.props = props;
    return <p data-testid="viewer-action">{String((props.publicAction as { kind: string }).kind)}</p>;
  },
}));
vi.mock("@/components/catalog/action-error-banner", () => ({ ActionErrorBanner: () => null }));
vi.mock("@/components/analytics/analytics-event", () => ({ AnalyticsEvent: () => null }));
vi.mock("@/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("@/app/[lang]/(public)/books/[slug]/actions", () => ({
  buyEbookAction: vi.fn(),
  getFreeEbookAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/commerce/payment-provider", () => ({ arePaymentsEnabled: vi.fn(() => true) }));
vi.mock("@/lib/data/catalog", () => ({
  getBookAcceptsQuestions: vi.fn(async () => true),
  getBookPage: vi.fn(),
  publicBookAction: vi.fn(() => ({ kind: "buy" })),
}));
vi.mock("@/lib/data/knowledge", () => ({ getKnowledgeForBook: vi.fn() }));
vi.mock("@/lib/data/reviews", () => ({ getBookReviews: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";

function makeBook(overrides: Partial<CatalogBookPage> = {}): CatalogBookPage {
  return {
    bookId: BOOK_ID,
    slug: "harbour-lights",
    title: "Harbour Lights",
    subtitle: null,
    shortDescription: "A short description.",
    author: { name: "Mai Tran", slug: "mai-tran" },
    cover: null,
    offer: { priceMinor: 99000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
    hasSample: true,
    series: null,
    topics: [{ slug: "habits", name: "Habits" }],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00+00:00",
    description: null,
    audience: null,
    keyIdeas: [],
    faq: [{ question: "Is it long?", answer: "No." }],
    seoTitle: null,
    seoDescription: null,
    alternateSlug: null,
    isbn: null,
    retailLinks: [],
    reviewSummary: null,
    ...overrides,
  };
}

const links: KnowledgeLinkSummary[] = [
  { kind: "idea", slug: "small-habits", title: "Why do small habits last?", excerpt: "They are easy.", publishedAt: null },
  {
    kind: "article",
    slug: "reading-harbour-lights",
    title: "Reading Harbour Lights",
    excerpt: "A guide.",
    publishedAt: "2026-09-10T00:00:00+00:00",
  },
];

function paramsFor(lang: string, slug = "harbour-lights") {
  return { params: Promise.resolve({ lang, slug }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  viewer.props = null;
  vi.mocked(getBookReviews).mockResolvedValue([]);
  vi.mocked(getServerEnv).mockReturnValue({ siteUrl: "https://infinitybooks.test" } as ReturnType<typeof getServerEnv>);
});

afterEach(cleanup);

describe("BookPage knowledge backlinks", () => {
  it("loads backlinks for the resolved public book and links ideas and articles by locale", async () => {
    // The public slug differs from the book id; the DAL must receive the id getBookPage resolved.
    vi.mocked(getBookPage).mockResolvedValue(makeBook());
    vi.mocked(getKnowledgeForBook).mockResolvedValue(links);

    render(await BookPage(paramsFor("en")));

    expect(getBookPage).toHaveBeenCalledWith("en", "harbour-lights");
    expect(getKnowledgeForBook).toHaveBeenCalledWith("en", BOOK_ID);

    const section = screen.getByRole("region", { name: "Ideas and articles about this book" });
    expect(within(section).getByRole("link", { name: "Why do small habits last?" })).toHaveAttribute(
      "href",
      "/en/ideas/small-habits",
    );
    expect(within(section).getByRole("link", { name: "Reading Harbour Lights" })).toHaveAttribute(
      "href",
      "/en/articles/reading-harbour-lights",
    );
    expect(within(section).getByText("Idea")).toBeVisible();
    expect(within(section).getByText("Article")).toBeVisible();

    // Rendered below the existing FAQ content.
    const faq = screen.getByRole("heading", { name: "Questions and answers" });
    expect(faq.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses Vietnamese copy and paths on the Vietnamese page", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook());
    vi.mocked(getKnowledgeForBook).mockResolvedValue(links);

    render(await BookPage(paramsFor("vi")));

    expect(getKnowledgeForBook).toHaveBeenCalledWith("vi", BOOK_ID);
    const section = screen.getByRole("region", { name: "Ý tưởng và bài viết về cuốn sách này" });
    expect(within(section).getByRole("link", { name: "Why do small habits last?" })).toHaveAttribute(
      "href",
      "/vi/ideas/small-habits",
    );
    expect(within(section).getByRole("link", { name: "Reading Harbour Lights" })).toHaveAttribute(
      "href",
      "/vi/articles/reading-harbour-lights",
    );
  });

  it("renders no knowledge heading when the book has no backlinks", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook());
    vi.mocked(getKnowledgeForBook).mockResolvedValue([]);

    render(await BookPage(paramsFor("en")));

    expect(screen.queryByRole("heading", { name: "Ideas and articles about this book" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Ideas and articles about this book" })).not.toBeInTheDocument();
  });

  it("keeps the purchase, sample, topic, and FAQ content", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook());
    vi.mocked(getKnowledgeForBook).mockResolvedValue(links);

    render(await BookPage(paramsFor("en")));

    expect(screen.getByRole("heading", { level: 1, name: "Harbour Lights" })).toBeVisible();
    expect(screen.getByTestId("viewer-action")).toHaveTextContent("buy");
    expect(viewer.props).toMatchObject({ bookId: BOOK_ID, bookPath: "/en/books/harbour-lights", locale: "en" });
    expect(screen.getByRole("link", { name: "Read a sample" })).toHaveAttribute("href", "/en/read-sample/harbour-lights");
    expect(screen.getByRole("heading", { name: "Topics" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Habits" })).toHaveAttribute("href", "/en/topics/habits");
    expect(screen.getByRole("heading", { name: "Questions and answers" })).toBeVisible();
    expect(screen.getByText("Is it long?")).toBeInTheDocument();
  });

  it("never loads backlinks for a missing or unpublished book", async () => {
    vi.mocked(getBookPage).mockResolvedValue(null);

    await expect(BookPage(paramsFor("en", "missing"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getKnowledgeForBook).not.toHaveBeenCalled();
    expect(getBookReviews).not.toHaveBeenCalled();
  });

  it("never loads backlinks for an unsupported locale", async () => {
    await expect(BookPage(paramsFor("fr"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getBookPage).not.toHaveBeenCalled();
    expect(getKnowledgeForBook).not.toHaveBeenCalled();
  });
});

describe("BookPage paperback block", () => {
  const retailLinks: CatalogBookPage["retailLinks"] = [
    { id: "r1", retailer: "shopee", label: null, url: "https://shopee.vn/harbour-lights", priceMinor: 129000, currency: "VND" },
    { id: "r2", retailer: "other", label: "Local shop", url: "https://shop.example/hl?utm_source=aff", priceMinor: null, currency: null },
  ];

  it("shows outbound sponsored links with UTM, label, and list price", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook({ retailLinks }));
    vi.mocked(getKnowledgeForBook).mockResolvedValue([]);

    render(await BookPage(paramsFor("en")));

    const section = screen.getByRole("region", { name: "Paperback" });
    const shopee = within(section).getByRole("link", { name: "Shopee" });
    expect(shopee).toHaveAttribute(
      "href",
      "https://shopee.vn/harbour-lights?utm_source=infinitybooks&utm_medium=book_page&utm_campaign=paperback&utm_content=en",
    );
    expect(shopee).toHaveAttribute("rel", "nofollow noopener sponsored");
    expect(within(section).getByText(/^List price.*129[.,]000/)).toBeVisible();
    // A stored affiliate URL keeps its own tracking.
    expect(within(section).getByRole("link", { name: "Local shop" })).toHaveAttribute(
      "href",
      "https://shop.example/hl?utm_source=aff",
    );
  });

  it("renders no paperback block when the book has no retail links", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook());
    vi.mocked(getKnowledgeForBook).mockResolvedValue([]);

    render(await BookPage(paramsFor("en")));

    expect(screen.queryByRole("region", { name: "Paperback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Paperback" })).not.toBeInTheDocument();
  });
});

describe("BookPage reviews", () => {
  const review = {
    id: "rev1",
    reviewerName: null,
    rating: 4,
    body: "Warm and clear.",
    authorReply: null,
    authorReplyAt: null,
    publishedAt: "2026-09-12T00:00:00Z",
  };

  it("renders the reviews section and feeds the same reviews to the Book JSON-LD", async () => {
    vi.mocked(getBookPage).mockResolvedValue(makeBook({ reviewSummary: { count: 1, average: 4 } }));
    vi.mocked(getKnowledgeForBook).mockResolvedValue([]);
    vi.mocked(getBookReviews).mockResolvedValue([review]);

    const { container } = render(await BookPage(paramsFor("en")));

    expect(getBookReviews).toHaveBeenCalledWith(BOOK_ID, 5);
    const section = screen.getByRole("region", { name: "Reader reviews" });
    expect(within(section).getByText("Warm and clear.")).toBeVisible();
    expect(within(section).getByText("Reader")).toBeVisible();
    expect(within(section).getByRole("link", { name: "Write a review" })).toHaveAttribute(
      "href",
      `/en/library/reviews/${BOOK_ID}`,
    );
    expect(within(section).getByRole("link", { name: "Ask the author" })).toHaveAttribute("href", `/en/ask?book=${BOOK_ID}`);

    const book = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((node) => JSON.parse(node.textContent ?? "null"))
      .flat()
      .find((node) => node?.["@type"] === "Book");
    expect(book.aggregateRating).toMatchObject({ ratingValue: 4, reviewCount: 1 });
    expect(book.review[0].author.name).toBe("Reader");

    cleanup();
    vi.mocked(getBookAcceptsQuestions).mockResolvedValueOnce(false);
    render(await BookPage(paramsFor("en")));
    expect(screen.queryByRole("link", { name: "Ask the author" })).toBeNull();
    expect(screen.getByRole("link", { name: "Write a review" })).toBeInTheDocument();
  });
});
