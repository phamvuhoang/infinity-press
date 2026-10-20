# S9 Bundles and Gifts Design

**Status:** Approved
**Date:** 2026-09-21
**Roadmap:** PRD P1.3 growth commerce, bundle and gift half
**Builds on:** S3 get and buy, S7 manual bank-transfer payment, S8 coupons
**Followed by:** S11 recommendation shelves

## 1. Goal

A reader buys several books at one price, and a reader buys a book for somebody else.

Both break the assumption every order so far has relied on: that one order holds exactly one ebook for
exactly one buyer. S9 removes that assumption from the payment core once, and then builds the two
features on top of it.

## 2. What S9 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `/{locale}/bundles/[slug]` | Reader and crawler | A public bundle page with member books, one price, and one buy action |
| `/{locale}/checkout/[orderId]` | Reader | A gift option with recipient email and a message |
| `/{locale}/gifts/claim/[token]` | Recipient | Sign in, claim, and see what was added |
| `/{locale}/library` | Recipient | Every book from a bundle or a claimed gift |
| `/admin/bundles` | Admin | Create, order members, price, and publish bundles |
| `/admin/gifts` | Admin | Find a gift, resend it, or reissue an unclaimed one to another address |

## 3. Out of Scope

- A cart and quantity-based promotions such as "any three books". Bundles are curated sets with a
  fixed membership.
- Price adjustment for a buyer who already owns part of a bundle. The bundle price is the bundle price.
- Gift expiry, gift scheduling for a future date, and printable gift cards.
- Physical bundles and mixed digital/physical bundles. S10 owns physical.
- Reassigning a claimed gift, and buyer self-service revocation. Both go through an admin.
- Series-priced or automatically generated bundles.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Multi-line orders | `apply_payment_event` grants one entitlement per order item. This is a core change, done first. |
| Bundle modelling | A first-class entity with localizations, a slug, a cover, and a public page. Not a synthetic SKU. |
| Bundle pricing | `offers` gains a nullable `bundle_id`; exactly one of `sku_id` and `bundle_id` is set. |
| Partial ownership | Buying a bundle you partly own is allowed at the full price, and grants only the missing books. |
| Gift level | A gift is a property of an order, so a gift works identically for a single book and a bundle. |
| Gift delivery | An emailed claim link to the recipient. The raw token exists only in the email and the URL. |
| Gift expiry | None. An unclaimed gift can be reissued by an admin. |

## 5. The Core Change: Orders With Several Items

`apply_payment_event` currently resolves the purchased book with
`select oi.book_id from order_items oi where oi.order_id = p_order_id limit 1` and inserts one
entitlement. A new migration drops and recreates it so that its success branch iterates every
`order_items` row, inserting one entitlement and one `library_items` row per book, each keeping the
existing `on conflict ... do nothing` so a buyer who already owns a book is unaffected.

Consequences to plan for:

- The return type changes from `entitlement_id uuid` to `entitlement_ids uuid[]`. Dropping and
  recreating the function is a forward migration, but every caller and both pgTAP suites (S3 and S7)
  are updated in the same change. `confirm_manual_payment` and the simulator webhook route are the
  only callers.
- The replay and out-of-order branches return the caller's current active entitlements for the order's
  books, preserving their existing no-op semantics.
- `S8`'s redemption flip stays where it is, once per order, not once per item.

This change lands as its own task, with its own tests, before either feature is built.

`create_ebook_order` is unchanged for single books. Bundles get `create_bundle_order(p_bundle_id)`,
which mirrors it: it resolves the bundle's active in-window offer, snapshots the bundle title and
price on `orders`, and writes one `order_items` row per member book with the book's own title
snapshot and `unit_price_minor = 0` except for a single line carrying the bundle price. `EB013` fires
only when the buyer already holds an active entitlement for *every* member book.

## 6. Bundles

### 6.1 Schema

```
bundles                id, status, created_at
bundle_localizations   bundle_id, locale, slug, title, subtitle, description
                       unique (locale, slug)
bundle_books           bundle_id, book_id, position   primary key (bundle_id, book_id)
```

`offers` gains `bundle_id uuid references bundles(id)` and a check that exactly one of `sku_id` and
`bundle_id` is non-null. Market, currency, window, and `active` keep their existing meaning, so
`lib/catalog/price.ts` and the offer admin reuse their current code paths. A `bundle_offers` table
parallel to `offers` was rejected for exactly that reason.

Covers reuse the public `covers` bucket with the bundle as owner.

### 6.2 Readiness and publishing

`checkBundleReadiness(bundle)` follows `checkBookReadiness`: a bundle publishes only when it has at
least two published member books, a localization with title, slug, and description, a cover, and an
active offer. A `publish_bundle` RPC runs the same checks. Unpublishing a member book does not
unpublish the bundle, but it appears as a readiness warning on the bundle editor and the bundle page
hides that member.

Slug changes write a `redirects` row in the same transaction, as book localizations already do.

### 6.3 Public page

