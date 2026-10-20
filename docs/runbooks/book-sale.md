# Runbook: book sale price

A sale lowers one book's price for everyone, with no code to type. It works like a coupon in
reverse: a coupon is a code a reader enters at checkout, while a sale is on the book itself and
every visitor sees it. Design: `docs/superpowers/specs/2026-10-18-s19-book-sale-price-design.md`.
For the order, see [get and buy](checkout.md). For codes that stack on top of a sale, see
[coupons](coupons.md).

## 1. Putting a book on sale

1. Open `/admin/books/<id>` and go to the **Offer** section, then its **Sale** group.
2. **Discount**: choose **Percent off** (1–99) or **Amount off** (minor units; VND has none, so
   `40000` is 40.000 ₫). Only the field that matches the kind is enabled; the other one is greyed
   out, ignored, and cleared on save. **No sale** greys out the times as well.
3. **Starts (UTC)** and **Ends (UTC)** are both optional. Blank Starts means the sale runs from the
   save. Blank Ends means it runs until you remove it. **These times are UTC, not Hanoi time.**
   Hanoi is 7 hours ahead, so a sale meant to end at midnight Hanoi time on 1 November is
   `2026-10-31 17:00`. This is the same rule as the coupon editor (`coupons.md` section 3).
4. **Save offer**. The line under the fields shows the state the database computes: `Sale running:
   buyers pay …`, `Sale scheduled from …`, `Sale ended`, or `No sale`.

The editor refuses three things, and the database refuses them again independently:

- a sale on a free book;
- a percentage of 100;
- an amount off that is at or above the list price.

A sale can never make a book free. For a giveaway, use price `0` or a 100% coupon.

A percentage is floored, as in a coupon: 30% of 129.000 ₫ is 90.300 ₫. If you want a round price,
use **Amount off** instead.

Bundles cannot have a sale. Their offer form has no **Sale** group, and the database rejects one.

## 2. Ending or changing a sale

Set **Discount** to **No sale** and save. This clears the value and both times. You can also edit
the value or the window at any time. Orders that are already completed never change, because each
order keeps the price it was created at.

A list-price edit that would leave a running **Amount off** sale at or above the new price is
refused. Lower the sale first, or switch it to a percentage.

## 3. What the reader and crawlers see

- **Storefront** (book page, home page, cards): the sale price, then the list price smaller and
  struck through.
- **Checkout, the simulator, the manual transfer page**: the sale price only.
  Checkout shows the order's snapshot, and that snapshot is the sale price.
- **JSON-LD**: `price` is the sale price. A `priceSpecification` carries the list price as a
  `StrikethroughPrice`. If the sale has an end, `priceValidUntil` is set to the last UTC day the
  sale applies. Google decides whether to show the strike-through; the site cannot force it.
- **`/llms.txt`**: each book line carries its price, for example
  `(90.300 ₫, giá gốc 129.000 ₫, đến 2026-10-31)`.

## 4. Coupons on top of a sale

A coupon always applies to the sale price, and nothing turns this off:

- a 20% code on a 90.300 ₫ sale charges 72.240 ₫;
- a fixed code at or above the sale price completes the order as a free order, exactly as it would
  on a list price.

## 5. Timing: what is exact and what can lag

- **Checkout is exact.** The order price is decided when the reader presses **Buy**, using the
  database clock.
- **The storefront can lag by about 5 minutes at a scheduled start or end.** Book pages, the home
  page, `llms.txt` and the sitemap are prerendered with `revalidate = 300`. A save in the editor
  refreshes them immediately. A start or end that arrives on schedule has no save behind it, so for
  a few minutes a page can still show the old price while checkout charges the new one. If you need
  the storefront to flip at the exact moment, call `POST /api/operations/revalidate-storefront` at
  that time (see [storefront caching](storefront-caching.md)).

## 6. Pending orders when the price changes

A reader with an unpaid order who presses **Buy** again after a sale starts or ends gets a new order
at the current price, and the old order is cancelled. If that old order held a coupon, the coupon's
reservation is released. This is the existing stale-order rule in `checkout.md`.

There are two cases where this needs care:

- **Manual transfer that the reader has already reported (pressed "I have transferred").** The order
  is kept, at the price the reader transferred. **Buy** takes them back to it, and you confirm it in
  `/admin/payments` as usual. This rule also applies when an admin edits the price.

## 7. Testing this locally

- Database: `supabase/tests/070_s19_book_sale_price.sql`.
- End to end: `e2e/book-sale.spec.ts`, in the default simulator project.

See [testing environments](testing-environments.md). Never run either against the cloud project.

Keep the request ID from any error. Server logs include it.
