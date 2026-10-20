import Link from "next/link";

import type { Locale } from "@/lib/i18n/config";
import { formatDate } from "@/lib/i18n/format";
import { getKnowledgeRoutes } from "@/lib/i18n/routes";
import type { KnowledgeIdeaReference } from "@/lib/knowledge/blocks";
import type { KnowledgeLinkSummary } from "@/lib/knowledge/public-types";

// One list for every place the site links to ideas and articles: related ideas on a detail page,
// the idea index's topic groups, and the backlinks on book and topic pages. An item's title is its
// link text; the link goes to the item's canonical path in `locale`.
export type KnowledgeLinkItem = KnowledgeLinkSummary;

export function ideaLinkItems(ideas: KnowledgeIdeaReference[]): KnowledgeLinkItem[] {
  return ideas.map((idea) => ({
    kind: "idea",
    slug: idea.slug,
    title: idea.question,
    excerpt: idea.shortAnswer,
    publishedAt: null,
  }));
}

export function KnowledgeLinkList({
  items,
  locale,
  kindLabels,
}: {
  items: KnowledgeLinkItem[];
  locale: Locale;
  // Given only where ideas and articles share one list, so a reader can tell them apart.
  kindLabels?: Record<KnowledgeLinkItem["kind"], string>;
}) {
  if (items.length === 0) return null;
  const routes = getKnowledgeRoutes(locale);

  return (
    <ul className="divide-y divide-hairline border-y border-hairline">
      {items.map((item) => (
        <li className="py-5" key={`${item.kind}:${item.slug}`}>
          {kindLabels ? (
            <p className="mb-1 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{kindLabels[item.kind]}</p>
          ) : null}
          <Link
            className="inline-flex min-h-11 items-center font-serif text-xl leading-snug text-ink underline-offset-4 hover:underline"
            href={item.kind === "idea" ? routes.idea(item.slug) : routes.article(item.slug)}
          >
            {item.title}
          </Link>
          {item.excerpt ? <p className="mt-1 text-[0.9375rem] leading-relaxed text-ink-soft">{item.excerpt}</p> : null}
          {item.publishedAt ? (
            <p className="mt-2 text-xs text-sage-text">
              <time dateTime={item.publishedAt}>{formatDate(item.publishedAt, locale)}</time>
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
