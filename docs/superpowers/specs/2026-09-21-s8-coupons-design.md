# S8 Coupons Design

**Status:** Approved
**Date:** 2026-09-21
**Roadmap:** PRD P1.3 growth commerce, coupon half
**Builds on:** S3 get and buy, S7 manual bank-transfer payment
**Followed by:** S9 bundles and gifts, S11 recommendation shelves

## 1. Goal

A reader enters a promotion code at checkout and pays less, or nothing. An operator creates and limits
those codes from the admin without a deployment.

The immediate operational need is a full-discount code: before payments go live, the owner hands
selected testers a 100% code so they walk the real purchase path and end in the reader.

## 2. What S8 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/checkout/[orderId]` | Reader | Subtotal, discount, total, a code field, and a remove control |
| A fully discounted order | Reader | Completes immediately and opens the reader, with no transfer step |
| `/admin/coupons` | Admin | Create, limit, scope, and deactivate codes; see reservations and redemptions |
| `audit_logs` | Admin | Every coupon change and every code that changed an order total |

## 3. Out of Scope

- Bundles, gift purchases, and referral codes. S9 owns bundles and gifts.
- Automatic or cart-level promotions. A discount applies only when a reader enters a code.
- Stacking. One order carries at most one coupon.
- Per-market or per-currency coupon variants beyond the fixed-amount currency match in §6.
- Coupon analytics dashboards. The redemption count on the admin list is the whole reporting surface.
- Refunding or re-issuing a code after an order completes.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Where a code applies | To an existing `pending` order, at checkout. No new draft or quote lifecycle. |
| Usage accounting | Applying a code reserves a redemption. Completion redeems it; removal or cancellation releases it. |
| Zero-total orders | Complete in the same transaction that applies the code, with `payment_status = not_required`. |
| Stacking | One coupon per order. |
| Fixed-amount currency | Must equal the order currency, or the code is invalid. No conversion. |
| Failure messages | One message for every invalid code, so codes cannot be enumerated by their error. |

## 5. Architecture

### 5.1 Why the code applies to a pending order

`create_ebook_order` already returns the caller's existing `pending` order rather than creating a
second one, and `/{locale}/checkout/[orderId]` is already the page where a reader commits. Applying a
coupon to that order needs no new lifecycle: it recalculates the order's own snapshot columns and the
pending `payments` row.

The alternative was a quote step before order creation, using the unused `draft` value in
`order_status`. It is conceptually tidier, but it adds a second order lifecycle to specify, secure,
and test in order to avoid abandoned `pending` orders, which already occur today and hold nothing.

### 5.2 Schema

```
coupons
- id uuid primary key
- code text not null unique          -- stored upper-case, normalized on write
- kind text not null check (kind in ('percent', 'fixed'))
- percent_off int check (percent_off between 1 and 100)
- amount_off_minor bigint check (amount_off_minor > 0)
- currency text check (currency ~ '^[A-Z]{3}$')
- starts_at timestamptz
- ends_at timestamptz
- active boolean not null default true
- max_redemptions int check (max_redemptions > 0)          -- null: unlimited
- max_redemptions_per_profile int not null default 1
- note text
- created_by uuid references profiles(id)
- created_at timestamptz not null default now()
```

A check constraint ties `kind` to its fields: `percent` requires `percent_off` and forbids
`amount_off_minor`/`currency`; `fixed` requires both `amount_off_minor` and `currency` and forbids
`percent_off`. The `else` branch fails closed.

```
coupon_books          (coupon_id, book_id) primary key
                      -- no rows for a coupon means it applies to every book

coupon_redemptions
- id uuid primary key
- coupon_id uuid not null references coupons(id)
- order_id uuid not null unique references orders(id)
- profile_id uuid not null references profiles(id)
- discount_minor bigint not null check (discount_minor >= 0)
- status text not null check (status in ('reserved', 'redeemed'))
- reserved_at timestamptz not null default now()
- redeemed_at timestamptz
```

`orders` gains `subtotal_minor bigint not null`, `discount_minor bigint not null default 0`, and
`coupon_id uuid references coupons(id)`, with a check that
`total_minor = subtotal_minor - discount_minor` and `discount_minor <= subtotal_minor`. The migration
backfills `subtotal_minor = total_minor` before adding the not-null constraint.

RLS: `coupons` and `coupon_books` are readable by nobody through the Data API — validation happens
inside a `security definer` RPC, so a reader never reads the coupon table and cannot enumerate codes.
`coupon_redemptions` is readable by admins and by the owning profile.

### 5.3 Reservation, not counting at payment

Counting a redemption only at completion loses a race: two readers apply the last remaining use of a
code and both transfer money, and the second one has to be refused after the money has arrived. There
is no decent way to handle that.

So applying a code reserves it. `apply_coupon_to_order` locks the coupon row (`for update`), counts
`reserved` plus `redeemed` rows against `max_redemptions`, counts the caller's own rows against
`max_redemptions_per_profile`, and inserts a `reserved` row. Removing the code, cancelling the order,
or an admin declining it with `outcome = 'cancel'` deletes the row. Completing the order flips it to
`redeemed`.

The consequence that matters: neither `apply_payment_event` nor `confirm_manual_payment` ever has to
refuse an order because of a coupon. They only flip a row that was already reserved.

