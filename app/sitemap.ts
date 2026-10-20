import type { MetadataRoute } from "next";

import { catalogStaticParams } from "@/lib/catalog/static-params";
import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";
import { getKnowledgeSitemapEntries } from "@/lib/data/knowledge";
import { locales } from "@/lib/i18n/config";
import {
  getCatalogRoutes,
  getKnowledgeRoutes,
  getLocaleRoutes,
} from "@/lib/i18n/routes";
import { absoluteUrl } from "@/lib/seo/metadata";

// Published localized storefront and knowledge hub URLs only (S5 spec 7.4, S12 spec 7). Book and
// entity URLs come from the same public card read as the storefront, so an author, series, or topic
// is listed only when it has a visible book in that locale; idea and article URLs come from the
// published index reads. revalidateStorefront() and revalidateKnowledgeHub() also invalidate this
// route - the former confirmed by
// e2e/seo-operations.spec.ts ("publishing a new book makes its detail page answer 200 ... and reach
// the sitemap"), which asserts the new URL appears in the sitemap within the same test. Otherwise
// this is stale-while-revalidate on request: once 5 minutes pass, the next request still gets the
// stale sitemap while a fresh one builds in the background, and the request after that gets it.
export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await deferPrerenderWithoutServerEnv();
  const { siteUrl } = getServerEnv();
  // Path -> lastModified. The first listing of a path wins, so each URL appears once.
  const entries = new Map<string, string | undefined>();
  const add = (path: string, lastModified?: string) => {
    if (!entries.has(path)) entries.set(path, lastModified);
  };

  for (const locale of locales) {
    // The same slugs the catalog and knowledge pages prerender, so a page that exists is listed and
    // a page that is listed exists. Draft and unlocalized entities are invisible to these reads, and
    // a failed read rejects the whole sitemap rather than serving a partial one.
    const [slugs, knowledge] = await Promise.all([
      catalogStaticParams(locale),
      getKnowledgeSitemapEntries(locale),
    ]);
    const { home, books } = getLocaleRoutes(locale);
    const catalog = getCatalogRoutes(locale);
    const hub = getKnowledgeRoutes(locale);

    for (const path of [
      home,
      books,
      ...slugs.books.map((slug) => catalog.book(slug)),
      ...slugs.authors.map((slug) => catalog.entity("author", slug)),
      ...slugs.series.map((slug) => catalog.entity("series", slug)),
      ...slugs.topics.map((slug) => catalog.entity("topic", slug)),
      ...slugs.bundles.map((slug) => catalog.bundle(slug)),
      // The hub indexes always exist, even before anything is published.
      hub.ideas,
      hub.articles,
    ]) {
      add(path);
    }
    // Knowledge detail pages carry the localization's last edit.
    for (const entry of knowledge) add(entry.path, entry.lastModified);
  }

  return [...entries].map(([path, lastModified]) => ({
    url: absoluteUrl(siteUrl, path),
    ...(lastModified ? { lastModified } : {}),
  }));
}
