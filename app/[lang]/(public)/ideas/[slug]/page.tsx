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
import { getIdeaPage } from "@/lib/data/knowledge";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import {
  getCatalogRoutes,
  getKnowledgeRoutes,
  getLocaleRoutes,
} from "@/lib/i18n/routes";
import { knowledgeStaticParams } from "@/lib/knowledge/static-params";
import {
  breadcrumbSchema,
  ideaFaqSchema,
  knowledgeArticleSchema,
} from "@/lib/seo/json-ld";
import { buildPageMetadata, localePaths, SITE_NAME } from "@/lib/seo/metadata";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
};

const sectionTitle = "mb-6 font-serif text-2xl font-normal";
const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink";

// Prerendered per published idea, the same way book pages are. revalidateKnowledgeHub() invalidates
// the "/[lang]" layout on every knowledge mutation; otherwise this is stale-while-revalidate after 5
// minutes. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({
  params,
}: {
  params: { lang: string };
}) {
  if (!isLocale(params.lang)) return [];
  const { ideas } = await knowledgeStaticParams(params.lang);
  return ideas.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const idea = await getIdeaPage(locale, slug);
  if (!idea) return {};
  const alternates = alternatePaths(idea.alternateSlugs, (l, s) => getKnowledgeRoutes(l).idea(s));
  // This URL shows another locale's copy: it is that page's duplicate, not a translation.
  const copyFrom = idea.metadataLocale !== locale && isLocale(idea.metadataLocale) ? idea.metadataLocale : undefined;
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    copyFrom,
    paths: copyFrom ? alternates : localePaths(locale, getKnowledgeRoutes(locale).idea(idea.slug), alternates),
    title: idea.seoTitle ?? idea.question,
    description: idea.seoDescription ?? idea.shortAnswer,
  });
}

export default async function IdeaPage({ params }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const idea = await getIdeaPage(locale, slug);
  if (!idea) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.knowledge.idea;
  const routes = getKnowledgeRoutes(locale);
  const catalogRoutes = getCatalogRoutes(locale);
  const ideaPath = routes.idea(idea.slug);
  const siteUrl = getServerEnv().siteUrl;
  const faq = ideaFaqSchema(idea);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={
          alternatePaths(idea.alternateSlugs, (l, s) => getKnowledgeRoutes(l).idea(s))
        }
        current="ideas"
        locale={locale}
      />
      <JsonLd
        data={[
          knowledgeArticleSchema({
            siteUrl,
            locale,
            path: ideaPath,
            kind: "idea",
            page: idea,
          }),
          breadcrumbSchema(siteUrl, [
            { name: SITE_NAME, path: getLocaleRoutes(locale).home },
            { name: dictionary.navigation.ideas, path: routes.ideas },
            { name: idea.question, path: ideaPath },
          ]),
          // Mirrors the hero below; null (and left out) only if there were no visible Q&A to match.
          ...(faq ? [faq] : []),
        ]}
      />
      <main
        className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20"
        id="main-content"
      >
        <article className="max-w-[40rem]">
          {/* The visible question and short answer are what the FAQ structured data mirrors, so they
              always open the page. */}
          <header className="mb-10 border-b border-hairline pb-10">
            <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">
              {copy.eyebrow}
            </p>
            <h1 className="font-serif text-4xl leading-[1.08] font-normal tracking-[-0.01em] sm:text-5xl">
              {idea.question}
            </h1>
            {idea.metadataLocale !== locale ? (
              <p className="mt-3 text-xs text-sage-text">
                {fillTemplate(dictionary.catalog.editions.metadataNote, { language: editionLanguageLabel(idea.metadataLocale) ?? idea.metadataLocale })}
              </p>
            ) : null}
            <p className="mt-6 mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">
              {copy.shortAnswer}
            </p>
            <p className="font-serif text-xl leading-normal">
              {idea.shortAnswer}
            </p>
          </header>
          {/* A plain link: the ask page is dynamic, so this page stays prerendered. */}
          <p className="mb-10">
            <Link
              className={textLink}
              href={catalogRoutes.ask({ idea: idea.ideaId })}
            >
              {copy.ask}
            </Link>
          </p>
          <BlockRenderer
            blocks={idea.blocks}
            bookCopy={dictionary.catalog.book}
            booksById={idea.booksById}
            ideasById={idea.ideasById}
            locale={locale}
          />
        </article>

        {idea.books.length > 0 ? (
          <section aria-labelledby="idea-books" className="mt-16">
            <h2 className={sectionTitle} id="idea-books">
              {copy.relatedBooks}
            </h2>
            <BookGrid
              books={idea.books}
              copy={dictionary.catalog.book}
              locale={locale}
            />
          </section>
        ) : null}

        {idea.relatedIdeas.length > 0 ? (
          <section
            aria-labelledby="idea-related"
            className="mt-16 max-w-[40rem]"
          >
            <h2 className={sectionTitle} id="idea-related">
              {copy.relatedIdeas}
            </h2>
            <KnowledgeLinkList
              items={ideaLinkItems(idea.relatedIdeas)}
              locale={locale}
            />
          </section>
        ) : null}

        {idea.topics.length > 0 ? (
          <section
            aria-labelledby="idea-topics"
            className="mt-16 max-w-[40rem]"
          >
            <h2 className={sectionTitle} id="idea-topics">
              {copy.topics}
            </h2>
            <ul className="flex flex-wrap gap-x-5">
              {idea.topics.map((topic) => (
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
