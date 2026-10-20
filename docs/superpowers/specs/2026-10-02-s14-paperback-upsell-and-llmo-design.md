# S14 Paperback Upsell and LLMO Design

**Status:** Approved
**Date:** 2026-10-02
**Roadmap:** PRD 3.2 book detail (commerce block), 5.1 optional `llms.txt`, 16.2 SEO implementation
**Builds on:** S1 catalog admin, S2 public discovery, S5 SEO and operations, S12 knowledge hub
**Related:** S13 reader voice (reviews feed `aggregateRating` into the same Book JSON-LD)

## 1. Goal

The web shop sells only ebooks. Paper copies are sold on Shopee, Fahasa, Tiki and similar
marketplaces. A reader who lands on a book page must see both choices in one place: buy the ebook
here, or follow a link to buy the paperback where it is stocked. Search engines and AI answer engines
must see the same two choices as machine-readable offers.

The second half of S14 is the cheap LLMO work the PRD left optional: an `llms.txt` that lists the
canonical entity pages, and complete `author`/`dateModified` fields on the knowledge pages.

## 2. What S14 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/books/[slug]` | Reader | A "Paperback" block under the ebook CTA with one button per active retailer link |
| `/{locale}/books/[slug]` | Crawler | Book JSON-LD with an `offers` array: the ebook Offer plus one Offer per retailer, each with `seller`, `url`, and the paperback `itemOffered` |
| `/admin/books/[bookId]` | Editor | A "Paperback retailers" section: add, edit, reorder, deactivate links; optional list price |
| `/api/analytics/events` | Operator | A new `click_external_store` event with the book and the retailer, so the shop knows how much traffic it sends to each marketplace |
| `/llms.txt` | AI crawlers | A Markdown index of the site and every published book, author, series, topic, idea, and article URL for both locales |
| `/{locale}/ideas/[slug]`, `/{locale}/articles/[slug]` | Crawler | `Article` JSON-LD with `publisher`, `author`, `datePublished` and `dateModified` on both page kinds |

## 3. Out of Scope

- Selling paperbacks on the site, a cart, or shipping fields. The site remains ebook-only.
- Reading stock or price from a marketplace API. The list price is an optional editorial field.
- Affiliate tracking beyond UTM parameters. If a marketplace affiliate program is joined later, the
  affiliate URL is simply pasted as the link.
- A retailer directory entity. A link is a row on a book, nothing more.
- `llms-full.txt` with page bodies. The index points at HTML pages, which remain the source of truth.
- Changing `robots.ts`. `/llms.txt` is already allowed by the `/` rule.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Where links live | A new `book_retail_links` table, one row per (book, retailer link). Not a column on `books`, because a book can be on several marketplaces and each needs its own URL and order. |
| Retailer identity | A `retailer` text column constrained to `shopee`, `fahasa`, `tiki`, `other`. The public label is a dictionary string for the first three and a required free-text `label` for `other`. No retailer table. |
| URL safety | Only absolute `https://` URLs. Rendered with `rel="nofollow noopener sponsored"` and `target="_blank"`. UTM parameters are appended server-side at render time, never stored, so an editor can paste the plain marketplace URL. |
| Price | `price_minor` and `currency` are optional. When present they render under the button and enter the Offer; when absent the Offer carries no `price`. An Offer without a price is valid schema.org but does not qualify for merchant rich results, which is acceptable for a link that leaves the site. |
| Availability | Links are editorial. An active link renders `availability: InStock`. There is no out-of-stock state; an editor deactivates the link instead. |
| JSON-LD shape | Keep one `Book` node. `offers` becomes an array. The paperback Offer uses `itemOffered: { "@type": "Book", bookFormat: "https://schema.org/Paperback" }` so a consumer can tell the formats apart. No `isbn` on the paperback: the edition ISBN belongs to the ebook, and `seller: { "@type": "Organization", name }`. The ebook Offer gains `seller` = the site Organization and `itemOffered` with `bookFormat: EBook`. |
| Analytics | One new event, `click_external_store`, sent from the browser on click. The retailer goes in a new nullable `analytics_events.retailer` text column constrained to the same four values; there is still no free-form JSON property column. |
| `llms.txt` | A Route Handler at `app/llms.txt/route.ts`, Markdown, `text/plain; charset=utf-8`, built from the same loaders as `app/sitemap.ts`, revalidated by `revalidateStorefront()` alongside the sitemap. |
| Knowledge JSON-LD | Ideas have no author relation. Their `Article` node gets `author` = the site Organization and `publisher` = the site Organization, plus `datePublished` = idea `created_at`. Articles keep their Person author and gain `publisher`. Both already emit `dateModified`. The article page starts showing "Updated" under the byline when `updatedAt` is later than `publishedAt`, so visible content matches the data. |

