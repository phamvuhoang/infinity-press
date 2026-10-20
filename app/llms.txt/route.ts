import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { formatPrice, saleLastDay } from "@/lib/catalog/price";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getArticleIndex, getPublishedIdeas } from "@/lib/data/knowledge";
import { locales, type Locale, defaultLocale } from "@/lib/i18n/config";
import { getDictionary, type Dictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getKnowledgeRoutes } from "@/lib/i18n/routes";
import { buildLlmsText, type LlmsEntry, type LlmsLocaleSection } from "@/lib/seo/llms";
import { SITE_NAME } from "@/lib/seo/metadata";

// Optional LLM index (PRD 5.1, S14 spec 8). The same published-only reads as app/sitemap.ts
// (getBookCards behind catalogStaticParams, getPublishedIdeas and getArticleIndex behind
// getKnowledgeSitemapEntries), so this list and the sitemap cannot disagree about which books,
// authors, series, topics, ideas, and articles exist. revalidateStorefront() also invalidates it;
// otherwise it is stale-while-revalidate like the sitemap. A failed read rejects the response
// rather than serving a partial index.
export const revalidate = 300;

// The price the book page shows (S19 spec 7.2): the price paid now, then the list price and the
// last day while a sale runs. A book with no offer has no price.
function bookPrice(offer: CatalogBookCard["offer"], locale: Locale, dictionary: Dictionary): string | null {
  if (!offer) return null;
  if (offer.priceMinor === 0) return dictionary.catalog.book.free;
  const price = formatPrice(offer.priceMinor, offer.currency, locale);
  if (offer.listPriceMinor === null) return price;
  const sale = [fillTemplate(dictionary.llms.listPrice, { price: formatPrice(offer.listPriceMinor, offer.currency, locale) })];
  if (offer.saleEndsAt) sale.push(fillTemplate(dictionary.llms.saleUntil, { date: saleLastDay(offer.saleEndsAt) }));
  return `${price}, ${sale.join(", ")}`;
}

const unique = (entries: LlmsEntry[]) => [...new Map(entries.map((entry) => [entry.path, entry])).values()];

export async function GET(): Promise<Response> {
  await deferPrerenderWithoutServerEnv();
  const { siteUrl } = getServerEnv();
  const sections: LlmsLocaleSection[] = [];

  // The default locale leads: its section is the document title, the others nest below it.
  for (const locale of [defaultLocale, ...locales.filter((candidate) => candidate !== defaultLocale)]) {
    const [cards, ideas, articles, dictionary] = await Promise.all([
      getBookCards(locale),
      getPublishedIdeas(locale),
      getArticleIndex(locale),
      getDictionary(locale),
    ]);
    const catalog = getCatalogRoutes(locale);
    const hub = getKnowledgeRoutes(locale);

    sections.push({
      locale,
      heading: locale === defaultLocale ? SITE_NAME : dictionary.llms.heading,
      intro: dictionary.llms.intro,
      groups: [
        { heading: dictionary.navigation.books, entries: cards.map((card) => ({ title: card.title, path: catalog.book(card.slug), description: card.shortDescription, price: bookPrice(card.offer, locale, dictionary) })) },
        // An entity is listed only when it has a page in this locale (a null author slug has none).
        { heading: dictionary.llms.authors, entries: unique(cards.flatMap((card) => (card.author.slug ? [{ title: card.author.name, path: catalog.entity("author", card.author.slug), description: null }] : []))) },
        { heading: dictionary.llms.series, entries: unique(cards.flatMap((card) => (card.series ? [{ title: card.series.name, path: catalog.entity("series", card.series.slug), description: null }] : []))) },
        { heading: dictionary.llms.topics, entries: unique(cards.flatMap((card) => card.topics.map((topic) => ({ title: topic.name, path: catalog.entity("topic", topic.slug), description: null })))) },
        { heading: dictionary.navigation.ideas, entries: ideas.map((idea) => ({ title: idea.question, path: hub.idea(idea.slug), description: idea.shortAnswer })) },
        { heading: dictionary.navigation.articles, entries: articles.map((article) => ({ title: article.title, path: hub.article(article.slug), description: article.excerpt })) },
      ],
    });
  }

  return new Response(buildLlmsText({ siteUrl, sections }), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
