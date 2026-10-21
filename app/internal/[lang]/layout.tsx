import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "../../globals.css";

import { beVietnamPro, lora } from "@/lib/fonts";
import { isLocale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function InternalLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}>) {
  const { lang: locale } = await params;

  // app/[lang]/layout.tsx documents why it avoids this: a layout cannot see a notFound() thrown by
  // its own render, so app/internal/[lang]/not-found.tsx - a child of this layout - cannot catch
  // this and Next falls back to its own unstyled interrupt shell. That tradeoff is deliberate there
  // because the segment is prerendered and every page.tsx guards its own locale instead. /internal
  // never prerenders (no generateStaticParams, no customer traffic), so there is no page.tsx per
  // route relying on that pattern to guard against; calling notFound() here directly is simpler and
  // costs nothing today. If /internal ever needs to prerender, move this check down to each page the
  // way app/[lang] does.
  if (!isLocale(locale)) {
    notFound();
  }

  return (
    <html className={cn("font-sans", lora.variable, beVietnamPro.variable)} lang={locale}>
      <body className="min-h-screen antialiased">
        <a
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-3 focus:font-medium focus:text-ivory"
          href="#main-content"
        >
          Skip to main content
        </a>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
