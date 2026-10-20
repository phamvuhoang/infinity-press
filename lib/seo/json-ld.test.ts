import { describe, expect, it } from "vitest";

import type {
  CatalogBookCard,
  CatalogBookPage,
  CatalogEntityPage,
} from "@/lib/catalog/public-types";
import type { PublicBundleDTO } from "@/lib/data/public-bundles";
import type {
  KnowledgeArticlePage,
  KnowledgeIdeaPage,
  KnowledgeIdeaSummary,
} from "@/lib/knowledge/public-types";
import {
  bookSchema,
  breadcrumbSchema,
  bundleSchema,
  ideaFaqSchema,
  knowledgeArticleSchema,
  organizationSchema,
  personSchema,
  serializeJsonLd,
} from "@/lib/seo/json-ld";

const siteUrl = "https://books.example";

const book: CatalogBookPage = {
  bookId: "30000000-0000-4000-8000-000000000001",
  slug: "harbour-lights",
  title: "Harbour Lights",
  subtitle: "A novel",
  shortDescription: "A quiet book about the sea.",
  author: { name: "Mai Tran", slug: "mai-tran" },
  cover: {
    url: "https://cdn.example/covers/harbour.png",
    alt: "Cover of Harbour Lights",
  },
  offer: { priceMinor: 0, currency: "VND", listPriceMinor: null, saleEndsAt: null },
  hasActivePublication: true,
  hasSample: true,
  series: null,
  topics: [{ slug: "sea", name: "Sea" }],
  featured: false,
  shelfPosition: null,
  createdAt: "2026-09-01T00:00:00+00:00",
  description: "Long description.",
  audience: "PRIVATE-AUDIENCE-MARKER",
  keyIdeas: [],
  faq: [],
  seoTitle: "SEO-TITLE-MARKER",
  seoDescription: "SEO-DESCRIPTION-MARKER",
  alternateSlugs: { vi: "den-cang" },
  isbn: null,
  retailLinks: [],
  reviewSummary: null,
};

describe("organizationSchema", () => {
  it("describes the site as an Organization", () => {
    expect(organizationSchema(siteUrl)).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Infinity Books Press",
      url: "https://books.example",
    });
  });
});

describe("breadcrumbSchema", () => {
  it("numbers absolute items from one", () => {
    expect(
      breadcrumbSchema(siteUrl, [
        { name: "Infinity Books Press", path: "/en" },
        { name: "Books", path: "/en/books?sort=title" },
      ]),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Infinity Books Press",
          item: "https://books.example/en",
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Books",
          item: "https://books.example/en/books",
        },
      ],
    });
  });
});

