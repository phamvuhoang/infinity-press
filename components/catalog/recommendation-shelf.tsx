import { BookCard } from "@/components/catalog/book-card";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";

const SHELF_LIMIT = 6;

// A deterministic recommendation shelf. No client JavaScript: the horizontal scroll is native
// overflow, and every card is the ordinary BookCard so cover ratio, links, and price copy stay
// identical to the grid.
export function RecommendationShelf({
  books,
  heading,
  headingId,
  locale,
  copy,
}: {
  books: CatalogBookCard[];
  heading: string;
  headingId: string;
  locale: Locale;
  copy: Dictionary["catalog"]["book"];
}) {
  const shown = books.slice(0, SHELF_LIMIT);
  if (shown.length === 0) return null;

  return (
    // The section carries its own top spacing, not a parent wrapper, so a caller that renders it
    // unconditionally never reserves space when it returns null.
    <section aria-labelledby={headingId} className="mt-14">
      <h2 className="font-serif text-xl text-ink" id={headingId}>
        {heading}
      </h2>
      <ul className="mt-4 flex gap-6 overflow-x-auto scroll-pl-4 pb-2 px-4 -mx-4 snap-x">
        {shown.map((book) => (
          <li className="w-40 shrink-0 snap-start sm:w-48" key={book.bookId}>
            <BookCard card={book} copy={copy} locale={locale} />
          </li>
        ))}
      </ul>
    </section>
  );
}
