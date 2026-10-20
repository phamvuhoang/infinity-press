# S19: Book sale price — design

Status: draft, 2026-10-18.

## 1. Goal

An admin can put a single book on sale, either a percentage off or a fixed amount off, the same two
kinds a coupon offers. While the sale runs:

- every storefront surface shows the sale price, with the list price smaller and struck through;
- every payment path charges the sale price: a new order snapshots it, a coupon discounts it, and
  SePay, the manual transfer and the simulator collect it;
- crawlers and LLMs see the sale price: the book's JSON-LD `Offer` and `llms.txt` carry it.

## 2. Non-goals

- **Bundles.** A bundle is priced as its own product (S9 spec 6.1). The new columns are rejected on
  a bundle offer by a CHECK constraint. Add bundle sales when someone asks for them.
- **Catalog-wide or per-topic sales.** One sale per book offer. A site-wide promotion is a coupon
  with an empty scope (`coupons.md` section 2).
- **A sale that makes a book free.** The sale price is always at least 1 minor unit, so the free
  path (`acquire_free_ebook`, `entitlement_source = free_offer`) never sees a sale. A free
  giveaway stays either `price_minor = 0` or a 100% coupon.
- **Stacking rules.** A coupon always applies on top of the sale price. Nothing turns that off.
- **A list-price snapshot on the order.** Checkout keeps showing the order's own snapshot (spec S3
  4.3). That snapshot is the sale price. The struck-through list price appears on the storefront,
  not in checkout. Add `order_items.list_price_minor` if reporting needs it.

## 3. The core decision: `priceMinor` keeps meaning "what you pay now"

`offers.price_minor` stays the **list price**. The sale lives in new columns on the same row. One
SQL function computes the effective price. Every reader that sells or displays a price calls it.

On the wire, `CatalogBookCard.offer.priceMinor` becomes the **effective** price. It gets two new
fields:

```ts
offer: {
  priceMinor: number;            // what a buyer pays now: the sale price while a sale runs, else the list price
  currency: string;
  listPriceMinor: number | null; // the list price, only while a sale runs
  saleEndsAt: string | null;     // ISO timestamp, only while a sale with an end runs
} | null
```

Keeping `priceMinor` as the paid amount makes every existing consumer correct with no edit:
`resolveBookAction`, the free and paid browse filter, the price sort, the bundle "you save" maths
(which reads list prices from its own query and is not touched), and the JSON-LD `price`. Only the
code that renders the struck-through list price needs to know a sale exists.

The alternative is a "compare-at" price. In that model the admin types the sale price into
`price_minor` and the old price into a second column. It changes nothing on the read side. But it
cannot end a sale on schedule, and a percentage would be frozen to a stale amount after a list-price
edit. It is not chosen.

## 4. Data model

New migration, `supabase/migrations/20261018100000_s19_book_sale_price.sql`:

```sql
alter table public.offers
  add column sale_kind text check (sale_kind in ('percent', 'fixed')),
  add column sale_percent_off integer check (sale_percent_off between 1 and 99),
  add column sale_amount_off_minor bigint check (sale_amount_off_minor > 0),
  add column sale_starts_at timestamptz,
  add column sale_ends_at timestamptz,
  add constraint offers_sale_shape check (
    (sale_kind is null and sale_percent_off is null and sale_amount_off_minor is null
       and sale_starts_at is null and sale_ends_at is null)
    or (sale_kind = 'percent' and sale_percent_off is not null and sale_amount_off_minor is null)
    or (sale_kind = 'fixed' and sale_amount_off_minor is not null and sale_percent_off is null
        and sale_amount_off_minor < price_minor)
  ),
  add constraint offers_sale_needs_price check (sale_kind is null or price_minor > 0),
  add constraint offers_sale_books_only check (sale_kind is null or bundle_id is null),
  add constraint offers_sale_window check (sale_ends_at is null or sale_starts_at is null or sale_ends_at > sale_starts_at);
```

`sale_amount_off_minor < price_minor` is a row CHECK, so the constraint also refuses a later
list-price cut that would push a fixed sale to zero or below. The admin then sees the constraint
error and must lower the sale first. That is intended: a sale must never silently turn a book free.

The column grant `grant update (...) on public.offers to authenticated` (admin RLS, migration
`20260913100000`) gains the five new columns, so the existing `updateOffer` path writes them.

### 4.1 The effective price

```sql
create function public.offer_effective_price_minor(o public.offers)
returns bigint language sql stable set search_path = '' as $$
  select case
    when o.sale_kind is null
      or (o.sale_starts_at is not null and o.sale_starts_at > now())
      or (o.sale_ends_at is not null and o.sale_ends_at <= now())
      then o.price_minor
    when o.sale_kind = 'percent'
      -- Floored, like a coupon (lib/commerce/coupon.ts): a discount never rounds up into the house's money.
      then o.price_minor - (o.price_minor * o.sale_percent_off) / 100
    else o.price_minor - o.sale_amount_off_minor
  end;
$$;
```

