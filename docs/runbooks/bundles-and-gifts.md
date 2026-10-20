# Runbook: bundles and gifts

This runbook covers what S9 adds: bundles in `/admin/bundles` and on the storefront, and gift orders
with their support operations in `/admin/gifts`.

> **One database.** The cloud Supabase project is also production's database. Never run Playwright
> fixtures, `supabase db reset`, pgTAP, or EPUB `process`/`retry` against it. Everything in section 6
> is local-only. The SQL in section 5 runs in the Supabase SQL editor of the hosted project, and only
> the statements shown.

Related: [catalog admin](catalog-admin.md) for books, [checkout](checkout.md) and
[manual payment](manual-payment.md) for orders, [coupons](coupons.md) for codes, and
[SEO and operations](seo-and-operations.md) for the worker that actually sends a gift's claim link.

## 1. What a bundle is, and what it is not

A bundle sells several books at one price. It is a way to sell books, never a thing that can be
read: buying a bundle grants one entitlement per member book, and the bundle itself never appears in
a reader's library and has no reader route.

The price is the bundle's own price. It is **never prorated** for partial ownership: a reader who
already owns two of five books pays the full bundle price and receives the three they were missing.
The storefront and the checkout both say so before the reader pays.

A member book keeps selling on its own book page. Unpublishing a member does not unpublish the
bundle - the bundle page simply stops showing that book, and the editor keeps a warning on it.

## 2. Build and publish a bundle

All of this is `/admin/bundles`. Every mutation writes exactly one `audit_logs` row.

1. **Create.** `/admin/bundles` → **New bundle**. Choose the locale, title, and slug. The slug must
   be lowercase words joined by hyphens, and is unique per locale across all bundles.
2. **Add at least two books.** In the bundle's **Books** section, pick each title under *Add a book
   to the bundle*, then **Save members**. Two *published* members is a hard publish requirement.
3. **Order them.** Use **Move up** / **Move down** on each row, then **Save members** again. That
   order is what the bundle page, the checkout list, and the order items all use. The controls are
   buttons rather than drag-and-drop so the list is usable from the keyboard.
4. **Upload a cover.** **Cover** section → *Cover image* and *Cover alt text*. A bundle's cover is
   its own; it is never one member's cover. Covers go in the public `covers` bucket, like a book's.
5. **Write the copy.** **Localizations** section → *Save vi copy* and *Save en copy*. A localization
   counts as complete only when it has a title, a slug, **and** a description. Customer-facing copy
   exists in both `vi` and `en`; `/admin` itself is English-only and carries no locale prefix.
6. **Price it.** **Price** section → *New offer market*, *New offer currency*, *New offer price
   (minor units)*, then **Add offer**. Prices are integer minor units (`189000` is 189,000 ₫).
   The price must be **above 0** while the offer is active. A book may be given away; a bundle may
   not, because `create_bundle_order` sells only a positive price - an active free offer used to
   publish a bundle that its own page then reported as unavailable. An *inactive* zero row is still
   accepted as a draft price.

   With several live offers, the page and the checkout resolve one the same way, through
   `bundle_live_offer`: the **cheapest** live offer wins, with the market and currency codes
   breaking a tie. The page reaches that rule through `catalog_bundle_live_offer`, which answers
   for published bundles only - a draft bundle's price is not public, however well its id is known. Price every market you sell in, but a bundle priced in several is no longer a
   bundle that can quote one price and charge another.
7. **Clear readiness.** The **Publish** section lists what is still missing. Each item links to the
   section that fixes it:

   | Message | Fix |
   | --- | --- |
   | Add at least two published books to the bundle. | Step 2, and publish the member books. |
   | Add a localization with a title, slug, and description. | Step 5. |
   | Upload a cover image. | Step 4. |
   | Activate the bundle offer. | Step 6. An active offer priced at 0 does not count. |
   | A member book is not published, so the bundle page hides it. | Warning only - never blocks. |