### 5.4 The RPCs

```
apply_coupon_to_order(p_order_id uuid, p_code text)
  returns table (subtotal_minor bigint, discount_minor bigint, total_minor bigint,
                 order_status order_status, entitlement_id uuid)
```

Runs as the signed-in reader. It resolves the profile from `auth.uid()`, locks the order, and refuses
unless the order belongs to the caller and is `pending` with no coupon already applied. It normalizes
the code, resolves an active coupon inside its time window, checks `coupon_books` against the order's
book, checks both limits under the coupon row lock, computes the discount (§6), writes
`coupon_id`/`discount_minor`/`total_minor` on the order, and updates the pending `payments` row's
`amount_minor`.

When the resulting total is zero it completes the order in the same transaction: cancels the pending
`payments` row, sets `status = 'completed'` and `payment_status = 'not_required'`, inserts an
entitlement with `source_type = 'free_order'` and `source_order_id` set, inserts the `library_items`
row, and marks the reservation `redeemed`. It returns the new `entitlement_id` so the action can send
the reader straight to the reader.

```
remove_coupon_from_order(p_order_id uuid)
  returns table (subtotal_minor bigint, discount_minor bigint, total_minor bigint)
```

Refuses on any order that is not the caller's own `pending` order. It clears the order's coupon
columns, restores `total_minor` to `subtotal_minor`, restores the pending payment amount, and deletes
the reservation.

`apply_payment_event` gains one step in its success branch: flip this order's `coupon_redemptions` row
to `redeemed`. Its cancellation branch deletes the row. Both are no-ops when the order has no coupon.

### 5.5 Rate limiting

Codes are guessable, and a wrong code is an oracle. `apply_coupon_to_order` records failed attempts per
profile and refuses once a threshold within a time window is passed, reusing the quota pattern already
established in `20260916140000_s5_analytics_intake_quota.sql`. Every rejection — unknown code, expired,
wrong book, exhausted, wrong currency — returns the same error code and the same reader-facing message.
The specific reason is written to the server log with the request ID, never to the response.

## 6. Discount Calculation

`lib/commerce/coupon.ts` holds one pure function:

```ts
computeDiscountMinor(
  coupon: { kind: "percent"; percentOff: number }
        | { kind: "fixed"; amountOffMinor: number; currency: string },
  order: { subtotalMinor: number; currency: string },
): number;
```

- `percent`: `floor(subtotalMinor * percentOff / 100)`, so rounding never favours the discount.
- `fixed`: the coupon currency must equal the order currency, otherwise the coupon is invalid and the
  RPC rejects it before this function is reached.
- The result is clamped to `[0, subtotalMinor]`, so a fixed amount larger than the price yields a zero
  total rather than a negative one.

The same rules are implemented in SQL inside `apply_coupon_to_order`. A shared table of cases drives
both the Vitest suite and the pgTAP suite, the way `lib/commerce/order-state.ts` and its pgTAP mirror
already do.

## 7. Screens

### 7.1 Checkout

`/{locale}/checkout/[orderId]` shows subtotal, discount (when present, with the applied code), and
total. A code field posts to a Server Action that calls `requireUser()` and then
`apply_coupon_to_order`. When the RPC returns a completed order, the action redirects to
`/{locale}/read/[bookId]`; otherwise it re-renders the checkout with the new total. A remove control
calls `remove_coupon_from_order`.

Both locales have copy for: applied, invalid, and rate-limited.

### 7.2 Admin

`/admin/coupons` lists codes with kind, value, window, active state, and reserved and redeemed counts.
The editor sets every field in §5.2 plus the book scope. A coupon that already has a reservation or a
redemption can be deactivated and can have its window shortened, but its kind and value are read-only —
changing the value of a code readers have already committed to would change an order snapshot. Every
create, edit, and deactivate writes one `audit_logs` row, as does every successful application of a
code to an order.

## 8. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | `computeDiscountMinor` across percent rounding, fixed larger than subtotal, and currency mismatch; code normalization; the checkout view model with and without a discount |
| pgTAP | Valid application; expired, not-yet-started, inactive, wrong-book, wrong-currency, and unknown codes each rejected with the same error; global limit reached; per-profile limit reached; two concurrent sessions applying the last remaining use leave exactly one reservation; removal and cancellation each release the reservation; a zero-total order completes with exactly one entitlement and one library item; applying a second coupon to an order is refused; reader B cannot apply or remove a coupon on reader A's order; a non-admin cannot read `coupons` |
| Playwright | Buy → apply a 100% code → land in the reader; buy → apply a 20% code → transfer page shows the reduced amount → admin confirms → reader opens |
| Runbook | `docs/runbooks/coupons.md`: issuing tester codes, scoping a code to a book, retiring a code, and reading the redemption counts |

## 9. Exit Criteria

- A 100% code takes a signed-in reader from the book page into the reader without a transfer step, and
  creates exactly one entitlement.
- A partial code reduces the amount shown on the S7 transfer page and the amount an admin confirms.
- The last remaining use of a code can be reserved by exactly one of two concurrent readers.
- No completed order can lose or change its coupon, and no coupon value can change once reserved.
- Repeated wrong codes are rate-limited, and every rejection is indistinguishable from the others.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
