import Link from "next/link";

import { type Locale, localeRegistry, locales } from "@/lib/i18n/config";
import { getLocaleRoutes } from "@/lib/i18n/routes";
import { cn } from "@/lib/utils";

// One link per registered locale, each named in its own language. `alternates` holds this page's
// URL in the locales it exists in (spec 4.6): a locale without it goes to that locale's home, never
// to another entity's page. Changing the UI locale never changes which edition a reader chose.
export function LocaleSelector({
  locale,
  alternates,
  label,
  className,
}: {
  locale: Locale;
  alternates?: Partial<Record<Locale, string>>;
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("flex items-center gap-x-1", className)}>
      {locales.map((candidate) => {
        const { nativeName } = localeRegistry[candidate];
        const base = "inline-flex min-h-11 items-center px-1.5 text-sm font-medium";
        return candidate === locale ? (
          <span aria-current="true" className={cn(base, "text-ink")} key={candidate} lang={candidate}>
            {nativeName}
          </span>
        ) : (
          <Link
            className={cn(base, "text-sage-text underline-offset-[6px] hover:underline")}
            href={alternates?.[candidate] ?? getLocaleRoutes(candidate).home}
            hrefLang={candidate}
            key={candidate}
            lang={candidate}
          >
            {nativeName}
          </Link>
        );
      })}
    </nav>
  );
}