The window is half-open, `[sale_starts_at, sale_ends_at)`, the same convention `offers.starts_at`
and `ends_at` already use. Both bounds are optional: no start means "from now", and no end means
"until an admin removes it". Times are stored and entered in UTC, as coupons are (`coupons.md`
section 3).

This is the only function that knows the sale arithmetic. Nothing in TypeScript recomputes it.
`lib/commerce/coupon.ts` mirrors SQL only because the checkout previews a discount. No screen
previews a sale before it is saved.

## 5. Readers that change

These are the latest definitions that read `offers.price_minor` (found by scanning the latest
`create function` of each name in `supabase/migrations/`). Each is re-created in the S19 migration.

| Function | Change |
| --- | --- |
| `catalog_book_cards` | The offer lateral selects the effective price as `price_minor`, the list price as `list_price_minor` (null when no sale runs), and `sale_ends_at`. Orders by the effective price. |
| `catalog_book_card_by_id` | Same offer lateral. It is a copy of `catalog_book_cards` filtered to one id, so keep the two identical. |
| `catalog_book_page` | **No change.** It carries no offer; `getBookPage` merges it with the book's card, and search maps its hits to cards too. |
| `create_ebook_order` | `v_price_minor := public.offer_effective_price_minor(o)`. Nothing else changes. |
| `acquire_free_ebook` | **No change.** A sale never reaches price 0 (section 4). |
| `admin_create_book`, `admin_create_ebook` | **No change.** They create an offer without a sale. |
| bundle functions | **No change.** Bundle offers cannot carry a sale. |

If `catalog_book_cards` uses `returns table (...)`, adding output columns needs `drop function` and
`create function`. Re-issue its grants afterwards, and re-create anything that depends on it. Check
the dependencies with `pg_depend` before writing the migration. Then update
`lib/supabase/database.types.ts`.

### 5.1 Why coupons and SePay need no code change

`create_ebook_order` writes the effective price into `orders.subtotal_minor`,
`orders.total_minor`, `order_items.unit_price_minor` and `payments.amount_minor`. Downstream code
reads only these columns:

- `apply_coupon_to_order` discounts `subtotal_minor`, so a coupon discounts the sale price. A
  percent coupon takes its percentage of the sale price. A fixed coupon at or above the sale price
  clamps to zero and completes the order as a free order, which is existing behaviour.
- SePay builds its checkout from `total_minor`, and its invoice number already encodes the amount
  (`lib/commerce/sepay.ts`). The manual transfer page and the simulator show `total_minor`.
- Gifts are an order from `create_ebook_order` with a gift attached, so they inherit the sale.

### 5.2 Sale boundaries and pending orders

`create_ebook_order` already cancels a pending order whose `subtotal_minor` differs from the
current price, and books a fresh one (S3 spec 4.3). When a sale starts or ends, the reader's next
**Buy** therefore reprices the order. No new code is needed for this, and the reader always pays
what the page shows.

What this means for a reader who is mid-payment when the sale ends:

- **SePay:** the old QR is still payable. If the reader pays it after **Buy** cancelled the order,
  the existing `paid a cancelled order` path flags it for manual resolution (`sepay-payment.md`).
  If the reader does not click **Buy** again, the old pending order settles at the sale price.
  That is acceptable: the reader started paying during the sale.
- **Manual transfer:** an order whose transfer the reader has already reported (a
  `manual_transfer_claims` row) is **kept** across a price change, so it is not cancelled. See
  section 9.

## 6. Storefront display

`PriceLabel` (`components/catalog/price-label.tsx`) is the one place that renders a book price for
the home page, the book page, and `book-card.tsx`. It changes as follows:

```tsx
{offer.listPriceMinor !== null ? (
  <>
    <span className="sr-only">{copy.salePrice}</span>
    {formatPrice(offer.priceMinor, ...)}
    <del className="ml-2 text-[0.6em] text-muted">
      <span className="sr-only">{copy.listPrice}</span>
      {formatPrice(offer.listPriceMinor, ...)}
    </del>
  </>
) : /* today's output */}
```

- The list price is smaller (about 0.6em of the label's own size, so it scales on the book page and
  on cards) and struck through with a semantic `<del>`.
- Screen readers do not announce `<del>` reliably. Visually hidden labels ("Giá khuyến mãi" and
  "Giá gốc" in Vietnamese, "Sale price" and "List price" in English) carry the meaning, using new
  keys in both dictionaries.
- There is no "-30%" badge and no countdown. Add them if marketing asks.
- `book-card.tsx` must render through `PriceLabel`, or get the same branch. The plan checks every
  render site of `offer.priceMinor`.

## 7. SEO and LLMO

### 7.1 JSON-LD (`lib/seo/json-ld.ts`, `offerSchema`)

`price` is already `offer.priceMinor`, so it becomes the sale price with no edit. While a sale
runs, the `Offer` gains these properties:

```json
{
  "price": 89000,
  "priceCurrency": "VND",
  "priceValidUntil": "2026-11-01",
  "priceSpecification": [
    { "@type": "UnitPriceSpecification", "price": 89000, "priceCurrency": "VND" },
    { "@type": "UnitPriceSpecification", "priceType": "https://schema.org/StrikethroughPrice",
      "price": 129000, "priceCurrency": "VND" }
  ]
}
```

