# Runbook: coupons

Promotion codes discount an order before it is paid. A code can knock the price to zero, in which
case the order completes the moment the code is applied - no payment step at all - or it can reduce
the amount the reader still owes, in which case they pay the discounted total the same way they
always would, on either provider. This is a feature of `checkout.md`'s order, not a separate one:
see [get and buy](checkout.md) for order creation, the order states, and revoking access, and
[manual bank transfer](manual-payment.md) for the transfer page a partially discounted manual order
still uses. On a book that is on sale, a code discounts the sale price, not the list price; see
[book sale price](book-sale.md).

## 1. Issuing tester codes

1. Sign in as an admin and open `/admin/coupons` → **New coupon**.
2. Code: `TESTER-<batch>`, e.g. `TESTER-LAUNCH`. Kind: **Percent off**. Percentage off: `100`.
3. **Maximum redemptions**: the number of testers in the batch, so the code cannot be spent past
   it. **Maximum redemptions per customer**: `1`, so no single tester can use it twice.
4. **Note**: who the batch is for, e.g. "Launch week testers, 2026-09-21". This is operator-only;
   the reader never sees it.
5. Leave **Books** and **Bundles** both unchecked to let the code apply to anything, or see
   section 2 to scope it.
6. **Create coupon**. The code cannot be edited after this - see section 5.

What the tester does: open the book page, **Buy ebook**, enter the code under **Enter a code**,
**Apply**. A 100% code completes the order immediately and takes them straight into the reader;
there is no **Pay** button to click and no transfer page, on either provider.

What to expect in `/admin/orders`: one `completed` order with `payment_status = not_required` and
one `free_order` entitlement - the same shape a free offer produces, because a fully discounted
coupon order is completed the same way. `/admin/coupons/<id>` shows the redemption in **Redeemed**.

## 2. Scoping a code to a book or a bundle

In the coupon editor, tick one or more books under **Books**, one or more bundles under **Bundles**,
or some of each. Selecting nothing in EITHER list means the code applies to everything - this is the
default, not a special case, so an operator who wants a catalog-wide code does nothing here.

The two lists are independent, and neither is inferred from the other:

| Ticked | Applies to a single-book order | Applies to a bundle order |
| --- | --- | --- |
| nothing | every book | every bundle |
| books only | the ticked books | **no bundle at all** |
| bundles only | no book at all | the ticked bundles |
| both | the ticked books | the ticked bundles |

The row that surprises people is the second one. **Ticking a book does not put the bundles that
contain it in scope.** A bundle is priced as its own thing, so a promotion on one member book is not
a promotion on the bundle - if you want both, tick both.

A code applied to an order it is not scoped to is refused with the same message every other
rejection uses: "This code cannot be used." There is nothing in the reader-facing response that says
"wrong book" or "wrong bundle" - see section 6 for where that reason actually goes.

A 100%-off code on a bundle order grants every published member book in the one call, skipping any
the reader already owns, and spends exactly one redemption for the order - not one per book.

## 3. Retiring a code

Untick **Active**, or set an **Ends** date in the past. Either stops the code from being applied to
any *new* order from that point on.

**Starts and Ends are entered and stored in UTC, not your local time**, even though the picker shows
plain digits with no timezone marker of its own - the field labels say "(UTC)" for this reason. A
Vietnam-based operator is 7 hours ahead of UTC: typing "23:59" to mean 11:59pm Hanoi time actually
sets the code to stop at 06:59 the *next* day in Hanoi. Do the offset in your head before you save.

**Reservations already held by pending orders are not released.** An order that already carries the
code keeps its price - retiring the code does not touch it, does not put the order's price back up,
and does not need anything further from you. If a reader completes that order (pays, or transfers
and is confirmed), it completes at the discounted price, using the redemption the code's own
`Reserved` count already accounted for. This will surprise an operator who expects "turn it off" to
mean "stop honoring it everywhere immediately" - it does not. If you need to stop that too, cancel
the specific pending order from `/admin/orders`.

## 4. Reading the counts

`/admin/coupons` and the coupon's own edit page show two counts:

- **Reserved** - held by a pending order that has applied the code but not yet completed. Released
  back to the pool if the reader removes the code from the order, or if the order is cancelled.
- **Redeemed** - spent on an order that completed with the code applied. Never released. A refund,
  a revoke, or any other after-the-fact change does not give the redemption back - see section 5.

**Reserved + Redeemed is what the coupon's global limit (Maximum redemptions) counts against**, not
Redeemed alone. A code with `Maximum redemptions = 50` and 50 orders currently holding it as a
reservation is exhausted for a 51st reader even though none of those 50 have completed yet - the
last remaining use goes to whichever of two simultaneous readers reserves it first; the other is
refused, not queued.

## 5. What cannot be done

- **No refund or re-issue after an order completes.** A redemption is permanent once the order that
  spent it is `completed`. There is no operator action that gives a spent redemption back to the
  coupon or moves it to a different order.
- **No stacking.** An order carries at most one coupon code at a time. Applying a second code
  replaces the field's contents in the UI, but the reader must remove the first code before a
  second one is accepted - there is no combined discount.
