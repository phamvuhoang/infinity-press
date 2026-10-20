# S19: Book sale price — implementation plan

Spec: `docs/superpowers/specs/2026-10-18-s19-book-sale-price-design.md`. Branch:
`feat/s19-book-sale-price`. Each task ends green on its own checks and is one commit
(`feat(s19): ...`, `test(s19): ...`, `docs(s19): ...`).

Before you start:

- Read `docs/runbooks/testing-environments.md`.
- Use a scratch Supabase stack. Never use `.env.local` or the dev server on :3000, which point at
  the cloud project.
- Read the relevant guide in `node_modules/next/dist/docs/` before you edit a page or a server
  action.

## Task 1 — Schema and the effective-price function

1. Run `select pg_get_functiondef(...)` on the scratch stack and capture the live definitions of
   `catalog_book_cards`, `catalog_book_card_by_id`, `catalog_book_page` and `create_ebook_order`.
   Do not trust older migration files. Then list the dependencies of `catalog_book_cards`
   (`pg_depend` / `pg_rewrite`), so you know what a `drop function` would cascade to.
2. Write `supabase/migrations/20261018100000_s19_book_sale_price.sql`:
   - the columns and constraints from spec section 4;
   - the extended `grant update (...)` on `offers`;
   - `offer_effective_price_minor(public.offers)` from spec section 4.1. Revoke it from
     `public` and grant it to `anon` and `authenticated`. It reveals nothing a public catalog
     read does not.
3. Write the first half of `supabase/tests/070_s19_book_sale_price.sql`: the effective-price
   boundaries and every CHECK rejection (spec section 10).
4. Run `npm run db:reset && npm run db:test`.

## Task 2 — Order creation charges the sale price

1. In the same migration, re-create `create_ebook_order` from its live definition. The only change
   is that the offer select reads `public.offer_effective_price_minor(o)` into `v_price_minor`.
   Keep `for update of o`, so pass the row as `o`, not a subquery.
2. Add these tests:
   - a sale order snapshots the sale price into `orders.subtotal_minor`, `total_minor`,
     `order_items.unit_price_minor` and `payments.amount_minor`;
   - a pending order booked before the sale started is cancelled and replaced at the sale price,
     and its coupon reservation is released;
   - a percent coupon discounts the sale price;
   - a fixed coupon at or above the sale price completes the order as `free_order`;
   - (spec 9.1) a pending manual order with a `manual_transfer_claims` row survives a price change:
     **Buy** returns the same order id at the old price, while an unclaimed one is still replaced.
2a. In the same `create_ebook_order`, add `and not exists (select 1 from
   public.manual_transfer_claims c where c.order_id = o.id)` to the price/currency half of all three
   staleness predicates (payments, coupon release, orders), not to the provider half.
3. Run `npm run db:test`.

## Task 3 — Catalog reads expose the sale

1. Re-create `catalog_book_cards` and `catalog_book_card_by_id` with the offer lateral from spec
   section 5:

   ```sql
   select public.offer_effective_price_minor(o) as price_minor, o.currency,
          case when public.offer_effective_price_minor(o) < o.price_minor then o.price_minor end as list_price_minor,
          case when public.offer_effective_price_minor(o) < o.price_minor then o.sale_ends_at end as sale_ends_at
   ...
   order by public.offer_effective_price_minor(o), o.currency
   ```

   Use `drop` and `create` if the return type changes, then re-issue the grants and the
   dependents. (`catalog_book_page` carries no offer; the page takes it from the card.)
2. Regenerate `lib/supabase/database.types.ts`. Extend `CatalogBookCard["offer"]` in
   `lib/catalog/public-types.ts` with `listPriceMinor` and `saleEndsAt`, and map them in
   `lib/data/catalog.ts`.
3. Grep every render and logic site of `offer.priceMinor`: `book-card.tsx`, `book-action.ts`,
   `browse.ts`, `json-ld.ts`, the home page and the book page. Confirm that each one wants the
   effective price. All of them should; note any exception in the commit.
