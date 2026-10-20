import { EntityPage, entityMetadata } from "@/components/catalog/entity-page";
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { isLocale } from "@/lib/i18n/config";

type Props = { params: Promise<{ lang: string; slug: string }> };

// Prerendered per author with a visible book. revalidateStorefront() invalidates this on publish -
// confirmed by e2e/seo-operations.spec.ts ("publishing a new book makes its detail page answer 200
// ... and reach the sitemap"), which publishes a draft book through the real admin path and
// re-fetches the raw page: 404 before, 200 after, within seconds, no redeploy. Otherwise this is
// stale-while-revalidate on request: once 5 minutes pass, the next request still gets the stale
// page while a fresh one builds in the background, and the request after that gets it. A slug not
// listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { lang: string } }) {
  if (!isLocale(params.lang)) return [];
  const { authors } = await catalogStaticParams(params.lang);
  return authors.map((slug) => ({ slug }));
}

export function generateMetadata({ params }: Props) {
  return entityMetadata("author", params);
}

export default function AuthorPage({ params }: Props) {
  return <EntityPage kind="author" params={params} />;
}