- **No change to a code's value once it has been used.** Once a coupon has any reservation or
  redemption, its **Kind** and its value field (**Percentage off**, or **Amount off** and
  **Currency**) become read-only in the editor, with a note explaining why. The database enforces
  the same rule independently and refuses the change with `EB025` if it is ever attempted another
  way. Window (**Starts** / **Ends**), **Active**, the redemption limits, the **Note**, and both scope
  lists (**Books**, **Bundles**) stay editable throughout - retiring or rescoping a used code is fine; changing what it is worth is
  not.
- **No code change on an order whose transfer has already been reported.** Once a manual-payment
  reader has pressed **I have transferred**, the order is in the admin review queue and its coupon
  (or lack of one) is fixed along with its price; nothing on the reader's side can add, remove, or
  swap the code from that point on. The two sides cannot slip past each other either: reporting a
  transfer and changing a code both lock the order row first, so a reader doing both at once gets
  one of two outcomes - the code lands and the report is made against the new total, or the report
  lands and the code is refused. An order whose reported amount and stored total disagree is not a
  state this can produce; if you ever see one, it did not come from here.
- **Known and deliberate: a reader can spend a code on a book they already own.** The checkout page
  never offers the coupon field to a reader who already holds an active entitlement for that book -
  they see "You already own this book" instead, as usual - so this only reaches a coupon at all if
  an order was created before the entitlement existed (a pending order the reader placed, then
  acquired the book another way before paying it off). No wrong access results: they already had the
  book. But applying the code to that order still consumes a redemption, exactly as it would for any
  other order. This is a deliberate divergence from `claim_manual_transfer` in
  [manual bank transfer](manual-payment.md), which refuses to let an already-entitled reader claim a
  transfer at all (`EB017`). Coupons were ruled to allow it rather than add a second already-owned
  check to the apply path. If you see a redemption spent against an order for a book the reader
  already had, this is why - it is not a bug to investigate.

## 6. Where to look when a code does not work

**Every rejection shows the reader the same message: "This code cannot be used."** This is by
design (spec 4: a code space must not be searchable by trying codes and reading the difference
between the errors), and it means the app's own logs and the checkout screen will never tell you
*why* a particular attempt failed. Do not go looking for a per-reason message in the application
logs - there isn't one.

The real reason lives in the **Postgres log**, written by `apply_coupon_to_order` with `raise log`,
never returned to the browser. Find it by the order id:

1. Get the order id from the reader's report, or from `/admin/orders` by their email.
2. Search the Postgres log (`supabase logs` locally, or your hosting provider's Postgres log stream
   in the cloud) for a line from `apply_coupon_to_order` naming that order id and the profile id,
   ending in the actual reason: `unknown code`, `inactive`, `not yet started`, `expired`,
   `wrong book`, `currency mismatch`, `exhausted` (the global redemption limit), `per-profile limit
   reached`, or `too many failed attempts` (the rate limit - see below).
3. Correlate it with the application's own log line, `Coupon rejected.`, which carries the same
   order id and the request id, but never the reason - only the database log has that. Match the two
   by order id, not by time; a busy reader can produce several rejections a minute.

A reader who has tried **10 wrong codes within a 10-minute fixed window** (per profile, across every
order) is rate-limited: `apply_coupon_to_order` refuses even a code that would otherwise be valid
until the window elapses, and logs `too many failed attempts` against their profile id rather than
against any particular code. The reader sees "Too many codes have been tried. Wait a few minutes and
try again." - a different message from every other rejection, since this one is a pacing limit, not
a claim about the code. The window is fixed, not sliding: it resets ten minutes after the *first*
failure in the current window, not ten minutes after the most recent one.

The count holds against a burst as well as against a sequence: each reader's coupon applications are
serialized in the database, so submitting twenty codes at once spends twenty attempts and stops at
the tenth, rather than letting all twenty through because none of them had seen the others' failures
yet. The visible effect on an honest reader is nil - the only person submitting codes concurrently is
one who double-clicked, and their second submission waits out the first.

## 7. Testing this locally

`e2e/coupons.spec.ts` covers the code path that needs no payment provider: a 100% code completing an
order inside the RPC, and a wrong code producing the one shared rejection message. It runs in the
default `chromium` project against the ordinary simulator server, and issues its own test codes
through `/admin/coupons/new` - `coupons` carries no `service_role` grant, so there is no fixture
shortcut into it, which is itself part of what the spec is proving.

The partial-discount path - a code that reduces what the reader owes rather than zeroing it - needs
the manual provider's transfer page, so its test lives at the end of `e2e/manual-payment.spec.ts`
and runs only in the `chromium-manual` project; see section 9 of
[manual bank transfer](manual-payment.md) for how that second server is started. Run both together
with `npm run check:full`, or individually:

```bash
supabase start
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       E2E_MAILPIT_URL="$MAILPIT_URL" \
       E2E_DATABASE_URL="$DB_URL"
npx playwright test e2e/coupons.spec.ts
npx playwright test --project=chromium-manual
```

Never point either against the cloud project; see [testing environments](testing-environments.md).

Keep the request ID from any error. Server logs include it.
