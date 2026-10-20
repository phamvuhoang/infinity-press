import Link from "next/link";

import { CoverImage } from "@/components/catalog/cover-image";
import { PriceLabel } from "@/components/catalog/price-label";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes } from "@/lib/i18n/routes";

type CardCopy = Dictionary["catalog"]["book"];

// One link per card, named by the title. The author and price sit outside the link so the
// accessible name stays short.
export function BookCard({
  card,
  locale,
  copy,
  languageLabel,
}: {
  card: CatalogBookCard;
  locale: Locale;
  copy: CardCopy;
  // Overrides the language shown, where a card stands for a specific EDITION (a bundle member).
  languageLabel?: string;
}) {
  // Every card says which language the EPUB is actually in: the edition shown may not be the one in
  // the reader's interface language, and the price beside it is that edition's.
  const language = languageLabel ?? editionLanguageLabel(card.languageCode);
  return (
    <article className="flex flex-col gap-3">
      <Link
        className="group flex flex-col gap-3 outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
        href={getCatalogRoutes(locale).book(card.slug)}
      >
        <CoverImage card={card} decorative sizes="(min-width: 1024px) 14rem, (min-width: 640px) 30vw, 45vw" size="sm" />
        <span className="font-serif text-lg leading-snug text-ink group-hover:underline">{card.title}</span>
      </Link>
      <p className="text-sm text-ink-soft">{card.author.name}</p>
      {language ? <p className="text-xs tracking-[0.06em] text-sage-text uppercase">{language}</p> : null}
      <PriceLabel className="text-sm font-medium text-forest" copy={copy} locale={locale} offer={card.offer} />
    </article>
  );
}

export function BookGrid({
  books,
  locale,
  copy,
}: {
  books: (CatalogBookCard & { editionId?: string; languageLabel?: string })[];
  locale: Locale;
  copy: CardCopy;
}) {
  return (
    <ul className="grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {books.map((book) => (
        <li key={book.editionId ?? book.bookId}>
          <BookCard card={book} copy={copy} languageLabel={book.languageLabel} locale={locale} />
        </li>
      ))}
    </ul>
  );
}
