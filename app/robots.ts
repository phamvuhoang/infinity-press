import type { MetadataRoute } from "next";

import { deferPrerenderWithoutServerEnv } from "@/lib/config/build-environment";
import { getServerEnv } from "@/lib/config/server-env";
import { locales } from "@/lib/i18n/config";

// Crawl rules only (S5 spec 7.5). Page metadata stays the authority for noindex: the private route
// groups, /admin, and /internal set `noindex, nofollow` themselves.
const privateRoots = ["/admin", "/api", "/auth", "/internal"];
const privateLocalizedPaths = [
  "/account",
  "/ask",
  "/checkout",
  "/library",
  "/read/",
  "/read-sample",
  "/search",
  "/sign-in",
  "/sign-up",
  "/password-reset",
  "/password-update",
];

export default async function robots(): Promise<MetadataRoute.Robots> {
  await deferPrerenderWithoutServerEnv();
  const { siteUrl } = getServerEnv();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          ...privateRoots,
          ...locales.flatMap((locale) => privateLocalizedPaths.map((path) => `/${locale}${path}`)),
        ],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
