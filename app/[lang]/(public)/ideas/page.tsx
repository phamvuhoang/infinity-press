import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { IdeaIndex } from "@/components/knowledge/idea-index";
import { SiteFooter } from "@/components/site-footer";
import { JsonLd } from "@/components/seo/json-ld";
import { SiteHeader } from "@/components/site-header";
import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";
import { getIdeaIndex } from "@/lib/data/knowledge";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getKnowledgeRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { breadcrumbSchema } from "@/lib/seo/json-ld";
import { buildPageMetadata, fixedPaths, SITE_NAME } from "@/lib/seo/metadata";

type Props = { params: Promise<{ lang: string }> };

// Prerendered for both locales, like home: it has no params of its own, so a build without a
// server environment defers it to the first request (deferPrerenderWithoutServerEnv). Every
// knowledge mutation calls revalidateKnowledgeHub(), which invalidates the whole "/[lang]" layout;
// otherwise it is stale-while-revalidate after 5 minutes.
export const revalidate = 300;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await deferPrerenderWithoutServerEnv();
  const { lang: locale } = await params;
  if (!isLocale(locale)) return {};
  const copy = (await getDictionary(locale)).knowledge.ideas;
  return buildPageMetadata({
    siteUrl: getServerEnv().siteUrl,
    locale,
    paths: fixedPaths((l) => getKnowledgeRoutes(l).ideas),
    title: copy.title,
    description: copy.description,
  });
}

export default async function IdeasPage({ params }: Props) {
  await deferPrerenderWithoutServerEnv();
  const { lang: locale } = await params;
  if (!isLocale(locale)) notFound();

  const [dictionary, groups] = await Promise.all([getDictionary(locale), getIdeaIndex(locale)]);
  const copy = dictionary.knowledge.ideas;
  const routes = getKnowledgeRoutes(locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader alternates={fixedPaths((l) => getKnowledgeRoutes(l).ideas)} current="ideas" locale={locale} />
      <JsonLd
        data={breadcrumbSchema(getServerEnv().siteUrl, [
          { name: SITE_NAME, path: getLocaleRoutes(locale).home },
          { name: dictionary.navigation.ideas, path: routes.ideas },
        ])}
      />
      <main className="mx-auto max-w-[90rem] px-4 py-12 sm:px-8 lg:px-16 lg:py-16" id="main-content">
        <div className="max-w-[48rem]">
          <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
          <h1 className="mb-4 font-serif text-4xl font-normal sm:text-5xl">{copy.title}</h1>
          <p className="mb-12 max-w-[35rem] text-[0.9375rem] text-ink-soft">{copy.description}</p>
          <IdeaIndex copy={copy} groups={groups} locale={locale} />
        </div>
      </main>
      <SiteFooter locale={locale} tagline={dictionary.home.footerTagline} />
    </div>
  );
}
