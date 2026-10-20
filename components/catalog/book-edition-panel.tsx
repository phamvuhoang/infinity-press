"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { EditionSelector } from "@/components/catalog/edition-selector";
import { PriceLabel } from "@/components/catalog/price-label";
import { ViewerBookAction } from "@/components/catalog/viewer-book-action";
import { editionPublicAction, selectEdition } from "@/lib/catalog/edition-selection";
import type { CatalogEditionOption } from "@/lib/catalog/public-types";
import { editionLanguageLabel } from "@/lib/commerce/checkout-view";
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { fillTemplate } from "@/lib/i18n/format";

type PanelProps = {
  bookId: string;
  bookPath: string;
  locale: Locale;
  editions: CatalogEditionOption[];
  copy: Dictionary["catalog"];
  paymentsEnabled: boolean;
  // Bound by the page with locale, work and slug; the panel adds the edition, the offer and the price
  // the reader is looking at, so an order always names what was on screen.
  buyAction: (editionId: string, offerId: string, expectedMinor: number) => Promise<void>;
  getFreeAction: (editionId: string) => Promise<void>;
  // The UI language names the language the reader asked for; the default edition may be another one.
  fallbackNotice: boolean;
  // Whether the selector and `?edition=` are in play. False on pages that sell one fixed edition.
  selectable: boolean;
};

// The price, format and action for ONE edition. Everything here is per edition: the price, the
// language of the EPUB, whether the viewer owns it, and the order it starts.
function EditionView({ requested, ...props }: PanelProps & { requested: string | null }) {
  const { bookId, bookPath, locale, editions, copy, paymentsEnabled, buyAction, getFreeAction, fallbackNotice, selectable } = props;
  const selection = selectEdition(editions, requested);

  if (selection.status === "none") return <p className="text-sm text-ink-soft">{copy.actions.unavailable}</p>;

  const selector = selectable && editions.length > 1 ? (
    <EditionSelector
      basePath={bookPath}
      copy={copy}
      editions={editions}
      locale={locale}
      selectedId={selection.status === "selected" ? selection.edition.editionId : null}
    />
  ) : null;

  // A requested edition that is not one of this work's readable editions has no Buy button at all:
  // it never falls through to the default.
  if (selection.status === "invalid") {
    return (
      <div className="w-full space-y-4">
        <p className="text-sm text-ink-soft" role="status">{copy.editions.invalid}</p>
        {selector}
      </div>
    );
  }

  const edition = selection.edition;
  const language = editionLanguageLabel(edition.languageCode) ?? edition.languageCode;
  const offer = edition.offer;
  const publicAction = editionPublicAction(edition, paymentsEnabled);

  return (
    <div className="w-full space-y-5">
      {selector}
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="min-h-11 space-y-1">
          {offer ? (
            <PriceLabel className="block text-2xl font-medium text-ink" copy={copy.book} locale={locale} offer={offer} />
          ) : (
            <span className="block text-base text-ink-soft">{copy.editions.notOnSale}</span>
          )}
          <span className="block text-xs text-sage-text">{fillTemplate(copy.editions.ebookIn, { language })}</span>
          {fallbackNotice && edition.isDefault ? (
            <span className="block text-xs text-sage-text">
              {fillTemplate(copy.editions.fallbackNote, { requested: editionLanguageLabel(locale) ?? locale, language })}
            </span>
          ) : null}
        </div>
        <ViewerBookAction
          bookId={bookId}
          bookPath={bookPath}
          buyAction={offer ? buyAction.bind(null, edition.editionId, offer.offerId, offer.priceMinor) : async () => undefined}
          copy={copy.actions}
          editionId={edition.editionId}
          getFreeAction={getFreeAction.bind(null, edition.editionId)}
          locale={locale}
          publicAction={publicAction}
        />
      </div>
    </div>
  );
}

function QueryEditionView(props: PanelProps) {
  // Read in the browser, so the page itself stays prerendered and shared by every reader.
  return <EditionView {...props} requested={useSearchParams().get("edition")} />;
}

export function BookEditionPanel(props: PanelProps) {
  if (!props.selectable) return <EditionView {...props} requested={null} />;
  return (
    // The server-rendered fallback is the default edition, which is what a crawler and the first
    // paint see; the browser then applies `?edition=`.
    <Suspense fallback={<EditionView {...props} requested={null} />}>
      <QueryEditionView {...props} />
    </Suspense>
  );
}
