import { resolveBookAction } from "@/lib/catalog/book-action";
import { priceInMajorUnits, saleLastDay } from "@/lib/catalog/price";
import { retailerLabel, withRetailUtm } from "@/lib/catalog/retail";
import type {
  CatalogBookPage,
  CatalogEntityPage,
  CatalogRetailLink,
} from "@/lib/catalog/public-types";
import type { PublicBundleDTO } from "@/lib/data/public-bundles";
import type { PublicReview } from "@/lib/data/reviews";
import type { Locale } from "@/lib/i18n/config";
import type {
  KnowledgeArticlePage,
  KnowledgeIdeaPage,
} from "@/lib/knowledge/public-types";
import { getCatalogRoutes } from "@/lib/i18n/routes";
import { absoluteUrl, SITE_NAME } from "@/lib/seo/metadata";

// Structured data (S5 spec 7.3). Builders return plain serializable objects from public DTOs and
// never query the database. Each field is one the page itself displays; SEO copy, internal IDs,
// and alternate slugs stay out.

const context = "https://schema.org";

type JsonLdObject = { "@context": typeof context; "@type": string } & Record<
  string,
  unknown
>;

export function organizationSchema(siteUrl: string): JsonLdObject {
  return {
    "@context": context,
    "@type": "Organization",
    name: SITE_NAME,
    url: new URL(siteUrl).origin,
  };
}

// The site as a nested node (seller, publisher, idea author): the Organization without @context.
function siteOrganization(siteUrl: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { "@context": _context, ...organization } = organizationSchema(siteUrl);
  return organization;
}

export function breadcrumbSchema(
  siteUrl: string,
  items: { name: string; path: string }[],
): JsonLdObject {
  return {
    "@context": context,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(siteUrl, item.path),
    })),
  };
}

export function bookSchema({
  siteUrl,
  locale,
  path,
  book,
  paymentsEnabled,
  reviews = [],
  anonymousReviewer = "Reader",
}: {
  siteUrl: string;
  locale: Locale;
  path: string;
  book: CatalogBookPage;
  paymentsEnabled: boolean;
  // The reviews the page renders. Rating markup is emitted only alongside them, never as a bare
  // aggregate, so crawlers see exactly what visitors see.
  reviews?: PublicReview[];
  anonymousReviewer?: string;
}): JsonLdObject {
  const url = absoluteUrl(siteUrl, path);
  const description = book.shortDescription ?? book.description;
  // The ebook offer (when the page shows a price) then one paperback offer per retail link the
  // page's buttons show, with the same UTM-decorated URL.
  const offers = [
    ...(book.offer ? [offerSchema(book, paymentsEnabled, url, siteUrl)] : []),
    ...book.retailLinks.map((link) => paperbackOfferSchema(book, link, locale)),
  ];

  return {
    "@context": context,
    "@type": "Book",
    name: book.title,
    ...(book.subtitle ? { alternativeHeadline: book.subtitle } : {}),
    ...(description ? { description } : {}),
    url,
    inLanguage: locale,
    bookFormat: "https://schema.org/EBook",
    // The edition ISBN describes this ebook, so it sits on the Book node, not on any Offer.
    ...(book.isbn ? { isbn: book.isbn } : {}),
    ...(book.cover ? { image: book.cover.url } : {}),
    author: {
      "@type": "Person",
      name: book.author.name,
      ...(book.author.slug
        ? {
            url: absoluteUrl(
              siteUrl,
              getCatalogRoutes(locale).entity("author", book.author.slug),
            ),
          }
        : {}),
    },
    ...(offers.length > 0 ? { offers } : {}),
    ...(book.reviewSummary && reviews.length > 0
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: book.reviewSummary.average,
            reviewCount: book.reviewSummary.count,
            bestRating: 5,
            worstRating: 1,
          },
          review: reviews.map((review) => ({
            "@type": "Review",
            author: {
              "@type": "Person",
              name: review.reviewerName ?? anonymousReviewer,
            },
            reviewRating: {
              "@type": "Rating",
              ratingValue: review.rating,
              bestRating: 5,
              worstRating: 1,
            },
            reviewBody: review.body,
            datePublished: review.publishedAt,
          })),
        }
      : {}),
  };
}

