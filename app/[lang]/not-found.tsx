import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { defaultLocale, withLocale, type Locale } from "@/lib/i18n/config";

// not-found.tsx receives no props (unlike a page or layout, it gets no `params`), and it is part of
// the render tree Next has to be able to produce while prerendering every route in this segment -
// not just the ones a visitor actually 404s on. It used to read the locale from a request header
// (Proxy sets localeHeader from the URL - see getInterfaceLocale), the same source
// app/[lang]/forbidden.tsx read. That made both boundaries request-time-only, and having EITHER one
// depend on headers() was enough to stop every route under /[lang] from prerendering with concrete
// params - even a route with no path anywhere near a 404. Measured directly: hardcoding either file
// alone changed nothing; hardcoding both together produced ● pages with real paths for the home
// page, books, authors, series, and topics. Renaming the segment folder to [lang] (see
// app/[lang]/layout.tsx) was tried first and did NOT fix this - that rename's necessity is
// unproven; this is the actual cause. See
// docs/runbooks/storefront-caching.md ("The bug that cost the longest bisection") for the
// bisection. So this renders the default locale's copy always, not the visitor's: a visitor on /en
// who hits a 404 sees the default-locale heading text, a small and deliberate price for the whole segment
// staying static. Pulling the dictionaries in for two strings is not worth it, so the copy lives
// inline here rather than in lib/i18n/dictionaries; there is no `notFound` key in the dictionaries.
const copy: Record<Locale, { heading: string; backHome: string }> = {
  vi: { heading: "Không tìm thấy trang", backHome: "Về trang chủ" },
  en: { heading: "Page not found", backHome: "Return home" },
  ja: { heading: "ページが見つかりません", backHome: "ホームに戻る" },
};

export default function NotFound() {
  const locale = defaultLocale;
  const text = copy[locale];
  const home = withLocale(locale, "/");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-ivory px-4 py-12 text-center" id="main-content">
      <Logo href={home} />
      <div className="max-w-[35rem] border-t border-ink pt-8">
        <p className="mb-3 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">404</p>
        <h1 className="mb-4 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{text.heading}</h1>
        <Link
          className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
          href={home}
        >
          {text.backHome}
        </Link>
      </div>
    </main>
  );
}