describe("bookSchema", () => {
  const siteOrg = {
    "@type": "Organization",
    name: "Infinity Books Press",
    url: siteUrl,
  };
  const ebookOffer = (offers: unknown) => (offers as unknown[])[0];
  const ebookItem = { "@type": "Book", bookFormat: "https://schema.org/EBook" };
  const build = (
    overrides: Partial<CatalogBookPage> = {},
    paymentsEnabled = true,
  ) =>
    bookSchema({
      siteUrl,
      locale: "en",
      path: "/en/books/harbour-lights",
      book: { ...book, ...overrides },
      paymentsEnabled,
    });

  it("emits a Book with its Person author and an Offer", () => {
    expect(build()).toEqual({
      "@context": "https://schema.org",
      "@type": "Book",
      name: "Harbour Lights",
      alternativeHeadline: "A novel",
      description: "A quiet book about the sea.",
      url: "https://books.example/en/books/harbour-lights",
      inLanguage: "en",
      bookFormat: "https://schema.org/EBook",
      image: "https://cdn.example/covers/harbour.png",
      author: {
        "@type": "Person",
        name: "Mai Tran",
        url: "https://books.example/en/authors/mai-tran",
      },
      offers: [
        {
          "@type": "Offer",
          price: 0,
          priceCurrency: "VND",
          availability: "https://schema.org/InStock",
          url: "https://books.example/en/books/harbour-lights",
          seller: siteOrg,
          itemOffered: ebookItem,
        },
      ],
    });
  });

  it("uses price 0 with the offer currency for a free book", () => {
    expect(
      ebookOffer(build({ offer: { priceMinor: 0, currency: "USD", listPriceMinor: null, saleEndsAt: null } }).offers),
    ).toMatchObject({ price: 0, priceCurrency: "USD" });
  });

  it("converts the stored minor-unit price for the currency", () => {
    expect(
      ebookOffer(build({ offer: { priceMinor: 1299, currency: "USD", listPriceMinor: null, saleEndsAt: null } }).offers),
    ).toMatchObject({ price: 12.99, priceCurrency: "USD" });
    expect(
      ebookOffer(build({ offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null } }).offers),
    ).toMatchObject({ price: 129000 });
  });

  it("prices a running sale at the sale price with the list price as a StrikethroughPrice", () => {
    const offer = ebookOffer(
      build({ offer: { priceMinor: 90300, currency: "VND", listPriceMinor: 129000, saleEndsAt: "2026-11-01T00:00:00+00:00" } }).offers,
    );
    expect(offer).toMatchObject({
      price: 90300,
      priceValidUntil: "2026-10-31",
      priceSpecification: [
        { "@type": "UnitPriceSpecification", price: 90300, priceCurrency: "VND" },
        { "@type": "UnitPriceSpecification", priceType: "https://schema.org/StrikethroughPrice", price: 129000, priceCurrency: "VND" },
      ],
    });
  });

  it("gives a sale with no end no priceValidUntil, and no sale no price specification", () => {
    const open = ebookOffer(build({ offer: { priceMinor: 90300, currency: "VND", listPriceMinor: 129000, saleEndsAt: null } }).offers);
    expect(open).not.toHaveProperty("priceValidUntil");
    expect(open).toHaveProperty("priceSpecification");
    const plain = ebookOffer(build({ offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null } }).offers);
    expect(plain).not.toHaveProperty("priceSpecification");
  });

  it("marks an enabled paid offer in stock", () => {
    expect(
      ebookOffer(build({ offer: { priceMinor: 1299, currency: "USD", listPriceMinor: null, saleEndsAt: null } }, true).offers),
    ).toMatchObject({
      availability: "https://schema.org/InStock",
    });
  });

  it("marks a coming-soon paid offer out of stock because the site takes no preorders", () => {
    expect(
      ebookOffer(build({ offer: { priceMinor: 1299, currency: "USD", listPriceMinor: null, saleEndsAt: null } }, false).offers),
    ).toMatchObject({
      availability: "https://schema.org/OutOfStock",
    });
  });

  it("keeps a free offer in stock while payments are disabled", () => {
    expect(ebookOffer(build({}, false).offers)).toMatchObject({
      availability: "https://schema.org/InStock",
    });
  });

  it("emits an array with the ebook offer and one paperback offer per retail link", () => {
    const withLinks: CatalogBookPage = {
      ...book,
      isbn: "9786040000001",
      retailLinks: [
        { id: "l1", retailer: "shopee", label: null, url: "https://shopee.vn/x", priceMinor: 129000, currency: "VND" },
        { id: "l2", retailer: "other", label: "Nhà sách ABC", url: "https://abc.example/x", priceMinor: null, currency: null },
      ],
    };
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/harbour-lights", book: withLinks, paymentsEnabled: true });
    expect(schema.isbn).toBe("9786040000001");
    expect(schema.offers).toEqual([
      expect.objectContaining({ "@type": "Offer", price: 0, priceCurrency: "VND", seller: siteOrg, itemOffered: ebookItem }),
      {
        "@type": "Offer",
        url: "https://shopee.vn/x?utm_source=infinitybookspress&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
        availability: "https://schema.org/InStock",
        price: 129000,
        priceCurrency: "VND",
        seller: { "@type": "Organization", name: "Shopee" },
        itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback" },
      },
      {
        "@type": "Offer",
        url: "https://abc.example/x?utm_source=infinitybookspress&utm_medium=book_page&utm_campaign=paperback&utm_content=vi",
        availability: "https://schema.org/InStock",
        seller: { "@type": "Organization", name: "Nhà sách ABC" },
        itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback" },
      },
    ]);
  });

  it("never attaches the edition's isbn to a paperback offer", () => {
    const schema = build({
      isbn: null,
      retailLinks: [{ id: "l1", retailer: "tiki", label: null, url: "https://tiki.vn/x", priceMinor: null, currency: null }],
    });
    const paperback = (schema.offers as Record<string, unknown>[])[1];
    expect(paperback.itemOffered).toEqual({ "@type": "Book", bookFormat: "https://schema.org/Paperback" });
    expect(paperback).not.toHaveProperty("price");
  });

  it("omits offers when there is no ebook offer and no link", () => {
    expect(build({ offer: null, retailLinks: [] })).not.toHaveProperty("offers");
  });

  it("omits the Offer when the page shows no price", () => {
    expect(build({ offer: null })).not.toHaveProperty("offers");
  });

  it("omits fields the page does not show", () => {
    const schema = build({
      subtitle: null,
      shortDescription: null,
      cover: null,
      author: { name: "Anon", slug: null },
    });
    expect(schema).not.toHaveProperty("alternativeHeadline");
    expect(schema).not.toHaveProperty("image");
    expect(schema.description).toBe("Long description.");
    expect(schema.author).toEqual({ "@type": "Person", name: "Anon" });
    expect(
      build({ shortDescription: null, description: null }),
    ).not.toHaveProperty("description");
  });

  it("carries only visible public fields", () => {
    const text = JSON.stringify(build());
    for (const hidden of [
      "SEO-TITLE-MARKER",
      "SEO-DESCRIPTION-MARKER",
      "PRIVATE-AUDIENCE-MARKER",
      book.bookId,
      "den-cang",
    ]) {
      expect(text).not.toContain(hidden);
    }
  });
});

