import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { alternatePaths } from "@/lib/i18n/alternates";

import { BookGrid } from "@/components/catalog/book-card";
import { BlockRenderer } from "@/components/knowledge/BlockRenderer";
import {
  ideaLinkItems,
  KnowledgeLinkList,
} from "@/components/knowledge/knowledge-link-list";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import { getServerEnv } from "@/lib/config/server-env";
import { getArticlePage } from "@/lib/data/knowledge";
import { isLocale, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import { formatDate } from "@/lib/i18n/format";
import {
  getCatalogRoutes,
  getKnowledgeRoutes,
  getLocaleRoutes,
} from "@/lib/i18n/routes";
import { knowledgeStaticParams } from "@/lib/knowledge/static-params";
import { breadcrumbSchema, knowledgeArticleSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, localePaths, SITE_NAME } from "@/lib/seo/metadata";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
};

const sectionTitle = "mb-6 font-serif text-2xl font-normal";
const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink";

// Prerendered per published article, the same way book pages are. revalidateKnowledgeHub()
// invalidates the "/[lang]" layout on every knowledge mutation; otherwise this is
// stale-while-revalidate after 5 minutes. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({
  params,
}: {
  params: { lang: string };
}) {
  if (!isLocale(params.lang)) return [];
  const { articles } = await knowledgeStaticParams(params.lang);
  return articles.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const article = await getArticlePage(locale, slug);
  if (!article) return {};
  const alternates = alternatePaths(article.alternateSlugs, (l, s) => getKnowledgeRoutes(l).article(s));
  // This URL shows another locale's copy: it is that page's duplicate, not a translation.
  const copyFrom = article.metadataLocale !== locale && isLocale(article.metadataLocale) ? article.metadataLocale : undefined;
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    copyFrom,
    paths: copyFrom ? alternates : localePaths(locale, getKnowledgeRoutes(locale).article(article.slug), alternates),
    title: article.seoTitle ?? article.title,
    description: article.seoDescription ?? article.excerpt,
  });
}

// Compares the dates the reader sees (formatDate's zone), so the line never
// reads "Published Sep 2 · Updated Sep 2".
function isLaterDay(
  updated: string,
  published: string | null,
  locale: Locale,
): boolean {
  if (!published) return false;
  return (
    new Date(updated) > new Date(published) &&
    formatDate(updated, locale) !== formatDate(published, locale)
  );
}

export default async function ArticlePage({ params }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const article = await getArticlePage(locale, slug);
  if (!article) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.knowledge.article;
  const routes = getKnowledgeRoutes(locale);
  const catalogRoutes = getCatalogRoutes(locale);
  const articlePath = routes.article(article.slug);
  const siteUrl = getServerEnv().siteUrl;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={
          alternatePaths(article.alternateSlugs, (l, s) => getKnowledgeRoutes(l).article(s))
        }
        current="articles"
        locale={locale}
      />
      <JsonLd
        data={[
          knowledgeArticleSchema({
            siteUrl,
            locale,
            path: articlePath,
            kind: "article",
            page: article,
          }),
          breadcrumbSchema(siteUrl, [
            { name: SITE_NAME, path: getLocaleRoutes(locale).home },
            { name: dictionary.navigation.articles, path: routes.articles },
            { name: article.title, path: articlePath },
          ]),
        ]}
      />
      <main
        className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20"
        id="main-content"
      >
        <article className="max-w-[40rem]">
          <header className="mb-10 border-b border-hairline pb-10">
            <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">
              {copy.eyebrow}
            </p>
            <h1 className="font-serif text-4xl leading-[1.08] font-normal tracking-[-0.01em] sm:text-5xl">
              {article.title}
            </h1>
            {article.metadataLocale !== locale ? (
              <p className="mt-3 text-xs text-sage-text">
                {fillTemplate(dictionary.catalog.editions.metadataNote, { language: editionLanguageLabel(article.metadataLocale) ?? article.metadataLocale })}
              </p>
            ) : null}
            <p className="mt-4 text-[0.9375rem] text-ink-soft">
              {copy.by}{" "}
              {article.author.slug ? (
                <Link
                  className={textLink}
                  href={catalogRoutes.entity("author", article.author.slug)}
                >
                  {article.author.name}
                </Link>
              ) : (
                article.author.name
              )}
            </p>
            <p className="text-sm text-sage-text">
              {copy.published}{" "}
              <time dateTime={article.publishedAt}>
                {formatDate(article.publishedAt, locale)}
              </time>
              {isLaterDay(article.updatedAt, article.publishedAt, locale) ? (
                <span className="ml-3">
                  {copy.updated}{" "}
                  <time dateTime={article.updatedAt}>
                    {formatDate(article.updatedAt, locale)}
                  </time>
                </span>
              ) : null}
            </p>
            <p className="mt-6 font-serif text-xl leading-normal">
              {article.excerpt}
            </p>
          </header>
          <BlockRenderer
            blocks={article.blocks}
            bookCopy={dictionary.catalog.book}
            booksById={article.booksById}
            ideasById={article.ideasById}
            locale={locale}
          />
        </article>

        {article.books.length > 0 ? (
          <section aria-labelledby="article-books" className="mt-16">
            <h2 className={sectionTitle} id="article-books">
              {copy.relatedBooks}
            </h2>
            <BookGrid
              books={article.books}
              copy={dictionary.catalog.book}
              locale={locale}
            />
          </section>
        ) : null}

        {article.ideas.length > 0 ? (
          <section
            aria-labelledby="article-ideas"
            className="mt-16 max-w-[40rem]"
          >
            <h2 className={sectionTitle} id="article-ideas">
              {copy.relatedIdeas}
            </h2>
            <KnowledgeLinkList
              items={ideaLinkItems(article.ideas)}
              locale={locale}
            />
          </section>
        ) : null}

        {article.topics.length > 0 ? (
          <section
            aria-labelledby="article-topics"
            className="mt-16 max-w-[40rem]"
          >
            <h2 className={sectionTitle} id="article-topics">
              {copy.topics}
            </h2>
            <ul className="flex flex-wrap gap-x-5">
              {article.topics.map((topic) => (
                <li key={topic.slug}>
                  <Link
                    className={textLink}
                    href={catalogRoutes.entity("topic", topic.slug)}
                  >
                    {topic.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