4. Add a catalog read test to the pgTAP file (spec section 10). Update the hand-built catalog
   fixtures in the vitest files that construct an `offer`, setting the new fields to `null`.
5. Run `npm run db:test && npm run check`.

## Task 4 — Strike-through price on the storefront

1. Change `components/catalog/price-label.tsx` as in spec section 6. Make `book-card.tsx` render
   through it, or give it the same branch if it does not already.
2. Add the `salePrice` and `listPrice` keys to the `vi` and `en` dictionaries under `catalog.book`.
3. Add a vitest for `PriceLabel`: sale output, no-sale output, free output, and the hidden labels.
4. Check the book page, the home hero and a card at 375 px width. The two prices must wrap
   cleanly, with no horizontal scroll.
5. Run `npm run check`, including `check:prerender`. A display change must not make a route
   dynamic.

## Task 5 — JSON-LD and llms.txt

1. In `offerSchema` (`lib/seo/json-ld.ts`), when `offer.listPriceMinor !== null`, add
   `priceSpecification` (the sale `UnitPriceSpecification` and the `StrikethroughPrice` one) and,
   if there is a `saleEndsAt`, `priceValidUntil` as its UTC date. Extend the existing
   `page.test.tsx` and `json-ld` tests.
2. Add an optional `price?: string` to `LlmsEntry` and render it in `buildLlmsText`. Build the
   string in `app/llms.txt/route.ts` from the card offer with `formatPrice`: the sale price, then
   the list price and the end date in the section's locale, or the dictionary's free word. Add the
   `llms` dictionary keys. Extend `app/llms.txt/route.test.ts`.
3. Run `npm run check`.

## Task 6 — Admin sale controls

1. Extend `offerSchema` in `lib/catalog/schemas.ts` with `saleKind`, `salePercentOff`,
   `saleAmountOffMinor`, `saleStartsAt` and `saleEndsAt`. Mirror every CHECK, and when the kind is
   none, null all five fields. Add unit tests for each refusal.
2. Read the new fields in `updateOfferAction` (`app/admin/books/[bookId]/editor-actions.ts`). Reuse
   the coupon editor's UTC date parsing; do not write a second parser. Write them in `updateOffer`
   (`lib/data/books.ts`). Map a CHECK violation (`23514`) to a field error through the existing
   `knownFailure` path.
3. Add the Sale group to `components/admin/book-editor/edition-offer-forms.tsx`, with "(UTC)"
   labels and the read-only state line from spec section 8. The line reads the effective price
   through a select that calls `offer_effective_price_minor`.
4. Confirm that `revalidateBookAdmin(bookId)` still runs after a save. It does today.
5. Run `npm run check`.

## Task 7 — End to end and runbook

1. Write `e2e/book-sale.spec.ts` for the default simulator project:
   - an admin sets a 30% sale;
   - after `e2e/support/revalidate.ts`, `request.get` of the book page shows both prices in the
     HTML and the sale price in the JSON-LD;
   - a reader buys, and checkout and the simulator show the sale price;
   - the admin clears the sale, and the next **Buy** shows the list price.
2. Write `docs/runbooks/book-sale.md`, covering:
   - how to set, schedule and clear a sale;
   - that times are in UTC;
   - the 5-minute storefront lag at a scheduled boundary, while checkout is exact;
   - that a coupon stacks on the sale price;
   - that a pending order reprices on the next **Buy**;
   - the SePay `paid a cancelled order` case.
   Link it from `checkout.md` and `coupons.md`.
3. Run `npm run check:full` on the scratch stack (Node 22.14, scratch stack `s14-sb`, server on
   :3100).

## Deferred, by the spec

These are deferred, and none blocks merge:

- bundle sales;
- a discount badge or countdown;
- revalidation exactly at a sale boundary;
- `order_items.list_price_minor`.
