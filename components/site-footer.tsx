import { Logo } from "@/components/brand/logo";
import { type Locale, withLocale } from "@/lib/i18n/config";

// Board 1e's footer, reduced to what exists today: the wordmark, the tagline, and the imprint.
export function SiteFooter({ locale, tagline }: { locale: Locale; tagline: string }) {
  return (
    <footer className="border-t border-hairline">
      <div className="mx-auto flex max-w-[90rem] flex-col gap-4 px-4 py-10 sm:flex-row sm:items-end sm:justify-between sm:px-8 lg:px-16">
        <div className="space-y-3">
          <Logo href={withLocale(locale, "/")} size="sm" />
          <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{tagline}</p>
        </div>
        <p className="text-[0.8125rem] text-sage-text">© {new Date().getFullYear()} Infinity Books</p>
      </div>
    </footer>
  );
}
