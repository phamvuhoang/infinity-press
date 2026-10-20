import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookGrid } from "@/components/catalog/book-card";
import { CatalogFilterForm } from "@/components/catalog/catalog-filter-form";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import {
  type CatalogSearchParams,
  catalogFilterOptions,
  filterAndSortBooks,
  hasActiveFilters,
  parseCatalogFilters,
} from "@/lib/catalog/browse";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillCountTemplate } from "@/lib/i18n/format";
import { getLocaleRoutes } from "@/lib/i18n/routes";
import { breadcrumbSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, fixedPaths, SITE_NAME } from "@/lib/seo/metadata";

type Props = { params: Promise<{ lang: string }>; searchParams: Promise<CatalogSearchParams> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ lang: locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).catalog.books;
  // Every filtered or sorted view points its canonical at the unfiltered list and stays out of the
  // index; the list itself is the page search engines should keep.
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: fixedPaths((l) => getLocaleRoutes(l).books),
    title: copy.title,
    description: copy.description,
    index: hasActiveFilters(parseCatalogFilters(query)) ? "noindex-follow" : "index",
  });
}

export default async function BooksPage({ params, searchParams }: Props) {
  const [{ lang: locale }, query] = await Promise.all([params, searchParams]);
  if (!isLocale(locale)) notFound();

  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const copy = dictionary.catalog;
  const routes = getLocaleRoutes(locale);
  // Filter slugs are locale-specific, so the language switcher opens the other list unfiltered.
  const filters = parseCatalogFilters(query);
  const books = filterAndSortBooks(cards, filters, locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader alternates={fixedPaths((l) => getLocaleRoutes(l).books)} current="books" locale={locale} />
      <JsonLd
        data={breadcrumbSchema(getServerEnv().siteUrl, [
          { name: SITE_NAME, path: routes.home },
          { name: dictionary.navigation.books, path: routes.books },
        ])}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-16" id="main-content">
        <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.books.eyebrow}</p>
        <h1 className="mb-4 font-serif text-4xl font-normal sm:text-5xl">{copy.books.title}</h1>
        <p className="mb-10 max-w-[35rem] text-[0.9375rem] text-ink-soft">{copy.books.description}</p>

        <CatalogFilterForm
          action={routes.books}
          clearHref={routes.books}
          copy={copy.books}
          filters={filters}
          options={catalogFilterOptions(cards, locale)}
        />

        <p aria-live="polite" className="mt-10 mb-6 text-sm text-sage-text">
          {fillCountTemplate(locale, books.length, { one: copy.books.countOne, other: copy.books.countOther })}
        </p>
        {books.length > 0 ? (
          <BookGrid books={books} copy={copy.book} locale={locale} />
        ) : (
          <div className="border-t border-hairline py-12">
            <p className="mb-4 font-serif text-2xl">{copy.books.emptyTitle}</p>
            <Link className="inline-flex min-h-11 items-center text-forest underline underline-offset-4" href={routes.books}>
              {copy.books.clear}
            </Link>
          </div>
        )}
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