const RETAILER_NAMES = { shopee: "Shopee", fahasa: "Fahasa", tiki: "Tiki" } as const;

function paperbackOfferSchema(
  book: CatalogBookPage,
  link: CatalogRetailLink,
  locale: Locale,
) {
  return {
    "@type": "Offer",
    url: withRetailUtm(link.url, locale),
    availability: "https://schema.org/InStock",
    ...(link.priceMinor !== null && link.currency !== null
      ? {
          price: priceInMajorUnits(link.priceMinor, link.currency),
          priceCurrency: link.currency,
        }
      : {}),
    seller: { "@type": "Organization", name: retailerLabel(link, RETAILER_NAMES) },
    // No isbn here: the edition's ISBN is the ebook's (the edition owns the SKU, the offer, and the
    // EPUB), and a paperback carries a different one that the catalog does not record.
    itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback" },
  };
}

function offerSchema(
  book: CatalogBookPage,
  paymentsEnabled: boolean,
  url: string,
  siteUrl: string,
) {
  const offer = book.offer!;
  // What an anonymous visitor could do now. A paid book while payments are disabled is "coming
  // soon"; the site takes no preorders, so that and an unavailable book are out of stock.
  const action = resolveBookAction({
    hasActiveEntitlement: false,
    offer: { priceMinor: offer.priceMinor, active: true },
    hasActivePublication: book.hasActivePublication,
    paymentsEnabled,
  });
  const inStock = action === "get_free" || action === "buy";
  const price = priceInMajorUnits(offer.priceMinor, offer.currency);
  return {
    "@type": "Offer",
    price,
    priceCurrency: offer.currency,
    // A running sale (S19 spec 7.1): the struck-through list price is a StrikethroughPrice, and a
    // sale with an end is valid through the last UTC day it applies (an end at 00:00 is the day before).
    ...(offer.listPriceMinor !== null
      ? {
          ...(offer.saleEndsAt
            ? { priceValidUntil: saleLastDay(offer.saleEndsAt) }
            : {}),
          priceSpecification: [
            { "@type": "UnitPriceSpecification", price, priceCurrency: offer.currency },
            {
              "@type": "UnitPriceSpecification",
              priceType: "https://schema.org/StrikethroughPrice",
              price: priceInMajorUnits(offer.listPriceMinor, offer.currency),
              priceCurrency: offer.currency,
            },
          ],
        }
      : {}),
    availability: inStock
      ? "https://schema.org/InStock"
      : "https://schema.org/OutOfStock",
    url,
    seller: siteOrganization(siteUrl),
    itemOffered: { "@type": "Book", bookFormat: "https://schema.org/EBook" },
  };
}

export function personSchema({
  siteUrl,
  path,
  entity,
}: {
  siteUrl: string;
  path: string;
  entity: CatalogEntityPage;
}): JsonLdObject {
  return {
    "@context": context,
    "@type": "Person",
    name: entity.name,
    ...(entity.description ? { description: entity.description } : {}),
    url: absoluteUrl(siteUrl, path),
  };
}

