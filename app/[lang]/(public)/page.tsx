import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BookCover } from "@/components/brand/book-cover";
import { BookGrid } from "@/components/catalog/book-card";
import { CoverImage } from "@/components/catalog/cover-image";
import { PriceLabel } from "@/components/catalog/price-label";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { homeShelves } from "@/lib/catalog/browse";
import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { BRAND_NAME } from "@/lib/config/brand";
import { getServerEnv } from "@/lib/config/server-env";
import { isLoopbackUrl } from "@/lib/config/url";
import { getBookCards, getHomeHero, getHomeTopics } from "@/lib/data/catalog";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { organizationSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata } from "@/lib/seo/metadata";

const steps = ["explore", "language", "read"] as const;

// Board 1e runs seven topic columns. More published topics than that belong on the catalog page,
// where they are filters rather than an invitation.
const MAX_HOME_TOPICS = 7;

type Props = { params: Promise<{ lang: string }> };

// The home shelves come from the same card read as the catalog. revalidateStorefront() refreshes
// this on publish - confirmed by e2e/seo-operations.spec.ts ("publishing a new book makes its
// detail page answer 200 ... and reach the sitemap"), which publishes a draft book through the real
// admin path and re-fetches the raw page: 404 before, 200 after, within seconds, no redeploy.
// Otherwise this is stale-while-revalidate on request: once 5 minutes pass, the next request still
// gets the stale page while a fresh one builds in the background, and the request after that gets it.
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // Home has no generateStaticParams of its own - it always renders for the two locale params the
  // root layout unconditionally promises (app/[lang]/layout.tsx), so a build with no server
  // environment still attempts this. Same sibling treatment as app/sitemap.ts.
  await deferPrerenderWithoutServerEnv();
  const { lang: locale } = await params;
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).home;
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: { vi: getLocaleRoutes("vi").home, en: getLocaleRoutes("en").home },
    description: copy.description,
  });
}