8. **Publish.** **Publish bundle**. The database recomputes the same rules and refuses a bundle that
   does not meet them, so a stale editor page cannot publish a bundle that has drifted.
9. **Verify the public URLs.** Open both, signed out:
   `https://<origin>/vi/bundles/<vi-slug>` and `https://<origin>/en/bundles/<en-slug>`.
   Check the price, that every member book is listed, and that the page is in the sitemap. A bundle
   localized in one locale only is a one-locale page: it gets no alternate and no locale switch,
   which is correct rather than a fault.

**Renaming a slug.** Saving a localization with a new slug records a redirect from the old slug to
the new one and collapses any existing chain, so `a → b → c` becomes `a → c`. There is never a chain
to follow, and the old URL keeps working.

## 3. Find a gift

A gift is a property of an **order**, not of a book. `/admin/gifts` searches by order reference,
purchaser email, or recipient email; with no search it shows the 50 newest.

Each row shows the order reference, purchaser, recipient, what the gift covers, its status, and its
delivery state. Read the **Delivery** column before choosing an action: `—` means the message has
never been attempted, `Sent <date>` means it went out, and `4 attempts · resend_http_422` means
delivery is failing for a reason you should fix before trying again (see
[SEO and operations](seo-and-operations.md) section 6 for the codes).

The four statuses:

| Status | Means | Support actions |
| --- | --- | --- |
| `pending` | The order has not been paid for. No claim link has been sent. | None. The purchaser can still correct the address at checkout. |
| `sent` | The order completed and the claim link is live. | Resend, or reissue. |
| `claimed` | The recipient has the books. | None here - see section 5. |
| `revoked` | The link is dead and there is none to replace. | None. Refund the order or sell a new gift. |

**No screen in the product ever shows a claim link**, and no support tool can retrieve one. Only the
SHA-256 hash of the token is stored on the gift row; the one live copy is the recipient's email and
a protected outbox payload that `claim_gift` clears. If a recipient has lost the link, resend it or
reissue it - there is nothing to read out to them.

## 4. Resend and reissue

Both actions are on the gift's row in `/admin/gifts`, and both work only on a `sent` gift.

**Resend to the same address.** Use this when the recipient did not receive the message, or deleted
it, and the address is right. It re-queues the existing claim link to the same address. The link
does not change.

**Reissue to a new address.** Use this when the gift went to the **wrong address**. It requires:

- *New recipient email* - where the gift should have gone.
- *Email language* - defaults to the language the gift was first sent in, so a corrected address does
  not silently switch languages.