## 5. Data Model

```
book_retail_links   id uuid pk
                    book_id uuid references books(id) on delete cascade
                    retailer text check (retailer in ('shopee','fahasa','tiki','other'))
                    label text            -- required when retailer = 'other', else null
                    url text check (url ~ '^https://[^\s]+$')
                    price_minor bigint check (price_minor is null or price_minor >= 0)
                    currency text check (currency is null or currency ~ '^[A-Z]{3}$')
                    position integer not null check (position > 0)
                    active boolean not null default true
                    created_at, updated_at
                    unique (book_id, position)
                    check ((retailer = 'other') = (label is not null))
                    check ((price_minor is null) = (currency is null))
```

RLS: anonymous and authenticated readers select rows whose book is `published` and whose link is
`active`; writes belong to the admin RPC path. The public read is still folded into the existing
`catalog_book_page` RPC as a `retailLinks` JSON array, so the book page keeps one round trip.

`analytics_events` gains `retailer text` with the same check, nullable, and the `event_name` check
constraint is replaced to include `click_external_store`.

## 6. Public Book Page

Directly below the price row and `ViewerBookAction`, when the book has at least one active link:

```
Sách giấy
Mua bản in tại:  [Shopee]  [Fahasa]  [Tiki]  [Nhà sách ABC]
                 129.000 ₫ (giá niêm yết)      ← only when the link has a price
```

- The block renders only on the server with the links already in `CatalogBookPage.retailLinks`.
- Each button is a client component `RetailLinkButton` that calls `sendAnalyticsEvent` with
  `{ eventName: "click_external_store", bookId, retailer, locale }` in `onClick` and lets the
  navigation proceed. No preventDefault, no redirect route: the beacon is fire-and-forget and a
  blocked beacon must never block the purchase.
- The href is the stored URL with `utm_source=infinitybooks`, `utm_medium=book_page`,
  `utm_campaign=paperback`, and `utm_content={locale}` appended by a pure helper
  `withRetailUtm(url, locale)`. If the stored URL already carries any `utm_*` parameter, the helper
  leaves it untouched, so an affiliate URL with its own tracking is not corrupted.
- The retailer label comes from `catalog.retail.labels.{shopee|fahasa|tiki}` in the dictionaries;
  `other` uses the stored `label`.

JSON-LD rules:

- `offers` is emitted as an array only when it would hold at least one Offer; a book with no ebook
  offer and no links emits no `offers` key, as today.
- The paperback Offer `url` is the UTM-decorated URL, the same the person clicks.
- The paperback `itemOffered` carries no `isbn`: the edition ISBN is the ebook's, and a paperback has a
  different one the catalog does not record. `CatalogBookPage` still gains `isbn: string | null`, emitted
  on the `Book` node itself, read from the ebook edition, because the catalog models one
  edition per language.

## 7. Admin

A new "Paperback retailers" section in `/admin/books/[bookId]` between "Edition & offer" and "Cover":

- A list of existing links in position order, each row editable inline: retailer select, label (shown
  only for `other`), URL, price, currency, active toggle, move up/down, delete.
- One Server Action `saveRetailLinksAction(bookId, state, formData)` that replaces the whole set
  through one RPC `admin_set_book_retail_links(p_book_id, p_links jsonb)`. Replacing the set is the
  same pattern as `admin_set_related_books`, keeps positions contiguous, and makes reordering a
  single write.
