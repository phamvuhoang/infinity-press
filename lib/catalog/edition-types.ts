import type { Locale } from "@/lib/i18n/config";

// Contracts shared by the edition-aware catalog, checkout, library and reader (plan section 2).
// An edition is the unit that is sold, owned and read; a work (book) groups editions.

export type Money = {
  // A decimal integer in the currency's minor unit, as a string: PostgreSQL bigint does not fit
  // every value in a JS number, and no code may divide every currency by 100 (see lib/commerce/money.ts).
  amountMinor: string;
  currency: string;
};

export type ResolvedEdition = {
  bookId: string;
  editionId: string;
  contentLanguage: string;
  metadataLocale: Locale;
  uiLocale: Locale;
  isContentFallback: boolean;
  activePublicationId: string;
  offer: { offerId: string; price: Money; canCheckout: boolean } | null;
};

export type ResolveEditionInput = {
  bookId: string;
  uiLocale: Locale;
  explicitEditionId?: string;
};

export type CreateEditionOrderInput = {
  editionId: string;
  offerId: string;
  locale: Locale;
  couponCode?: string;
};
