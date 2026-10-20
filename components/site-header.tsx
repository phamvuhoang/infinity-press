import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { LocaleSelector } from "@/components/locale-selector";
import { SiteHeaderAccountNav } from "@/components/site-header-account-nav";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getKnowledgeRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import type { Locale } from "@/lib/i18n/config";
import { cn } from "@/lib/utils";

// The quiet text link used across the header (board 1e): Ink, medium weight, underlined only to
// mark the current section.
const navLink =
  "inline-flex min-h-11 items-center px-1 text-sm font-medium text-ink underline-offset-[6px] decoration-ink hover:underline";

// `alternates` holds this page's URL in the other locale, when that page exists (spec 4.6).
// Without it, the switcher goes to the other locale's home.
export async function SiteHeader({
  locale,
  current,
  alternates,
}: {
  locale: Locale;
  current?: "library" | "account" | "books" | "ideas" | "articles" | "search";
  alternates?: Partial<Record<Locale, string>>;
}) {
  const dictionary = await getDictionary(locale);
  const routes = getLocaleRoutes(locale);
  const knowledgeRoutes = getKnowledgeRoutes(locale);
  const copy = dictionary.navigation;

  return (
    <header className="border-b border-hairline bg-ivory">
      <nav
        aria-label={copy.primary}
        className="mx-auto flex min-h-[4.5rem] max-w-[90rem] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2 sm:px-8 lg:px-16"
      >
        <Logo href={routes.home} />
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 sm:gap-x-6">
          <LocaleSelector alternates={alternates} label={copy.switchLocale} locale={locale} />
          <Link
            aria-current={current === "books" ? "page" : undefined}
            className={cn(navLink, current === "books" && "underline")}
            href={routes.books}
          >
            {copy.books}
          </Link>
          <Link
            aria-current={current === "ideas" ? "page" : undefined}
            className={cn(navLink, current === "ideas" && "underline")}
            href={knowledgeRoutes.ideas}
          >
            {copy.ideas}
          </Link>
          <Link
            aria-current={current === "articles" ? "page" : undefined}
            className={cn(navLink, current === "articles" && "underline")}
            href={knowledgeRoutes.articles}
          >
            {copy.articles}
          </Link>
          <Link
            aria-current={current === "search" ? "page" : undefined}
            className={cn(navLink, current === "search" && "underline")}
            href={routes.search}
          >
            {copy.search}
          </Link>
          <SiteHeaderAccountNav
            copy={{ account: copy.account, library: copy.library, signIn: copy.signIn, signOut: copy.signOut }}
            current={current}
            locale={locale}
            navLinkClassName={navLink}
          />
        </div>
      </nav>
    </header>
  );
}