// An idea or an article page (S12 spec 7), both as Article. An idea is headed by its question and
// described by its short answer, the hero it always opens with; it shows no date, but dateModified
// is the localization's last edit and datePublished its creation. An idea is authored and published
// by the site. An article carries the byline and dates its header shows. Only
// the page's own visible copy is used: SEO overrides, ids, blocks, and relations stay out.
export function knowledgeArticleSchema({
  siteUrl,
  locale,
  path,
  ...entry
}: { siteUrl: string; locale: Locale; path: string } & (
  | { kind: "idea"; page: KnowledgeIdeaPage }
  | { kind: "article"; page: KnowledgeArticlePage }
)): JsonLdObject {
  const url = absoluteUrl(siteUrl, path);
  const common: JsonLdObject = {
    "@context": context,
    "@type": "Article",
    url,
    mainEntityOfPage: url,
    inLanguage: locale,
  };

  if (entry.kind === "idea") {
    const { page } = entry;
    return {
      ...common,
      headline: page.question,
      description: page.shortAnswer,
      datePublished: page.createdAt,
      dateModified: page.updatedAt,
      author: siteOrganization(siteUrl),
      publisher: siteOrganization(siteUrl),
    };
  }

  const { page } = entry;
  return {
    ...common,
    headline: page.title,
    description: page.excerpt,
    datePublished: page.publishedAt,
    dateModified: page.updatedAt,
    author: {
      "@type": "Person",
      name: page.author.name,
      ...(page.author.slug
        ? {
            url: absoluteUrl(
              siteUrl,
              getCatalogRoutes(locale).entity("author", page.author.slug),
            ),
          }
        : {}),
    },
    publisher: siteOrganization(siteUrl),
  };
}

// One Question for the question and short answer an idea page always shows above its body. It is
// never inferred from blocks. Null when either string is blank, because then there is no visible
// question-and-answer for the markup to match.
export function ideaFaqSchema(
  idea: Pick<KnowledgeIdeaPage, "question" | "shortAnswer">,
): JsonLdObject | null {
  if (!idea.question.trim() || !idea.shortAnswer.trim()) return null;
  return {
    "@context": context,
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: idea.question,
        acceptedAnswer: { "@type": "Answer", text: idea.shortAnswer },
      },
    ],
  };
}

// JSON.stringify leaves `<` alone, so catalog text such as "</script>" could end the element that
// holds it. < is the same character to a JSON parser and inert to the HTML parser.
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// A bundle (S9 spec 6.3). Product rather than Book: what is sold is a set at one price, and the
// member books are named through isRelatedTo so a crawler can follow each to its own Book page,
// which carries that book's own schema.
export function bundleSchema({
  siteUrl,
  locale,
  path,
  bundle,
  paymentsEnabled,
}: {
  siteUrl: string;
  locale: Locale;
  path: string;
  bundle: PublicBundleDTO;
  paymentsEnabled: boolean;
}): JsonLdObject {
  const url = absoluteUrl(siteUrl, path);
  const routes = getCatalogRoutes(locale);

  return {
    "@context": context,
    "@type": "Product",
    name: bundle.title,
    ...(bundle.subtitle ? { alternateName: bundle.subtitle } : {}),
    ...(bundle.description ? { description: bundle.description } : {}),
    url,
    inLanguage: locale,
    ...(bundle.cover ? { image: bundle.cover.url } : {}),
    isRelatedTo: bundle.members.map((member) => ({
      "@type": "Book",
      name: member.title,
      url: absoluteUrl(siteUrl, routes.book(member.slug)),
    })),
    ...(bundle.offer
      ? { offers: bundleOfferSchema(bundle, paymentsEnabled, url) }
      : {}),
  };
}

function bundleOfferSchema(
  bundle: PublicBundleDTO,
  paymentsEnabled: boolean,
  url: string,
) {
  const offer = bundle.offer!;
  // What an anonymous visitor could do now, so ownedMemberCount is deliberately 0 rather than this
  // reader's count: a crawlable document must not vary with who fetched it.
  const action = resolveBookAction({
    kind: "bundle",
    publishedMemberCount: bundle.members.length,
    ownedMemberCount: 0,
    offer: { priceMinor: offer.priceMinor, active: true },
    paymentsEnabled,
  });
  return {
    "@type": "Offer",
    price: priceInMajorUnits(offer.priceMinor, offer.currency),
    priceCurrency: offer.currency,
    availability:
      action === "buy"
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    url,
  };
}
