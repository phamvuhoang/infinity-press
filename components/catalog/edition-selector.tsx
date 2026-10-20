"use client";

import Link from "next/link";

import { PriceLabel } from "@/components/catalog/price-label";
import type { CatalogEditionOption } from "@/lib/catalog/public-types";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";

// Lists a work's readable editions. Choosing one changes the page's `?edition=`, never the interface
// language: switching the UI must not change what is being bought, and choosing an edition must not
// switch the UI. The default edition is the bare book URL.
export function EditionSelector({
  editions,
  selectedId,
  basePath,
  locale,
  copy,
}: {
  editions: CatalogEditionOption[];
  selectedId: string | null;
  basePath: string;
  locale: Locale;
  copy: Dictionary["catalog"];
}) {
  return (
    <nav aria-label={copy.editions.label} className="space-y-2">
      <p className="text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.editions.label}</p>
      <ul className="flex flex-wrap gap-3">
        {editions.map((edition) => {
          const selected = edition.editionId === selectedId;
          return (
            <li key={edition.editionId}>
              <Link
                aria-current={selected ? "true" : undefined}
                className={`inline-flex min-h-11 flex-col justify-center border px-4 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest ${
                  selected ? "border-forest bg-white" : "border-sand hover:border-forest"
                }`}
                href={edition.isDefault ? basePath : `${basePath}?edition=${edition.editionId}`}
                replace
                scroll={false}
              >
                <span className="font-medium">{editionLanguageLabel(edition.languageCode)}</span>
                <span className="text-xs text-sage-text">
                  {edition.offer ? (
                    <PriceLabel copy={copy.book} locale={locale} offer={edition.offer} />
                  ) : (
                    copy.editions.notOnSale
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