- *Reason* - required, and recorded in the audit log. Write what actually happened ("purchaser
  reported a typo in the address, confirmed by reply on ticket 812"), not "reissue".

Reissuing **retires the old link**: a new token is generated and the old one stops working
immediately. That is the point - it is how a link that went to a stranger is taken back.

Resend and reissue each write exactly one `audit_logs` row. A replayed payment and a replayed claim
write none.

Both also advance `notification_outbox.delivery_generation`, which is what gives the next message a
fresh provider idempotency key. It matters: the provider holds a key for 24 hours and requires a
distinct key per distinct request, so before this existed a resend inside that window was folded
into the original send - the recipient who told you nothing arrived was sent nothing again - and a
reissue, which changes the address and the link under the same key, was rejected and then spent the
row's six attempts on a request that could never succeed. An automatic worker retry is the same
delivery and deliberately does NOT advance it.

## 5. A claimed gift cannot be reissued

Once a gift is `claimed`, the books belong to the recipient. There is no link left to replace - the
claim consumed it and cleared the stored payload - and reissuing would mint a second claim on books
that have already been handed over. Both support actions refuse a claimed gift.

Taking the books back is a **revocation on the order**, not a gift operation:

1. Open the order from the gift row (`/admin/orders/<order-id>`).
2. Fill in **Reason** and use **Revoke access**.

That calls `revoke_order_entitlement(p_order_id, p_reason)`, which revokes every entitlement the
order granted - for a bundle gift, all of its member books at once - and writes one audit row.

> **Tell the recipient.** After a revocation, the claim page does not explain itself. Reopening the
> claim link as the same reader takes the replay branch, which lists the gift's books by their
> **active** entitlements: a revoked book silently drops off the list, with no marker of any kind.
> The page says what this gift holds in your library *right now*, and that is exactly what it shows.
> So **never use the claim page as evidence of what a claim granted** - it is not a grant record.
> The order page and `audit_logs` are the record. Say to the recipient what was withdrawn and why.

## 6. Local verification

Local-only, against a local Supabase stack. Read [testing environments](testing-environments.md)
first; it has the exact setup, including which variables Playwright needs and why the suite refuses
to run a subset of itself.

```bash
supabase start
npm run db:reset          # LOCAL ONLY - never against the cloud project
npm run db:test           # includes 042-049, the S9 pgTAP suites
npm run check             # lint, types, unit tests, production build
```

The two S9 journeys are Playwright specs:

- `e2e/bundle-purchase.spec.ts` - buy a two-book bundle, transfer, an admin confirms, both books are
  in the library and both reader routes open, and the bundle is not a library item. It runs in the
  `chromium-manual` project against the manual-provider web server on port 3100.
- `e2e/bundles-and-gifts.spec.ts` - gift a book, the operations worker delivers the claim link, the
  recipient signs in from the link and claims it; and a fully discounted bundle gift that adds only
  the member books the recipient was missing. Simulator server, port 3000.

```bash
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       E2E_MAILPIT_URL="$MAILPIT_URL" \
       E2E_DATABASE_URL="$DB_URL"
npm run check:full
```

Export those **before** building: `NEXT_PUBLIC_*` values are inlined at build time, so exporting them
after a build silently bakes in the wrong ones.

> **Never point these at the cloud project.** The fixtures create confirmed users, grant the admin
> role, publish catalog rows, and complete orders, and nothing cleans any of it up. The service-role
> helper refuses a non-loopback `NEXT_PUBLIC_SUPABASE_URL` and the fixture-SQL helper refuses a
> non-loopback `E2E_DATABASE_URL`, but those are a backstop, not permission to try.

In Playwright and in local development, mail goes through the no-network adapter
(`EMAIL_PROVIDER=test`): a gift's claim message is *never* handed to a real mail path, so a claim URL
never enters an inbox that a misconfigured environment could point somewhere else.

## 7. Delivery of the claim link

A gift's claim message is an outbox notification like any other. It is created when the purchaser
configures the gift, held back until the order **completes**, and sent by the scheduled operations
worker - `POST /api/operations/run`, every five minutes. A gift that shows `sent` with an empty
**Delivery** column is waiting for the next worker run, not broken.

`notification_outbox` now carries two templates: `book_ready` and `gift_claim`. Two consequences for
anyone reading logs or alerts written before S9:

- **The worker's log lines are no longer named after book-ready mail.** They read
  `Notification email sent.`, `Notification delivery failed.`, `Notification lease lost …`,
  `Notification outbox claim failed.`, and each carries a `template` field (`book_ready` or
  `gift_claim`) alongside the request ID and the outbox ID. Any saved log search, dashboard, or
  alert rule keyed on the old "Book-ready …" wording matches nothing now - re-key it on
  `Notification` and filter by `template`.
- **The "stuck notification" operational rule covers both templates.** `/admin/operations` still
  labels its finding *Stuck book-ready emails*, which is now narrower than what the rule reports;
  read it as "stuck notification". The finding's review link is a profile page and a `gift_claim`
  row has no profile, so investigate a gift's delivery from `/admin/gifts` instead - the **Delivery**
  column shows the same attempt count and error code.

The Resend idempotency keys are unchanged and are per-template: `book-ready/<outbox-id>` and
`gift-claim/<outbox-id>`. A retried send never delivers a second copy.