- The RPC validates every row in SQL (URL pattern, retailer enum, label/price pairing), writes one
  `audit_logs` row with `action = 'book.retail_links.set'`, and the action calls
  `revalidateBookAdmin(bookId)`.
- Readiness is unchanged. A book with no paperback links is a complete book.

## 8. `llms.txt`

```
# Infinity Books

> Sách và ebook của Phương Bùi về tỉnh biết, tình yêu, gia đình, tiền bạc và hành động. Đọc ebook
> ngay trên trình duyệt; sách giấy bán tại Shopee, Fahasa và Tiki.

## Books
- [Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?](https://.../vi/books/tai-sao-phai-doc-...): short description
- ...

## Authors
## Series
## Topics
## Ideas
## Articles

## English
- [Why Read When AI Knows Everything?](https://.../en/books/...): short description
...
```

- The Vietnamese section comes first, then one `## English` section with the same groups, because `vi`
  is the default locale and most content exists only in Vietnamese.
- Each line is `- [title](absolute url): one-line description` where the description is the book's
  `shortDescription`, the idea's `shortAnswer`, the article's `excerpt`, or nothing. Descriptions are
  truncated to 200 characters on a word boundary and have newlines collapsed.
- The header blurb is a dictionary string `llms.intro` per locale so it is editable without code.
- Private routes are never listed. The data comes from the published-only loaders already used by the
  sitemap, so the lists cannot disagree.
- `revalidate = 300`, the sitemap's value, and `revalidateStorefront()` adds `revalidatePath("/llms.txt")`.

## 9. Knowledge JSON-LD completion

`knowledgeArticleSchema` changes:

| Kind | Added |
| --- | --- |
| idea | `author: Organization`, `publisher: Organization`, `datePublished = createdAt` |
| article | `publisher: Organization` |

`KnowledgeIdeaPage` already carries `createdAt`. The `Organization` node reuses `organizationSchema`
without `@context`. The article page renders `Cập nhật {date}` after the byline when `updatedAt` is on
a later calendar day than `publishedAt`, so `dateModified` corresponds to something visible.

## 10. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | `withRetailUtm` appends UTM, preserves existing `utm_*`, rejects non-https; `bookSchema` emits an `offers` array with ebook and paperback Offers, omits `price` when absent, omits `offers` with nothing to offer, never puts `isbn` on a paperback Offer; `knowledgeArticleSchema` emits `author`, `publisher`, `datePublished`, `dateModified` for both kinds; `llms.txt` route lists every published entity for both locales from mocked loaders and truncates descriptions; dictionary key parity; `RetailLinkButton` sends the event on click and keeps the href; the browser event schema accepts `click_external_store` with a valid retailer and rejects an unknown one |
| pgTAP | Anonymous readers see only active links of published books; the URL, retailer, label, price pairing, and position constraints hold; `admin_set_book_retail_links` replaces the set, renumbers positions, refuses a non-admin, and writes one audit row; `catalog_book_page` returns `retailLinks` in position order; `analytics_events` accepts `click_external_store` with a retailer and rejects one with an unknown retailer |
| Playwright | Admin adds a Shopee link → book page shows the Paperback block with the UTM href → JSON-LD on the page contains two Offers; `/llms.txt` returns 200 text with the book URL |
| Runbook | `docs/runbooks/catalog-admin.md` gains a "Paperback retailers" section; `docs/runbooks/seo-and-operations.md` gains `/llms.txt` and the retail Offer shape |

## 11. Exit Criteria

- A book page with one or more active retail links shows the Paperback block with working outbound
  links that carry UTM parameters, and its JSON-LD `offers` array validates in the Schema.org validator.
- A book with no links renders exactly as before S14, byte-for-byte in JSON-LD apart from the new
  `seller`/`itemOffered` fields on the ebook Offer.
- Clicking a retailer button records one `click_external_store` row with the retailer, and the
  navigation happens even when the analytics endpoint is unreachable.
- `/llms.txt` returns within the storefront cache model and lists the same entity set as the sitemap.
- Idea and article JSON-LD carry `author`, `publisher`, `datePublished`, and `dateModified`.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
