import "server-only";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { cache } from "react";

import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { listPublicBundleSlugs } from "@/lib/data/public-bundles";
import type { Locale } from "@/lib/i18n/config";

type CatalogStaticParams = {
  books: string[];
  authors: string[];
  series: string[];
  topics: string[];
  bundles: string[];
};

const emptyStaticParams: CatalogStaticParams = { books: [], authors: [], series: [], topics: [], bundles: [] };

// The slugs the catalog prerenders, read exactly the way app/sitemap.ts reads them: from the same
// public card read the storefront uses, so a draft book is invisible here too and a book localized
// in one locale only is prerendered in that locale only. A slug that appears later is still served
// - dynamicParams stays on its default, so Next renders it on demand and caches it from then on.
// Wrapped in React's `cache()` the same way getBookCards and getPublicBundle are, so the five
// detail pages' `generateStaticParams` calls (plus the sitemap) share one read per locale during a
// build instead of five.
//
// A build without the server environment (CI, a local check) cannot query at all.
// `deferPrerenderWithoutServerEnv()` (lib/config/build-environment.ts) handles this for a page body
// by calling `connection()` to defer the read to request time - `generateStaticParams` cannot do
// that, since `connection()` only defers rendering, not the static-params collection phase itself.
// So the sibling treatment here is to return no slugs instead of failing the build: every slug still
// renders on demand and caches from the first real request, because `dynamicParams` stays on its
// default. This only applies during `next build`'s production phase, and only when the environment
// itself is missing - exactly the same condition `deferPrerenderWithoutServerEnv()` checks. An
// environment that IS present but a query that still fails (bad credentials, a database outage, a
// broken RPC) must keep failing loudly: swallowing that would turn a broken deployment into a
// silently unprerendered one, which is the one failure mode this whole plan exists to prevent.
export const catalogStaticParams = cache(async (locale: Locale): Promise<CatalogStaticParams> => {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
    try {
      getServerEnv();
    } catch {
      return emptyStaticParams;
    }
  }

  const [cards, bundles] = await Promise.all([getBookCards(locale), listPublicBundleSlugs()]);

  const unique = (slugs: string[]) => [...new Set(slugs)];

  return {
    // A work shown under another locale's copy (metadata fallback) is the same page as that locale's,
    // not a page of this one: it is not prerendered or listed here, so the sitemap carries no
    // duplicate of the English page under /ja.
    books: unique(cards.filter((card) => card.metadataLocale === locale).map((card) => card.slug)),
    authors: unique(cards.flatMap((card) => (card.author.slug ? [card.author.slug] : []))),
    series: unique(cards.flatMap((card) => (card.series ? [card.series.slug] : []))),
    topics: unique(cards.flatMap((card) => card.topics.map((topic) => topic.slug))),
    bundles: unique(bundles.filter((bundle) => bundle.locale === locale).map((bundle) => bundle.slug)),
  };
});
