import Link from "next/link";

import type { Locale } from "@/lib/i18n/config";
import { formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes, getKnowledgeRoutes } from "@/lib/i18n/routes";
import type { KnowledgeArticleSummary } from "@/lib/knowledge/public-types";

// The article archive, newest first. Publication dates survive unpublish/republish, so the order
// is the editorial history rather than the last edit.
export function ArticleIndex({
  articles,
  locale,
  copy,
}: {
  articles: KnowledgeArticleSummary[];
  locale: Locale;
  copy: { empty: string; by: string; published: string };
}) {
  if (articles.length === 0) return <p className="text-[0.9375rem] text-ink-soft">{copy.empty}</p>;

  const routes = getKnowledgeRoutes(locale);
  const catalogRoutes = getCatalogRoutes(locale);
  const ordered = [...articles].sort(
    (left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
  );

  return (
    <ol className="divide-y divide-hairline border-y border-hairline">
      {ordered.map((article) => (
        <li className="py-8" key={article.articleId}>
          <article className="max-w-[40rem]">
            <h2 className="font-serif text-2xl leading-snug font-normal">
              <Link className="inline-flex min-h-11 items-center underline-offset-4 hover:underline" href={routes.article(article.slug)}>
                {article.title}
              </Link>
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              {copy.by}{" "}
              {article.author.slug ? (
                <Link
                  className="text-forest underline decoration-sand underline-offset-4 hover:text-ink"
                  href={catalogRoutes.entity("author", article.author.slug)}
                >
                  {article.author.name}
                </Link>
              ) : (
                article.author.name
              )}
              <span aria-hidden="true"> · </span>
              <span className="sr-only">{copy.published} </span>
              <time dateTime={article.publishedAt}>{formatDate(article.publishedAt, locale)}</time>
            </p>
            <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-soft">{article.excerpt}</p>
          </article>
        </li>
      ))}
    </ol>
  );
}
