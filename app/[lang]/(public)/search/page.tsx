import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookGrid } from "@/components/catalog/book-card";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SearchHit } from "@/lib/catalog/search";
import { normalizeSearchQuery } from "@/lib/catalog/search";
import { getServerEnv } from "@/lib/config/server-env";
import { searchCatalog } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";
import {
  getCatalogRoutes,
  getKnowledgeRoutes,
  getLocaleRoutes,
  otherLocale,
} from "@/lib/i18n/routes";
import { buildPageMetadata } from "@/lib/seo/metadata";

type Props = {
  params: Promise<{ lang: string }>;
  searchParams: Promise<{ q?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale } = await params;
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).catalog.search;
  // The canonical is the query-free route: a search result is never a page of its own.
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: {
      vi: getLocaleRoutes("vi").search,
      en: getLocaleRoutes("en").search,
    },
    title: copy.title,
    description: copy.description,
    index: "noindex-follow",
  });
}

export default async function SearchPage({ params, searchParams }: Props) {
  const [{ lang: locale }, { q }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const query = normalizeSearchQuery(q);
  const [dictionary, results] = await Promise.all([
    getDictionary(locale),
    query ? searchCatalog(locale, query) : null,
  ]);
  const copy = dictionary.catalog;
  const catalogRoutes = getCatalogRoutes(locale);
  const rawQuery = (Array.isArray(q) ? q[0] : q) ?? "";
  const other = otherLocale(locale);
  const otherSearch = query
    ? `${getLocaleRoutes(other).search}?${new URLSearchParams({ q: query })}`
    : getLocaleRoutes(other).search;

  const knowledgeRoutes = getKnowledgeRoutes(locale);
  // Display order after books (S12 spec 8): authors, ideas, articles, series, topics. Each hit links
  // with the name the search matched; knowledge hits have their own path segments.
  const groups: {
    id: string;
    title: string;
    hits: SearchHit[];
    href: (slug: string) => string;
  }[] = results
    ? [
        {
          id: "author",
          title: copy.search.authors,
          hits: results.authors,
          href: (slug) => catalogRoutes.entity("author", slug),
        },
        {
          id: "idea",
          title: copy.search.ideas,
          hits: results.ideas,
          href: knowledgeRoutes.idea,
        },
        {
          id: "article",
          title: copy.search.articles,
          hits: results.articles,
          href: knowledgeRoutes.article,
        },
        {
          id: "series",
          title: copy.search.series,
          hits: results.series,
          href: (slug) => catalogRoutes.entity("series", slug),
        },
        {
          id: "topic",
          title: copy.search.topics,
          hits: results.topics,
          href: (slug) => catalogRoutes.entity("topic", slug),
        },
      ]
    : [];
  const total = results
    ? results.books.length +
      groups.reduce((sum, group) => sum + group.hits.length, 0)
    : 0;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={{ [other]: otherSearch }}
        current="search"
        locale={locale}
      />
      <main
        className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-16"
        id="main-content"
      >
        <h1 className="mb-8 font-serif text-4xl font-normal sm:text-5xl">
          {copy.search.title}
        </h1>

        <form
          action={getLocaleRoutes(locale).search}
          className="mb-12 flex max-w-[40rem] flex-wrap items-end gap-3"
          method="get"
          role="search"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="search-q">{copy.search.label}</Label>
            <Input
              defaultValue={rawQuery}
              id="search-q"
              maxLength={100}
              name="q"
              placeholder={copy.search.placeholder}
              type="search"
            />
          </div>
          <Button type="submit">{copy.search.submit}</Button>
        </form>

        {!query ? (
          <div>
            <p className="font-serif text-2xl">{copy.search.promptTitle}</p>
            <p className="mt-2 text-sm text-ink-soft">
              {copy.search.promptHint}
            </p>
          </div>
        ) : total === 0 ? (
          <div>
            <p className="font-serif text-2xl">
              {fillTemplate(copy.search.emptyTitle, { query })}
            </p>
            <p className="mt-2 text-sm text-ink-soft">
              {copy.search.emptyHint}
            </p>
          </div>
        ) : (
          <div className="space-y-14">
            <p aria-live="polite" className="text-sm text-sage-text">
              {fillTemplate(copy.search.resultsFor, { query })}
            </p>
            {results && results.books.length > 0 ? (
              <section aria-labelledby="search-books">
                <h2
                  className="mb-6 font-serif text-2xl font-normal"
                  id="search-books"
                >
                  {copy.search.books}
                </h2>
                <BookGrid
                  books={results.books}
                  copy={copy.book}
                  locale={locale}
                />
              </section>
            ) : null}
            {groups
              .filter((group) => group.hits.length > 0)
              .map((group) => (
                <section aria-labelledby={`search-${group.id}`} key={group.id}>
                  <h2
                    className="mb-4 font-serif text-2xl font-normal"
                    id={`search-${group.id}`}
                  >
                    {group.title}
                  </h2>
                  <ul className="flex flex-wrap gap-x-6">
                    {group.hits.map((hit) => (
                      <li key={hit.slug}>
                        <Link
                          className="inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 hover:text-ink"
                          href={group.href(hit.slug)}
                        >
                          {hit.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
          </div>
        )}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
