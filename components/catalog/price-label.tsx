import { formatPrice } from "@/lib/catalog/price";
import type { CatalogBookCard } from "@/lib/catalog/public-types";
import type { Dictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";

export function PriceLabel({
  offer,
  locale,
  copy,
  className,
}: {
  offer: CatalogBookCard["offer"];
  locale: Locale;
  copy: Dictionary["catalog"]["book"];
  className?: string;
}) {
  if (!offer) return null;
  if (offer.listPriceMinor === null) {
    return <span className={className}>{offer.priceMinor === 0 ? copy.free : formatPrice(offer.priceMinor, offer.currency, locale)}</span>;
  }
  // A running sale (S19): the price paid now, then the list price smaller and struck through. A
  // screen reader does not reliably announce <del>, so both prices carry a hidden label.
  return (
    <span className={className}>
      <span className="sr-only">{copy.salePrice}: </span>
      {formatPrice(offer.priceMinor, offer.currency, locale)}
      <del className="ml-2 text-[0.65em] font-normal text-ink-soft">
        <span className="sr-only">{copy.listPrice}: </span>
        {formatPrice(offer.listPriceMinor, offer.currency, locale)}
      </del>
    </span>
  );
}