- `priceValidUntil` is set only when the sale has an end. It is a date (`YYYY-MM-DD`, UTC) and is
  the last UTC day the sale applies (an end at 00:00 UTC gives the day before).
- `StrikethroughPrice` is the schema Google reads for a "was" price in rich results. It is a hint:
  Google decides whether to show the strike-through, and the site does not control that.
- The paperback `Offer`s (S14) are untouched.

### 7.2 `llms.txt` (`app/llms.txt/route.ts`, `lib/seo/llms.ts`)

Book entries carry no price today. Add an optional `price` to `LlmsEntry` for book entries, rendered
after the title. Examples:

- Vietnamese: `(89.000 ₫, giá gốc 129.000 ₫, đến 2026-10-31)` after the link
- English: `(₫89,000, list price ₫129,000, until 2026-10-31)`; the date is ISO in both locales, the last UTC day the sale applies

Format the price with `formatPrice` in the section's locale. A free book renders the dictionary's
"free" word. A book with no offer gets no price.

### 7.3 Freshness

Book pages, the home page, `llms.txt` and the sitemap are prerendered with `revalidate = 300`, and
an admin save calls `revalidateStorefront()`. A sale that **starts or ends on schedule** has no
save, so these surfaces can show the old state for up to 5 minutes, plus one stale-while-revalidate
render. Checkout is not affected, because `create_ebook_order` reads `now()` and the reader pays the
order's snapshot. This lag is accepted and documented in the runbook. A scheduled revalidation at
the boundary (a cron hitting `POST /api/operations/revalidate-storefront`) is the upgrade path if
5 minutes becomes too long.

## 8. Admin

The book editor's offer form (`components/admin/book-editor/edition-offer-forms.tsx`, saved by
`updateOfferAction` and then `updateOffer`) gains a **Sale** group:

- **Kind:** none, percent off, or amount off. Choosing none clears all five columns.
- **Percentage off** (1–99) or **Amount off** (minor units, below the list price).
- **Starts (UTC)** and **Ends (UTC)**, both optional, with the same "(UTC)" label convention as the
  coupon editor.
- After a save, a read-only line shows the state: `Current price: 89.000 ₫ (sale running until
  2026-11-01 00:00 UTC)`, `scheduled from ...`, `ended`, or `no sale`. It is computed by
  `offer_effective_price_minor`, so admin and storefront cannot disagree.

Validation runs twice. The Zod `offerSchema` mirrors the CHECK constraints (section 4) for friendly
field errors, and the database is the authority. A sale's value can be edited freely at any time,
because orders snapshot their price and a past order never changes. That is unlike coupons, which
freeze the value after first use.

## 9. Decisions

1. **A reported transfer keeps its price.** Before S19, any price change made the reader's next
   **Buy** cancel a pending order, even one whose transfer the reader had already reported. That
   threw away a payment the reader said was sent. A sale boundary would make this happen on a
   timer. Decided 2026-10-18: in `create_ebook_order`, the price-and-currency staleness test skips
   an order that has a `manual_transfer_claims` row. The function then returns that order, and the
   reader lands back on its review state at the price they transferred. The admin confirms it as
   usual. A provider switch still cancels such an order, as before, because that is a separate rule
   with its own reason (S7). This also fixes the same defect for an admin price edit.
2. **Rounding for VND.** A percentage of 129.000 ₫ gives an awkward 90.300 ₫. Use a fixed amount
   for a round price. Rounding the sale price to the nearest 1.000 ₫ is possible but is not
   proposed.

## 10. Testing

- **pgTAP** (`supabase/tests/070_s19_book_sale_price.sql`):
  - effective price for percent and fixed sales, before, inside and after the window, and at the
    exact boundaries;
  - every CHECK constraint rejects its case (a bundle sale, a fixed amount ≥ the price, a sale on a
    free book, a reversed window, a half-filled shape);
  - `create_ebook_order` snapshots the sale price into the order, the item and the payment;
  - a pending order booked before the sale starts is cancelled and replaced at the sale price;
  - a pending manual order with a reported transfer survives a price change (section 9.1);
  - `apply_coupon_to_order` with a percent coupon and with a covering fixed coupon on a sale order;
  - `catalog_book_cards` returns the effective price, `list_price_minor` and `sale_ends_at`, and
    sorts by the effective price.
- **Vitest:**
  - `PriceLabel` sale and no-sale output, including the hidden labels;
  - `offerSchema` JSON-LD with a running sale, with and without an end, and without a sale;
  - `buildLlmsText` price rendering in both locales;
  - admin `offerSchema` validation.
- **Playwright** (`e2e/book-sale.spec.ts`, default simulator project): an admin sets a 30% sale; the
  raw book page HTML (`request.get`) shows both prices and the JSON-LD sale price; the reader buys,
  and checkout and the simulator show the sale price.
- **Runbook:** `docs/runbooks/book-sale.md`, linked from `checkout.md` and `coupons.md`.
