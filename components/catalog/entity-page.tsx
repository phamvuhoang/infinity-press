import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { alternatePaths } from "@/lib/i18n/alternates";

import { BookGrid } from "@/components/catalog/book-card";
import { RecommendationShelf } from "@/components/catalog/recommendation-shelf";
import { KnowledgeLinkList } from "@/components/knowledge/knowledge-link-list";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import type { CatalogEntityKind } from "@/lib/catalog/public-types";
import { getServerEnv } from "@/lib/config/server-env";
import { isLoopbackUrl } from "@/lib/config/url";
import { getEntityPage } from "@/lib/data/catalog";
import { getKnowledgeForTopic } from "@/lib/data/knowledge";
import { getShelfRecommendations } from "@/lib/data/recommendations";
import { isLocale } from "@/lib/i18n/config";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { breadcrumbSchema, personSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, localePaths, SITE_NAME } from "@/lib/seo/metadata";

type EntityParams = Promise<{ lang: string; slug: string }>;

export async function entityMetadata(kind: CatalogEntityKind, params: EntityParams): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const entity = await getEntityPage(kind, locale, slug);
  if (!entity) return {};
  const alternates = alternatePaths(entity.alternateSlugs, (l, s) => getCatalogRoutes(l).entity(kind, s));
  // This URL shows another locale's copy: it is that page's duplicate, not a translation.
  const copyFrom = entity.metadataLocale !== locale && isLocale(entity.metadataLocale) ? entity.metadataLocale : undefined;
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    copyFrom,
    paths: copyFrom ? alternates : localePaths(locale, getCatalogRoutes(locale).entity(kind, slug), alternates),
    title: entity.name,
    description: entity.description ?? undefined,
  });
}

// Authors, series, and topics share one layout: boards 1u, 1v, and 1s.
export async function EntityPage({ kind, params }: { kind: CatalogEntityKind; params: EntityParams }) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const entity = await getEntityPage(kind, locale, slug);
  if (!entity) notFound();

  // Author and topic pages seed recommendations from every book already visible on the page; the
  // RPC excludes those seeds itself, so this call passes no exclude list. Series pages keep their
  // current behavior and never call the recommendation DAL. Only topic pages list the ideas and
  // articles that link to them; author and series pages never request knowledge backlinks.
  const seedBookIds = entity.books.map((book) => book.bookId);
  const [dictionary, recommendations, knowledgeLinks] = await Promise.all([
    getDictionary(locale),
    kind === "author" || kind === "topic"
      ? getShelfRecommendations({ seedBookIds, excludeBookIds: [], locale, limit: 6 })
      : Promise.resolve([]),
    kind === "topic" ? getKnowledgeForTopic(locale, entity.id) : Promise.resolve([]),
  ]);
  const copy = dictionary.catalog;
  const siteUrl = getServerEnv().siteUrl;
  const path = getCatalogRoutes(locale).entity(kind, slug);
  const breadcrumbs = breadcrumbSchema(siteUrl, [
    { name: SITE_NAME, path: getLocaleRoutes(locale).home },
    { name: dictionary.navigation.books, path: getLocaleRoutes(locale).books },
    { name: entity.name, path },
  ]);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={alternatePaths(entity.alternateSlugs, (l, s) => getCatalogRoutes(l).entity(kind, s))}
        locale={locale}
      />
      <JsonLd data={kind === "author" ? [personSchema({ siteUrl, path, entity }), breadcrumbs] : breadcrumbs} />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20" id="main-content">
        {/* An author with a portrait gets the board 1e split: image left, copy right. Series and
            topics, and authors without one, keep the single reading column. */}
        <header
          className={
            entity.image
              ? "mb-14 grid gap-10 lg:grid-cols-[minmax(0,24rem)_minmax(0,40rem)] lg:gap-16"
              : "mb-14 max-w-[40rem]"
          }
        >
          {entity.image ? (
            <Image
              alt={entity.image.alt}
              className="aspect-[4/5] w-full object-cover"
              height={600}
              preload
              sizes="(min-width: 1024px) 24rem, 100vw"
              src={entity.image.url}
              unoptimized={isLoopbackUrl(entity.image.url)}
              width={480}
            />
          ) : null}
          <div className="min-w-0">
            <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.entity[kind]}</p>
            <h1 className="font-serif text-4xl leading-[1.08] font-normal sm:text-5xl">{entity.name}</h1>
            {entity.metadataLocale !== locale ? (
              <p className="mt-3 text-xs text-sage-text">
                {fillTemplate(copy.editions.metadataNote, { language: editionLanguageLabel(entity.metadataLocale) ?? entity.metadataLocale })}
              </p>
            ) : null}
            {entity.quote ? (
              <blockquote className="mt-6 font-serif text-xl leading-relaxed text-ink sm:text-2xl">
                &ldquo;{entity.quote}&rdquo;
              </blockquote>
            ) : null}
            {entity.description ? (
              <p className="mt-6 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{entity.description}</p>
            ) : null}
          </div>
        </header>
        <section aria-labelledby="entity-books">
          <h2 className="mb-8 font-serif text-2xl font-normal" id="entity-books">
            {copy.entity.booksTitle}
          </h2>
          <BookGrid books={entity.books} copy={copy.book} locale={locale} />
        </section>
        {/* Kept apart from the recommendation shelf below: these are editorial links, not books. */}
        {knowledgeLinks.length > 0 ? (
          <section aria-labelledby="entity-knowledge" className="mt-14 max-w-[40rem]">
            <h2 className="mb-8 font-serif text-2xl font-normal" id="entity-knowledge">
              {copy.entity.knowledgeTitle}
            </h2>
            <KnowledgeLinkList
              items={knowledgeLinks}
              kindLabels={{ idea: dictionary.knowledge.idea.eyebrow, article: dictionary.knowledge.article.eyebrow }}
              locale={locale}
            />
          </section>
        ) : null}
        <RecommendationShelf
          books={recommendations}
          copy={copy.book}
          heading={copy.entity.recommendationsTitle}
          headingId="entity-recommendations"
          locale={locale}
        />
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
