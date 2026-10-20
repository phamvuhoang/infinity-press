import type { Metadata } from "next";
import "../globals.css";

import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";
import { beVietnamPro, lora } from "@/lib/fonts";
import { locales, resolveLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { SITE_NAME } from "@/lib/seo/metadata";
import { cn } from "@/lib/utils";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// This is a root layout, not a nested one: it renders <html> and <body>. The app has one root
// layout per top-level area (/[lang], /admin, /internal) so that each can name its own document
// language from its own params. Reading it from a request header instead would make every route
// under it render on demand.
//
// The segment folder is named [lang], not [locale]. This rename was tried as a fix for every route
// under here silently rendering fully dynamic instead of prerendering - but it did NOT fix that.
// [locale] never wrote a concrete prerendered file even in the cases that looked like they worked,
// and the rename's necessity is unproven. It is kept because renaming surfaced a real bug
// (lib/catalog/revalidate.ts's revalidatePath("/[locale]", "layout") was a string literal that
// would have silently stopped invalidating the storefront layout if left un-renamed) and because
// undoing a rename that did no harm just to "simplify" is not worth the churn.
//
// The ACTUAL cause, and the one that matters if you are debugging this again: a `headers()` read in
// EITHER app/[lang]/not-found.tsx OR app/[lang]/forbidden.tsx keeps this entire segment dynamic,
// silently, with no build error to say why. Either file alone is enough - testing them one at a
// time produces two misleading negatives, which is exactly what happened here before the real cause
// was found. Both files hardcode defaultLocale instead of reading the request now; that is the
// thing actually holding prerendering up, not this rename. See
// docs/runbooks/storefront-caching.md ("The bug that cost the longest bisection") for the full
// bisection. Do not "simplify" not-found.tsx or forbidden.tsx back to reading headers() - that will
// silently undo prerendering for every route under here.
export function generateStaticParams() {
  return locales.map((locale) => ({ lang: locale }));
}

// SITE_URL is the only public origin (S5 spec 7.1). This segment is prerendered now, so this runs
// during `next build`, not at request time. The `locale` params above are unconditional (every
// build promises a /vi and /en page, regardless of the server environment - see
// app/[lang]/layout.test.tsx), so a build with no environment still attempts to render both, same
// as app/sitemap.ts. deferPrerenderWithoutServerEnv() defers that render to the first real request
// instead of failing the build; a production deploy has the environment and validates it here, at
// build time, same as before.
export async function generateMetadata(): Promise<Metadata> {
  await deferPrerenderWithoutServerEnv();
  return {
    metadataBase: new URL(getServerEnv().siteUrl),
    title: {
      default: SITE_NAME,
      template: `%s · ${SITE_NAME}`,
    },
    description: "A home for books that stay with you.",
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}>) {
  // A layout cannot see a notFound() thrown by its OWN render - not-found.tsx replaces a child of
  // this layout, so it can't render if the layout itself fails. An unsupported locale (/fr) is
  // instead resolved to defaultLocale here and left to the page below to reject: every page.tsx
  // under app/[lang] guards its own locale directly or via EntityPage (see
  // app/[lang]/layout.test.tsx for the invariant this depends on), so the 404 still happens -
  // just from a segment app/[lang]/not-found.tsx can actually catch.
  const { lang: rawLocale } = await params;
  const locale = resolveLocale(rawLocale);

  const dictionary = await getDictionary(locale);

  return (
    <html className={cn("font-sans", lora.variable, beVietnamPro.variable)} lang={locale}>
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-3 focus:font-medium focus:text-ivory"
          href="#main-content"
        >
          {dictionary.navigation.skipToContent}
        </a>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