describe("bookSchema reviews", () => {
  const reviews = [{ id: "r1", reviewerName: "Minh Anh", rating: 5, body: "Rất hay.", authorReply: "Cảm ơn", authorReplyAt: "2026-09-13T00:00:00+00:00", publishedAt: "2026-09-12T00:00:00+00:00" }];
  it("emits aggregateRating and review from the rendered reviews", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 12, average: 4.6 } }, reviews });
    expect(schema.aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 12, bestRating: 5, worstRating: 1 });
    expect(schema.review).toEqual([{ "@type": "Review", author: { "@type": "Person", name: "Minh Anh" }, reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 }, reviewBody: "Rất hay.", datePublished: "2026-09-12T00:00:00+00:00" }]);
  });
  it("uses the anonymous label when the reviewer has no display name", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 1, average: 5 } }, reviews: [{ ...reviews[0], reviewerName: null }], anonymousReviewer: "Độc giả" });
    expect((schema.review as { author: { name: string } }[])[0].author.name).toBe("Độc giả");
  });
  it("emits neither when there are no rendered reviews", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: { count: 3, average: 4 } }, reviews: [] });
    expect(schema).not.toHaveProperty("aggregateRating");
    expect(schema).not.toHaveProperty("review");
  });
  it("emits neither when reviews are passed without a summary", () => {
    const schema = bookSchema({ siteUrl, locale: "vi", path: "/vi/books/x", paymentsEnabled: true, book: { ...book, reviewSummary: null }, reviews });
    expect(schema).not.toHaveProperty("aggregateRating");
    expect(schema).not.toHaveProperty("review");
  });
});

describe("personSchema", () => {
  const entity: CatalogEntityPage = {
    kind: "author",
    id: "40000000-0000-4000-8000-000000000001",
    name: "Mai Tran",
    description: "Writes about the sea.",
    alternateSlugs: {},
    quote: null,
    image: null,
    books: [],
  };

  it("describes an author page as a Person", () => {
    expect(
      personSchema({ siteUrl, path: "/en/authors/mai-tran", entity }),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "Person",
      name: "Mai Tran",
      description: "Writes about the sea.",
      url: "https://books.example/en/authors/mai-tran",
    });
  });

  it("omits a missing description and the internal id", () => {
    const schema = personSchema({
      siteUrl,
      path: "/en/authors/mai-tran",
      entity: { ...entity, description: null },
    });
    expect(schema).not.toHaveProperty("description");
    expect(JSON.stringify(schema)).not.toContain(entity.id);
  });
});

describe("serializeJsonLd", () => {
  it("escapes < so catalog text cannot close the script element", () => {
    const serialized = serializeJsonLd({
      name: "</script><script>alert(1)</script>",
    });
    expect(serialized).not.toContain("<");
    expect(serialized).toContain("\\u003c/script>");
    expect(JSON.parse(serialized)).toEqual({
      name: "</script><script>alert(1)</script>",
    });
  });
});