export default async function Home({ params }: Props) {
  // Same reason as generateMetadata above: this page always renders for both locale params
  // regardless of whether the build has a server environment.
  await deferPrerenderWithoutServerEnv();
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();
  const [dictionary, cards, hero, allTopics] = await Promise.all([
    getDictionary(locale),
    getBookCards(locale),
    getHomeHero(),
    getHomeTopics(locale),
  ]);
  const { featured, shelf, journey } = homeShelves(cards);
  const catalogRoutes = getCatalogRoutes(locale);
  const copy = dictionary.home;
  const routes = getLocaleRoutes(locale);
  const topics = allTopics.slice(0, MAX_HOME_TOPICS);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <JsonLd data={organizationSchema(getServerEnv().siteUrl)} />
      <main id="main-content">
        {/* Hero - board 1e: serif display, paragraph-first, one primary action and one quiet link. */}
        <section className="mx-auto grid max-w-[90rem] gap-14 px-4 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:gap-16 lg:px-16 lg:py-24">
          <div>
            <p className="mb-5 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
            <h1 className="mb-7 font-serif text-[2.75rem] leading-[1.04] font-normal tracking-[-0.02em] sm:text-6xl lg:text-[4.75rem] lg:leading-[1.02]">
              {copy.title}
            </h1>
            <p className="mb-9 max-w-[32.5rem] font-serif text-lg leading-normal text-ink-soft sm:text-[1.3125rem]">
              {copy.description}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Button render={<Link href={routes.signIn} />} size="lg">
                {copy.getStarted}
              </Button>
              <Link
                className="inline-flex min-h-12 items-center px-2 text-[0.9375rem] font-medium text-forest underline decoration-sand underline-offset-[5px] hover:text-ink hover:decoration-ink"
                href={routes.library}
              >
                {dictionary.navigation.library}
              </Link>
              <Link
                className="inline-flex min-h-12 items-center px-2 text-[0.9375rem] font-medium text-forest underline decoration-sand underline-offset-[5px] hover:text-ink hover:decoration-ink"
                href={routes.books}
              >
                {dictionary.catalog.browseAll}
              </Link>
            </div>
          </div>

          {/* Board 1e: an editorial photograph with one cover set on it. The photograph comes from
              /admin/merchandising; without one the ground falls back to the Sand panel. The two
              renditions are cropped around the same focal point, so the art direction survives the
              switch at the `sm` breakpoint. */}
          <div className="relative h-[22rem] sm:h-[32.5rem]">
            <div className="absolute inset-y-0 right-0 left-10 overflow-hidden bg-surface">
              {hero ? (
                <>
                  <Image
                    alt={hero.alt}
                    className="object-cover sm:hidden"
                    fetchPriority="high"
                    fill
                    preload
                    sizes="100vw"
                    src={hero.mobileUrl}
                    unoptimized={isLoopbackUrl(hero.mobileUrl)}
                  />
                  <Image
                    alt=""
                    className="hidden object-cover sm:block"
                    fill
                    sizes="(min-width: 1024px) 40vw, 90vw"
                    src={hero.desktopUrl}
                    unoptimized={isLoopbackUrl(hero.desktopUrl)}
                  />
                </>
              ) : (
                <div aria-hidden="true" className="absolute inset-x-10 bottom-12 h-px bg-sand" />
              )}
            </div>
            {featured ? (
              <div className="absolute bottom-12 left-0 flex items-end gap-6">
                <Link className="block w-40 sm:w-52" aria-hidden="true" href={catalogRoutes.book(featured.slug)} tabIndex={-1}>
                  <CoverImage card={featured} decorative preload size="lg" sizes="13rem" />
                </Link>
              </div>
            ) : (
              <div aria-hidden="true" className="absolute bottom-12 left-0 w-40 sm:w-52">
                <BookCover byline={BRAND_NAME} size="lg" title={copy.coverQuote} tone="forest" />
              </div>
            )}
          </div>
        </section>

        {/* Featured book band - board 1e gives the featured title its own spread: cover, blurb,
            price, and the two ways in. */}
        {featured ? (
          <section aria-labelledby="home-featured-title" className="border-t border-hairline">
            <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-16 sm:px-8 lg:grid-cols-[20rem_1fr] lg:items-center lg:gap-20 lg:px-16 lg:py-20">
              <Link className="block w-40 sm:w-56 lg:w-full" href={catalogRoutes.book(featured.slug)} aria-hidden="true" tabIndex={-1}>
                <CoverImage card={featured} decorative size="lg" sizes="(min-width: 1024px) 20rem, 14rem" />
              </Link>
              <div className="max-w-[38.75rem]">
                <p className="mb-4 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">
                  {featured.topics[0] ? `${copy.featured.eyebrow} · ${featured.topics[0].name}` : copy.featured.eyebrow}
                </p>
                <h2 className="mb-5 font-serif text-3xl leading-[1.1] font-normal tracking-[-0.01em] sm:text-4xl lg:text-[2.75rem]" id="home-featured-title">
                  <Link className="hover:underline" href={catalogRoutes.book(featured.slug)}>
                    {featured.title}
                  </Link>
                </h2>
                {featured.shortDescription ? (
                  <p className="mb-7 font-serif text-lg leading-relaxed text-ink-soft">{featured.shortDescription}</p>
                ) : null}
                <div className="mb-6 flex flex-wrap items-baseline gap-4">
                  <PriceLabel className="font-serif text-2xl text-ink" copy={dictionary.catalog.book} locale={locale} offer={featured.offer} />
                  <span className="text-sm text-ink-soft">{featured.author.name}</span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button render={<Link href={catalogRoutes.book(featured.slug)} />}>{copy.featured.view}</Button>
                  {featured.hasSample ? (
                    <Button render={<Link href={catalogRoutes.sample(featured.slug)} />} variant="outline">
                      {copy.featured.sample}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {/* Topic entry points - board 1e's seven ruled columns. Every topic here already holds a
            published book. */}
        {topics.length > 0 ? (
          <section aria-labelledby="home-topics-title" className="border-t border-hairline">
            <div className="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 lg:px-16 lg:py-20">
              <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
                <h2 className="max-w-[35rem] font-serif text-3xl leading-[1.15] font-normal tracking-[-0.01em] sm:text-4xl" id="home-topics-title">
                  {copy.topicsTitle}
                </h2>
                <Link className="inline-flex min-h-11 items-center text-sm font-medium text-forest underline underline-offset-4" href={routes.books}>
                  {copy.topicsLink}
                </Link>
              </div>
              <ul className="grid gap-x-0 gap-y-8 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
                {topics.map((topic) => (
                  <li className="border-sand px-0 sm:border-l sm:px-5 sm:first:pl-0 lg:px-5 lg:first:pl-5" key={topic.slug}>
                    <Link
                      className="font-serif text-xl leading-tight text-ink hover:underline"
                      href={catalogRoutes.entity("topic", topic.slug)}
                    >
                      {topic.name}
                    </Link>
                    {topic.description ? (
                      <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-soft">{topic.description}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {/* Platform introduction: what the Press is, never a single author. */}
        <section aria-labelledby="home-platform-title" className="border-t border-hairline bg-surface">
          <div className="mx-auto grid max-w-[90rem] gap-6 px-4 py-16 sm:px-8 lg:grid-cols-[18.75rem_1fr] lg:gap-16 lg:px-16 lg:py-20">
            <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.platform.eyebrow}</p>
            <div className="max-w-[40rem]">
              <h2 className="mb-5 font-serif text-3xl leading-[1.15] font-normal sm:text-4xl" id="home-platform-title">
                {copy.platform.title}
              </h2>
              <p className="font-serif text-lg leading-relaxed text-ink-soft">{copy.platform.copy}</p>
            </div>
          </div>
        </section>

        {shelf.length > 0 ? (
          <section aria-labelledby="home-shelf-title" className="border-t border-hairline">
            <div className="mx-auto max-w-[90rem] px-4 py-16 sm:px-8 lg:px-16 lg:py-20">
              <div className="mb-10 grid gap-6 lg:grid-cols-[18.75rem_1fr] lg:items-end lg:gap-16">
                <h2 className="font-serif text-3xl leading-[1.15] font-normal whitespace-pre-line sm:text-4xl" id="home-shelf-title">
                  {copy.shelfTitle}
                </h2>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <p className="max-w-[35rem] text-[0.9375rem] leading-relaxed text-ink-soft">{copy.shelfDescription}</p>
                  <Link className="inline-flex min-h-11 items-center text-sm font-medium text-forest underline underline-offset-4" href={routes.books}>
                    {dictionary.catalog.browseAll}
                  </Link>
                </div>
              </div>
              <BookGrid books={shelf} copy={dictionary.catalog.book} locale={locale} />
            </div>
          </section>
        ) : null}

        {/* Journey band - the featured book's series, walked in order. Hidden until two of its
            books are published (homeShelves). */}
        {journey.length > 0 ? (
          <section aria-labelledby="home-journey-title" className="border-t border-hairline">
            <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-16 sm:px-8 lg:grid-cols-[18.75rem_1fr] lg:gap-16 lg:px-16 lg:py-20">
              <h2 className="font-serif text-3xl leading-[1.15] font-normal whitespace-pre-line sm:text-4xl" id="home-journey-title">
                {copy.journeyTitle}
              </h2>
              <ol className="flex flex-col gap-8 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-6">
                {journey.map((book, index) => (
                  <li className="flex items-start gap-6" key={book.bookId}>
                    {index > 0 ? (
                      <span aria-hidden="true" className="hidden pt-7 text-sage-text sm:block">
                        →
                      </span>
                    ) : null}
                    <div className="max-w-[16rem]">
                      <p className="mb-2 text-[0.6875rem] font-medium tracking-[0.1em] text-sage-text uppercase">
                        {copy.journeySteps[Math.min(index, copy.journeySteps.length - 1)]}
                      </p>
                      <Link className="font-serif text-xl leading-tight text-ink hover:underline" href={catalogRoutes.book(book.slug)}>
                        {book.title}
                      </Link>
                      {book.subtitle ? <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-ink-soft">{book.subtitle}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : null}

        {/* The Deep Forest band from board 1e: three numbered values set large in Lora. */}
        <section className="bg-forest text-ivory">
          <ol className="mx-auto grid max-w-[90rem] gap-12 px-4 py-16 sm:px-8 md:grid-cols-3 md:gap-16 lg:px-16 lg:py-24">
            {steps.map((key, index) => (
              <li key={key}>
                <p className="mb-3.5 text-xs font-medium tracking-[0.1em] uppercase opacity-70">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="mb-3.5 font-serif text-[1.75rem] leading-[1.15] font-normal lg:text-[2.125rem]">
                  {copy.howItWorks[key].title}
                </h3>
                <p className="text-[0.9375rem] leading-relaxed opacity-85">{copy.howItWorks[key].copy}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <SiteFooter locale={locale} tagline={copy.footerTagline} />
    </div>
  );
}