`/{locale}/bundles/[slug]` is a Server Component: cover, title, description, the member books in
`position` order each linking to its own book page, one price, and one action from an extended
`resolveBookAction` (`lib/catalog/book-action.ts` gains a bundle variant). The page states how many
member books the signed-in reader already owns and that the price does not change. It carries
canonical and `hreflang` metadata, appears in `app/sitemap.ts`, and emits `Product`/`Offer` JSON-LD
listing the member books.

A bundle never appears in the library. Its books do.

### 6.4 Admin

`/admin/bundles` lists bundles with status and readiness. The editor holds Details, Localizations,
Cover, Members (add, remove, reorder), and Offer. Every change writes one `audit_logs` row.

## 7. Gifts

### 7.1 Schema

```
gifts
- id uuid primary key
- order_id uuid not null unique references orders(id)
- purchaser_profile_id uuid not null references profiles(id)
- recipient_email text not null              -- normalized lower-case
- message text                               -- optional, at most 500 characters
- claim_token_hash text not null unique      -- sha-256 of the token; the token is never stored
- status text not null check (status in ('pending', 'sent', 'claimed', 'revoked'))
- claimed_by_profile_id uuid references profiles(id)
- claimed_at timestamptz
- revoked_at timestamptz
- revoked_reason text
- created_at timestamptz not null default now()
```

RLS: the purchaser reads their own rows without `claim_token_hash`; an admin reads every row; nobody
writes through the Data API.

### 7.2 Purchase

The checkout page gains a gift option: recipient email and an optional message. Choosing it calls a
Server Action that writes the `gifts` row with `status = 'pending'` and a freshly generated token,
returning the token to nothing — only its hash is persisted, and the token goes straight into the
outbox payload.

When the order completes, the entitlement loop in §5 **skips gift orders entirely**: no entitlement is
granted to the buyer. Instead the gift moves to `sent` and one `notification_outbox` row, unique per
gift, carries the claim link to the recipient. A fully discounted gift order (an S8 100% coupon)
behaves identically.

### 7.3 Claim

`/{locale}/gifts/claim/[token]` is dynamic and `noindex`. A signed-out visitor is sent to magic-link
sign-in with `next` pointing back at the same URL.

`claim_gift(p_token text)` runs as the signed-in reader. It hashes the token, locks the gift row,
refuses anything not in `sent`, grants an entitlement and a `library_items` row for every
`order_items` row of the order, and records `claimed_by_profile_id` and `claimed_at`. Re-running it as
the same reader is a no-op that returns the same result; a second, different reader is refused because
the status is no longer `sent`.

The page then names each book that was added and each book the recipient already owned.

The recipient's email address is not checked against `recipient_email`. The token is the
authorization, and requiring an address match would strand a recipient whose account uses a different
address. The email is retained for the admin's reissue flow and for support.

### 7.4 Admin

`/admin/gifts` finds a gift by order reference, purchaser email, or recipient email. It can resend the
email for a `sent` gift and can revoke an unclaimed gift and reissue it to a different address, which
generates a new token, invalidates the old one, and writes an audit row. A claimed gift is not revoked
here: it is a real entitlement, handled by the existing `revoke_order_entitlement`.

## 8. Interaction With S8 Coupons

`coupon_bundles (coupon_id, bundle_id)` mirrors `coupon_books`. Scope resolution becomes: a coupon
with no scope rows applies to everything; a coupon with only `coupon_books` rows does **not** apply to
a bundle order; a coupon with `coupon_bundles` rows applies to those bundles. The reservation model
and the rate limiting from S8 are unchanged.

## 9. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | `checkBundleReadiness`; the bundle variant of `resolveBookAction`, including partial ownership; claim-token generation and hashing; the gift checkout form schema |
| pgTAP | A bundle order grants one entitlement per member book; partial ownership grants only the missing books; owning every member book refuses the order; a gift order grants the buyer nothing; claiming twice yields one set of entitlements; two concurrent claims leave exactly one winner; an unknown or revoked token is refused; revoking a claimed gift is refused; reader B cannot read reader A's gift row; `offers` rejects a row with both `sku_id` and `bundle_id`, and a row with neither; a book-scoped coupon does not apply to a bundle order |
| Playwright | Buy a bundle → transfer → admin confirms → the library holds every member book; gift a book → recipient signs in → claims → reader opens |
| Runbook | `docs/runbooks/bundles-and-gifts.md`: building a bundle, publishing it, and reissuing a gift sent to a wrong address |

## 10. Exit Criteria

- `apply_payment_event` grants one entitlement per order item, and the S3 and S7 suites pass against
  the rewritten function.
- A bundle publishes only when it meets every readiness rule, and its slug rename leaves one redirect
  with no chain.
- A buyer who owns part of a bundle receives only the books they were missing, with no duplicate
  entitlement.
- A gift order never grants the buyer access, and a claim grants the recipient every book in the order.
- An unclaimed gift can be reissued to a new address; a claimed one cannot be reissued.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