function bundleMemberCard(slug: string, title: string): CatalogBookCard {
  return {
    bookId: `book-${slug}`,
    slug,
    title,
    subtitle: null,
    shortDescription: null,
    author: { name: "Mai Tran", slug: "mai-tran" },
    cover: null,
    offer: { priceMinor: 129000, currency: "VND", listPriceMinor: null, saleEndsAt: null },
    hasActivePublication: true,
    hasSample: false,
    series: null,
    topics: [],
    featured: false,
    shelfPosition: null,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

describe("bundleSchema", () => {
  const bundle: PublicBundleDTO = {
    bundleId: "40000000-0000-4000-8000-000000000001",
    slug: "starter-bundle",
    alternateSlugs: { vi: "goi-khoi-dau" },
    title: "Starter Bundle",
    subtitle: "Two books",
    description: "A set of two.",
    cover: { url: "https://cdn.example/bundle.png", alt: "Starter Bundle" },
    offer: { priceMinor: 199000, currency: "VND" },
    members: [
      bundleMemberCard("book-one", "Book One"),
      bundleMemberCard("book-two", "Book Two"),
    ],
  };

  function schema(
    overrides: Partial<PublicBundleDTO> = {},
    paymentsEnabled = true,
  ) {
    return bundleSchema({
      siteUrl: siteUrl,
      locale: "en",
      path: "/en/bundles/starter-bundle",
      bundle: { ...bundle, ...overrides },
      paymentsEnabled,
    });
  }

  it("describes the bundle as a Product with a nested Offer", () => {
    expect(schema()).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Starter Bundle",
      description: "A set of two.",
      image: "https://cdn.example/bundle.png",
      url: `${siteUrl}/en/bundles/starter-bundle`,
      offers: {
        "@type": "Offer",
        price: 199000,
        priceCurrency: "VND",
        availability: "https://schema.org/InStock",
        url: `${siteUrl}/en/bundles/starter-bundle`,
      },
    });
  });

  it("lists the visible member books as isRelatedTo Books", () => {
    expect(schema().isRelatedTo).toEqual([
      {
        "@type": "Book",
        name: "Book One",
        url: `${siteUrl}/en/books/book-one`,
      },
      {
        "@type": "Book",
        name: "Book Two",
        url: `${siteUrl}/en/books/book-two`,
      },
    ]);
  });

  // The schema states what an anonymous visitor could do now, exactly as bookSchema does: a bundle
  // nobody can buy yet is out of stock, and the site takes no preorders.
  it("is out of stock while payments are disabled", () => {
    expect(schema({}, false)).toMatchObject({
      offers: { availability: "https://schema.org/OutOfStock" },
    });
  });

  it("is out of stock with nothing left to show", () => {
    expect(schema({ members: [] })).toMatchObject({
      offers: { availability: "https://schema.org/OutOfStock" },
    });
  });

  it("omits the offer, the image and the description a bundle does not have", () => {
    const result = schema({ offer: null, cover: null, description: null });
    expect(result).not.toHaveProperty("offers");
    expect(result).not.toHaveProperty("image");
    expect(result).not.toHaveProperty("description");
  });

  // The reader's own ownership is not part of a cacheable, crawlable document. PublicBundleDTO no
  // longer carries an ownedMemberCount field at all - but a caller that still had a stale reference
  // to the old shape could smuggle one onto the object anyway (JS is structurally permissive at
  // runtime even where the type forbids it), so this pins that bundleSchema ignores it either way:
  // the internal resolveBookAction call is hardcoded to ownedMemberCount: 0, never read from input.
  it("does not change with a stray ownedMemberCount on the input, because availability is resolved with it fixed at 0", () => {
    const withStrayOwnership: Partial<PublicBundleDTO> & {
      ownedMemberCount?: number;
    } = {
      ownedMemberCount: bundle.members.length,
    };
    expect(schema(withStrayOwnership)).toEqual(schema());
  });
});

