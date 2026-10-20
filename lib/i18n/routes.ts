import type { CatalogEntityKind } from "@/lib/catalog/public-types";
import { type Locale, withLocale } from "@/lib/i18n/config";

export function getLocaleRoutes(locale: Locale) {
  return {
    account: withLocale(locale, "/account"),
    books: withLocale(locale, "/books"),
    home: withLocale(locale, "/"),
    library: withLocale(locale, "/library"),
    myQuotes: withLocale(locale, "/library/quotes"),
    orders: withLocale(locale, "/account/orders"),
    search: withLocale(locale, "/search"),
    signIn: withLocale(locale, "/sign-in"),
  };
}

const entitySegments: Record<CatalogEntityKind, string> = { author: "authors", series: "series", topic: "topics" };

export function getCatalogRoutes(locale: Locale) {
  return {
    book: (slug: string) => withLocale(locale, `/books/${slug}`),
    bundle: (slug: string) => withLocale(locale, `/bundles/${slug}`),
    entity: (kind: CatalogEntityKind, slug: string) => withLocale(locale, `/${entitySegments[kind]}/${slug}`),
    sample: (slug: string) => withLocale(locale, `/read-sample/${slug}`),
    // S16: a shared quote card. Public, noindex, not localized by the viewer's locale: the card
    // renders in the locale the quote was shared in.
    quoteCard: (code: string) => withLocale(locale, `/q/${encodeURIComponent(code)}`),
    // Legacy deep link: resolves to an edition the reader owns (redirect or chooser), never by the
    // interface locale. Prefer readEdition wherever the edition is known.
    read: (bookId: string) => withLocale(locale, `/read/${bookId}`),
    readEdition: (editionId: string) => withLocale(locale, `/read/editions/${editionId}`),
    // Translation error report for an edition the reader owns.
    reportError: (editionId: string) => withLocale(locale, `/library/report/${editionId}`),
    // S13 reader voice: the review form is a library page; ask-the-author is prefilled by query.
    // A reader holding several editions of a work names the one they are reviewing.
    review: (bookId: string, editionId?: string) =>
      `${withLocale(locale, `/library/reviews/${bookId}`)}${editionId ? `?${new URLSearchParams({ edition: editionId })}` : ""}`,
    ask: (target: { book: string } | { idea: string }) => `${withLocale(locale, "/ask")}?${new URLSearchParams(target)}`,
    signInFor: (path: string) => `${withLocale(locale, "/sign-in")}?${new URLSearchParams({ next: path })}`,
  };
}

// S12 knowledge hub. Ideas and articles have their own path segments, so a slug only has to be
// unique within its entity type and locale.
export function getKnowledgeRoutes(locale: Locale) {
  return {
    ideas: withLocale(locale, "/ideas"),
    idea: (slug: string) => withLocale(locale, `/ideas/${slug}`),
    articles: withLocale(locale, "/articles"),
    article: (slug: string) => withLocale(locale, `/articles/${slug}`),
  };
}

export function getCommerceRoutes(locale: Locale) {
  return {
    checkout: (orderId: string) => withLocale(locale, `/checkout/${orderId}`),
    checkoutSimulate: (orderId: string) => withLocale(locale, `/checkout/${orderId}/simulate`),
    checkoutTransfer: (orderId: string) => withLocale(locale, `/checkout/${orderId}/transfer`),
    checkoutStatus: (orderId: string) => withLocale(locale, `/checkout/${orderId}/status`),
    order: (orderId: string) => withLocale(locale, `/account/orders/${orderId}`),
    bookActionError: (slug: string, code: string) =>
      `${withLocale(locale, `/books/${slug}`)}?${new URLSearchParams({ "action-error": code })}`,
    bundleActionError: (slug: string, code: string) =>
      `${withLocale(locale, `/bundles/${slug}`)}?${new URLSearchParams({ "action-error": code })}`,
    // The gift claim link (S9 spec 7.3). Relative, because it is persisted in the gift's outbox
    // payload at configuration time and read back whenever the message is sent or re-sent - an
    // absolute URL stored then would pin the link to whatever origin the app happened to have.
    // The token is base64url and so already path-safe; it is encoded anyway, because the one
    // place a token must never be is somewhere a stray character can change what the path means.
    giftClaim: (token: string) => withLocale(locale, `/gifts/claim/${encodeURIComponent(token)}`),
  };
}
