import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { alternatePaths } from "@/lib/i18n/alternates";

import { ActionErrorBanner } from "@/components/catalog/action-error-banner";
import { BookGrid } from "@/components/catalog/book-card";
import { CoverImage } from "@/components/catalog/cover-image";
import { ViewerBundleAction } from "@/components/catalog/viewer-bundle-action";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { formatPrice } from "@/lib/catalog/price";
import { fillTemplate } from "@/lib/i18n/format";
import { catalogStaticParams } from "@/lib/catalog/static-params";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getPublicBundle, publicBundleAction } from "@/lib/data/public-bundles";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { breadcrumbSchema, bundleSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, localePaths, SITE_NAME } from "@/lib/seo/metadata";

import { buyBundleAction } from "./actions";

type Props = {
  params: Promise<{ lang: string; slug: string }>;
};

const sectionTitle = "mb-4 font-serif text-2xl font-normal";

// Prerendered per published bundle. revalidateStorefront() invalidates this on publish - confirmed
// by e2e/seo-operations.spec.ts ("publishing a new book makes its detail page answer 200 ... and
// reach the sitemap"), which publishes a draft book through the real admin path and re-fetches the
// raw page: 404 before, 200 after, within seconds, no redeploy; revalidateBundleAdmin() calls the
// same revalidateStorefront(). Otherwise this is stale-while-revalidate on request: once 5 minutes
// pass, the next request still gets the stale page while a fresh one builds in the background, and
// the request after that gets it. A slug not listed here renders on demand once, then caches.
export const revalidate = 300;

export async function generateStaticParams({ params }: { params: { lang: string } }) {
  if (!isLocale(params.lang)) return [];
  const { bundles } = await catalogStaticParams(params.lang);
  return bundles.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) return {};
  const bundle = await getPublicBundle(locale, slug);
  if (!bundle) return {};
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    // The alternate only when the bundle really is localized there: a bundle with one localization
    // is a one-locale page, not the same page under two URLs.
    paths: localePaths(
      locale,
      getCatalogRoutes(locale).bundle(bundle.slug),
      alternatePaths(bundle.alternateSlugs, (l, s) => getCatalogRoutes(l).bundle(s)),
    ),
    title: bundle.title,
    description: bundle.description ?? bundle.subtitle ?? undefined,
    image: bundle.cover,
  });
}

// The public bundle page (S9 spec 6.3). Everything it shows comes from the public DTO, and the one
// action it offers is re-checked by buyBundleAction and by create_bundle_order after it.
//
// It has to survive a published bundle that has drifted below its own publish-time readiness bar -
// a member unpublished, the offer deactivated, the cover replaced - because readiness gates
// publishing and nothing after it. So the price, the member list and the action are each rendered
// only when they exist, and a bundle with nothing visible left says so.
export default async function BundlePage({ params }: Props) {
  const { lang: locale, slug } = await params;
  if (!isLocale(locale)) notFound();
  const bundle = await getPublicBundle(locale, slug);
  if (!bundle) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.catalog;
  const routes = getCatalogRoutes(locale);
  const env = getServerEnv();
  // What an anonymous visitor could do now, so the page can be prerendered: nobody owns anything.
  // ViewerBundleAction corrects this in the browser from /api/catalog/bundles/[bundleId]/action-state.
  const publicAction = publicBundleAction(bundle);
  const bundlePath = routes.bundle(bundle.slug);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader
        alternates={alternatePaths(bundle.alternateSlugs, (l, s) => getCatalogRoutes(l).bundle(s))}
        current="books"
        locale={locale}
      />
      <JsonLd
        data={[
          bundleSchema({ siteUrl: env.siteUrl, locale, path: bundlePath, bundle, paymentsEnabled: arePaymentsEnabled(env) }),
          breadcrumbSchema(env.siteUrl, [
            { name: SITE_NAME, path: getLocaleRoutes(locale).home },
            { name: dictionary.navigation.books, path: getLocaleRoutes(locale).books },
            { name: bundle.title, path: bundlePath },
          ]),
        ]}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-20" id="main-content">
        <article className="grid gap-12 lg:grid-cols-[22rem_1fr] lg:gap-20">
          <div className="mx-auto w-full max-w-[16rem] lg:max-w-none">
            <CoverImage
              card={{ bookId: bundle.bundleId, title: bundle.title, author: { name: SITE_NAME, slug: null }, cover: bundle.cover }}
              preload
              size="lg"
              sizes="(min-width: 1024px) 22rem, 16rem"
            />
          </div>

          <div className="max-w-[40rem]">
            <p className="text-xs tracking-[0.08em] text-sage-text uppercase">{copy.bundle.eyebrow}</p>
            <h1 className="mt-2 font-serif text-4xl leading-[1.08] font-normal tracking-[-0.01em] sm:text-5xl">{bundle.title}</h1>
            {bundle.subtitle ? <p className="mt-3 font-serif text-xl text-ink-soft">{bundle.subtitle}</p> : null}

            <div className="mt-8 flex flex-wrap items-start gap-x-6 gap-y-4 border-y border-hairline py-6">
              {bundle.offer ? (
                <div className="min-h-11 space-y-1">
                  <span className="block text-2xl font-medium text-ink">
                    {formatPrice(bundle.offer.priceMinor, bundle.offer.currency, locale)}
                  </span>
                  <span className="block text-xs text-sage-text">{copy.bundle.priceNote}</span>
                </div>
              ) : null}
              <ViewerBundleAction
                buyAction={buyBundleAction.bind(null, locale, bundle.bundleId, bundle.slug)}
                buyLabel={copy.bundle.buy}
                bundleId={bundle.bundleId}
                copy={copy.actions}
                libraryLabel={copy.bundle.library}
                libraryPath={getLocaleRoutes(locale).library}
                locale={locale}
                memberCount={bundle.members.length}
                ownedCopy={{ ownedAll: copy.bundle.ownedAll, ownedSome: copy.bundle.ownedSome }}
                publicAction={publicAction}
                signInPath={routes.signInFor(bundlePath)}
              />
            </div>

            <Suspense fallback={null}>
              <ActionErrorBanner messages={copy.actionErrors} />
            </Suspense>

            {bundle.description ? (
              <p className="mt-10 text-[0.9375rem] leading-relaxed whitespace-pre-line text-ink-soft">{bundle.description}</p>
            ) : null}
          </div>
        </article>

        <section aria-labelledby="bundle-members" className="mt-16">
          <h2 className={sectionTitle} id="bundle-members">
            {copy.bundle.includes}
          </h2>
          {new Set(bundle.members.map((member) => member.languageCode)).size > 1 ? (
            <p className="mb-6 text-sm text-sage-text">
              {fillTemplate(copy.bundle.languages, { languages: [...new Set(bundle.members.map((member) => member.languageLabel))].join(", ") })}
            </p>
          ) : null}
          {bundle.members.length > 0 ? (
            <BookGrid books={bundle.members} copy={copy.book} locale={locale} />
          ) : (
            <p className="text-[0.9375rem] text-ink-soft">{copy.bundle.empty}</p>
          )}
        </section>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