describe("knowledge structured data", () => {
  const relatedBook: CatalogBookCard = {
    ...book,
    bookId: "30000000-0000-4000-8000-0000000000bb",
    slug: "related-book",
    title: "RELATED-BOOK-MARKER",
  };
  const relatedIdea: KnowledgeIdeaSummary = {
    ideaId: "50000000-0000-4000-8000-0000000000cc",
    slug: "related-idea",
    question: "RELATED-IDEA-MARKER?",
    shortAnswer: "Related answer.",
    createdAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-01T00:00:00+00:00",
    alternateSlugs: {},
    topics: [],
  };
  const renderContext = {
    blocks: [
      { type: "paragraph" as const, content: [{ text: "BLOCK-TEXT-MARKER" }] },
    ],
    booksById: new Map([[relatedBook.bookId, relatedBook]]),
    ideasById: new Map([[relatedIdea.ideaId, relatedIdea]]),
    books: [relatedBook],
    topics: [{ slug: "habits", name: "TOPIC-MARKER" }],
  };

  const idea: KnowledgeIdeaPage = {
    ...renderContext,
    ideaId: "50000000-0000-4000-8000-000000000001",
    slug: "why-read-slowly",
    question: "Why read slowly?",
    shortAnswer: "Because understanding takes time.",
    seoTitle: "SEO-TITLE-MARKER",
    seoDescription: "SEO-DESCRIPTION-MARKER",
    createdAt: "2026-09-01T00:00:00+00:00",
    updatedAt: "2026-09-03T00:00:00+00:00",
    alternateSlugs: { vi: "vi-sao-doc-cham" },
    relatedIdeas: [relatedIdea],
  };

  const article: KnowledgeArticlePage = {
    ...renderContext,
    articleId: "60000000-0000-4000-8000-000000000001",
    slug: "autumn-reading",
    title: "Autumn reading",
    excerpt: "Five books for longer evenings.",
    seoTitle: "SEO-TITLE-MARKER",
    seoDescription: "SEO-DESCRIPTION-MARKER",
    publishedAt: "2026-09-20T03:00:00+00:00",
    updatedAt: "2026-09-21T03:00:00+00:00",
    alternateSlugs: { vi: "doc-mua-thu" },
    author: { name: "Mai Tran", slug: "mai-tran" },
    ideas: [relatedIdea],
  };

  const siteOrg = {
    "@type": "Organization",
    name: "Infinity Books Press",
    url: "https://books.example",
  };

  const leaks = (schema: unknown, ids: string[]) => {
    const json = JSON.stringify(schema);
    for (const marker of [
      ...ids,
      relatedBook.bookId,
      relatedIdea.ideaId,
      "SEO-TITLE-MARKER",
      "SEO-DESCRIPTION-MARKER",
      "BLOCK-TEXT-MARKER",
      "RELATED-BOOK-MARKER",
      "RELATED-IDEA-MARKER",
      "TOPIC-MARKER",
      "vi-sao-doc-cham",
      "doc-mua-thu",
    ]) {
      expect(json).not.toContain(marker);
    }
  };

  it("describes an idea as an Article headed by its question", () => {
    const schema = knowledgeArticleSchema({
      siteUrl,
      locale: "en",
      path: "/en/ideas/why-read-slowly",
      kind: "idea",
      page: idea,
    });
    expect(schema).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Why read slowly?",
      description: "Because understanding takes time.",
      url: "https://books.example/en/ideas/why-read-slowly",
      mainEntityOfPage: "https://books.example/en/ideas/why-read-slowly",
      inLanguage: "en",
      datePublished: "2026-09-01T00:00:00+00:00",
      dateModified: "2026-09-03T00:00:00+00:00",
      author: siteOrg,
      publisher: siteOrg,
    });
    leaks(schema, [idea.ideaId]);
  });

  it("describes an article with its author Person and both dates", () => {
    const schema = knowledgeArticleSchema({
      siteUrl,
      locale: "vi",
      path: "/vi/articles/autumn-reading",
      kind: "article",
      page: article,
    });
    expect(schema).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Autumn reading",
      description: "Five books for longer evenings.",
      url: "https://books.example/vi/articles/autumn-reading",
      mainEntityOfPage: "https://books.example/vi/articles/autumn-reading",
      inLanguage: "vi",
      datePublished: "2026-09-20T03:00:00+00:00",
      dateModified: "2026-09-21T03:00:00+00:00",
      author: {
        "@type": "Person",
        name: "Mai Tran",
        url: "https://books.example/vi/authors/mai-tran",
      },
      publisher: siteOrg,
    });
    leaks(schema, [article.articleId]);
  });

  it("names an author without a public page but links nowhere", () => {
    const schema = knowledgeArticleSchema({
      siteUrl,
      locale: "en",
      path: "/en/articles/autumn-reading",
      kind: "article",
      page: { ...article, author: { name: "Guest Writer", slug: null } },
    });
    expect(schema.author).toEqual({ "@type": "Person", name: "Guest Writer" });
  });

  it("builds a FAQPage that mirrors exactly the visible question and short answer", () => {
    expect(ideaFaqSchema(idea)).toEqual({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Why read slowly?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Because understanding takes time.",
          },
        },
      ],
    });
    leaks(ideaFaqSchema(idea), [idea.ideaId]);
  });

  it("builds no FAQPage when either visible string is blank", () => {
    expect(
      ideaFaqSchema({ question: "", shortAnswer: "An answer." }),
    ).toBeNull();
    expect(
      ideaFaqSchema({ question: "A question?", shortAnswer: "   " }),
    ).toBeNull();
  });
});
