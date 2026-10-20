import "server-only";

import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { cache } from "react";

import { getServerEnv } from "@/lib/config/server-env";
import { getArticleIndex, getPublishedIdeas } from "@/lib/data/knowledge";
import type { Locale } from "@/lib/i18n/config";

type KnowledgeStaticParams = { ideas: string[]; articles: string[] };

// The idea and article slugs the knowledge hub prerenders, from the same published reads as the
// index pages, so a draft or an unlocalized entity is never prerendered. It follows
// lib/catalog/static-params.ts exactly: a `next build` with no server environment returns no
// slugs, and every slug then renders on demand and caches from its first request; an environment
// that is present but whose read fails still fails the build.
export const knowledgeStaticParams = cache(async (locale: Locale): Promise<KnowledgeStaticParams> => {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
    try {
      getServerEnv();
    } catch {
      return { ideas: [], articles: [] };
    }
  }

  const [ideas, articles] = await Promise.all([getPublishedIdeas(locale), getArticleIndex(locale)]);
  return {
    ideas: [...new Set(ideas.map((idea) => idea.slug))],
    articles: [...new Set(articles.map((article) => article.slug))],
  };
});
