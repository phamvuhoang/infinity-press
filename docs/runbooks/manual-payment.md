# Runbook: manual bank transfer

Readers pay by transferring money to a bank account and telling us they did. An admin matches the
transfer against the bank statement and confirms it, which is what grants access. Nothing is
automatic: no webhook, no bank API, no reconciliation job. This is the payment path production uses.

The other provider is the simulator, which is for local and staging only. See
[get and buy](checkout.md) for the shared parts of checkout: order creation, the order states, and
revoking access.

## 1. Configuration

The app needs all five of these. Production needs them too - this is the provider production runs.

```text
PAYMENT_PROVIDER=manual
BANK_TRANSFER_BANK_CODE=<6-digit Napas/VietQR bank code, e.g. 970436>
BANK_TRANSFER_BANK_NAME=<bank name as the reader should see it>
BANK_TRANSFER_ACCOUNT_NUMBER=<6 to 20 digits>
BANK_TRANSFER_ACCOUNT_HOLDER=<account holder name as the bank prints it>
```

The four `BANK_TRANSFER_*` values are required together whenever `PAYMENT_PROVIDER=manual`, and the
app refuses to start without all four. That is deliberate: these are printed on a page the reader
acts on, and a half-filled instruction is worse than none. `BANK_TRANSFER_BANK_CODE` must match
`^\d{6}$` and `BANK_TRANSFER_ACCOUNT_NUMBER` `^\d{6,20}$`.

None of these are secrets - the reader has to read all four off the page - but they are still
server-side variables. Do not add a `NEXT_PUBLIC_` copy.

On provider values in production:

- `PAYMENT_PROVIDER=simulator` is **refused** in production. The app throws at startup.
- `PAYMENT_PROVIDER=manual` is accepted.
- `PAYMENT_PROVIDER=disabled` is accepted and means no one can buy anything.

## 2. Turning payments on

Three settings, in two places. The app has one, the database has two.

1. The app: `PAYMENT_PROVIDER=manual` plus the four bank variables. This decides which pages and
   actions exist - the transfer instructions, the reader's report button, the admin's confirm and
   decline forms.
2. The database: `commerce_settings.payments_enabled` - whether anyone may buy at all. The default
   is `false`, and with it off `create_ebook_order` fails with `EB011` and readers see "Buying
   ebooks is not available yet."
3. The database: `commerce_settings.payment_provider` - which provider each new order is **booked
   under**. This is what writes `manual` into the order's `payments` row, and every manual surface
   finds an order by that row.

```sql
update public.commerce_settings
set payment_provider = 'manual', payments_enabled = true;
```

Postgres cannot read `PAYMENT_PROVIDER`, which is why the provider is recorded here too. It is not a
parameter the application passes, deliberately: `create_ebook_order` is callable by any signed-in
reader, and which provider an order is booked under decides who is allowed to confirm it.

> **`PAYMENT_PROVIDER` and `commerce_settings.payment_provider` must always be set to the same
> value, in the same procedure.** Nothing enforces it and nothing warns about it. If they disagree,
> orders are booked under one provider while the site renders and confirms under the other, and the
> result is silent: with the app on `manual` and the database still on `simulator`, a reader reaches
> the transfer page, makes the transfer, presses **I have transferred** and gets an error - while
> `/admin/payments` stays empty, because the order is not a manual order as far as the database is
> concerned. Set both, then check one real order end to end before telling anyone the provider has
> changed.

A price change (an admin edit, or a [book sale](book-sale.md) starting or ending) does **not** cancel
an order whose transfer the reader has already reported. **Buy** returns that order at the price
they transferred. A provider switch is different: it still cancels such an order, as follows.

A pending order booked under the other provider is not reused: the next **Buy** click cancels it and
creates a fresh order, with a fresh reference, under the provider now in force. So a reader caught
mid-switch is not stranded - but a reference they wrote down before the switch is dead, and money
already sent against it has to be reconciled by hand (section 7).

The cloud Supabase project is shared with production, so turning `payments_enabled` on there turns
real buying on. Do it as a deliberate step, not as part of a deployment.

## Press specifics

Infinity Books Press differs from the shop this runbook was written for in four ways. Everything else
below applies unchanged.

- **The payee is Press's own account.** The four `BANK_TRANSFER_*` values are the account Press
  receives money in. Never copy another business's account, and do not reuse the values from any other
  deployment. They come from the person who owns the bank account, not from the repository.
- **VND only.** `commerce_settings.payable_currencies` is `{VND}`. `create_edition_order` refuses an
  offer in any other currency (`EB041`) and the transfer page never prints bank details for one.
  USD and JPY editions can be listed and given free; they cannot be bought until a payment method for
  them exists. No exchange rate is applied anywhere.
- **One order per edition.** English and Japanese of one work are separate products with separate
  orders, references, confirmations and entitlements. Confirming the Japanese order grants Japanese
  only. The order page shows the language. Press has no SePay provider.
- **One bank line, one order.** Confirming with a bank reference that another order already carries
  (ignoring case and padding) is refused (`EB043`). It is almost always one transfer being applied
  twice.

The database default provider is `manual`. Payments stay **off** until the release procedure turns
`payments_enabled` on, after one real order has been walked from Buy to Read in the target environment.

## 3. What the reader sees

| Step | URL | What happens |
| --- | --- | --- |
| Buy | Book page → **Buy ebook** | `create_edition_order` creates or reuses a pending order for one edition. |
| Checkout | `/{locale}/checkout/<orderId>` | The ebook, the total, the account email, and **Pay**. |
| Transfer | `/{locale}/checkout/<orderId>/transfer` | Bank details, the amount, the order reference, and a VietQR image. **I have transferred** reports the transfer. |
| Status | `/{locale}/checkout/<orderId>/status` | Waiting for your transfer → Awaiting confirmation → Payment complete. |
| Orders | `/{locale}/account/orders` | The reader's own orders. |

**Pay** does not leave the site. The manual provider's "payment page" is the transfer instructions.

The order reference is the memo. It looks like `IB-4K7QX`: `IB-` and five characters from a
Crockford-style alphabet with the ambiguous letters (I, L, O, U) removed, so a reference read off a
phone screen and typed into a banking app does not turn into a different order. Every order has one,
including free and simulator orders.

The QR image is decoration. It is built from the same bank code, account number, holder, amount, and
reference that are printed beside it in plain text, so a reader whose banking app cannot scan it, or
whose browser blocks the image, can still complete the transfer.

**The QR appears only for orders priced in VND.** VietQR wants the amount in major units, and an
order carries it in minor units; those are the same number for VND and are not for a currency with
a minor unit, where a QR built the same way would ask the reader to pay a hundred times the price.
So any other currency gets the bank details without a QR, which is why they are printed in full.

Reader-facing states, derived rather than stored (there is no `awaiting_confirmation` payment status
in the database):

| Order | Payment | Claim | Reader sees |
| --- | --- | --- | --- |
| `pending` | `pending` | none | Waiting for your transfer |
| `pending` | `pending` | reported | Awaiting confirmation |
| `pending` | `failed` | released | Transfer not received yet, with the decline reason, and the report button again |
| `pending` | `failed` | reported again, after the decline | Awaiting confirmation |
| `completed` | `succeeded` | released | Payment complete, with **Read now** |
| `cancelled` | `cancelled` | released | Order cancelled |

The fourth row is why the claim column says *when*, not merely *whether*. `payment_status` stays
`failed` after a decline and nothing ever resets it, so what separates "we declined your transfer"
from "you have told us about a new one" is which of the two happened last. A report made after the
most recent decline wins; anything at or before it does not.

Reporting a transfer grants nothing. It only moves the order into the review queue.

## 4. The daily reconciliation loop

Do this against the bank statement, once or twice a day.

1. Open `/admin/payments`. It lists every **pending** order on the manual provider, reported ones
   first, oldest report first. Orders nobody has reported yet are listed too, at the bottom - a
   reader who transferred without pressing the button is a normal case, not an anomaly. The page
   shows at most fifty orders, and that ordering is applied before the cut, so a reported transfer
   is never pushed off the page by older unreported ones however many of them there are.
2. For each credit on the statement, read the memo and find the matching reference. Search by
   reference or by customer email in the box at the top.
3. Open the order. **Manual payment** shows when the reader first reported the transfer and the
   most recent note they left. A reader who reports again keeps their place in the queue - the
   timestamp does not move - but their newer note replaces the older one, so what you read is what
   they last told you.
4. Enter **Amount received** - what actually landed, in minor units, as a whole number - and the
   **Bank reference**, which is the bank's own transaction ID for that credit. This is the link
   between the order and the statement line; enter the real one, not a placeholder. Add a **Note**
   if anything needs explaining.
5. Choose **Confirm payment**. Access is granted immediately and the order leaves the queue.

Confirming twice does nothing the second time: a completed order returns the same result without
writing a second audit entry.

Two things about the order page after a decision, so they do not read as bugs. The confirm and
decline forms disappear, because the order is no longer pending and there is nothing left to decide.
And **Manual payment** goes back to saying "No transfer reported yet" - the reader's report is
released when you decide, so that the order leaves the review queue. What the report became is
recorded in the confirmation line below it and in the audit log.

Each order carries one `payments` row. Where an order shows **Payments** and **Events** further down
the page, those are the synthesized record of your own confirmation, not anything a bank sent.

## 5. When the amount does not match

Enter what actually arrived. Do not adjust the number to make the form accept it.

If the amount differs from the order total in either direction, the confirmation is refused and a
warning appears with both numbers, plus a tick box: **Confirm anyway, even though the amount does
not match**. Tick it and submit again to accept the difference.

Two things about that tick box will surprise you, and both are deliberate:

- **Editing the amount removes the tick and the warning, until you submit again.** The override
  applies only to the exact amount the warning describes. Change the field and the warning is
  describing a submission you are no longer making, so it disappears rather than sitting there
  ticked against a number that has moved on. Submit the new amount, read the new warning, and
  decide again. This is not a bug and it is not a stale form; it is the override refusing to be
  reused.
- **An accepted mismatch does not require a reason.** The audit log records the received amount, the
  order total, the currency, the bank reference, the fact that the override was used, and who used
  it - but the **Note** field stays optional, and nothing forces you to justify the difference. If
  your policy is that a mismatch must carry a written reason, that is a product change to make, not
  a setting to turn on.

What an accepted mismatch does to the order: the order completes at **its own total**, not at the
amount received. A short payment does not produce a partially paid order and an overpayment does not
produce a credit - the order is simply completed, access is granted, and the two numbers sit in
`manual_payment_confirmations` and in the audit log for you to reconcile by hand. Recovering the
difference (refunding an overpayment, chasing a shortfall) happens outside this system.

If you do not want to accept the difference, decline instead and tell the reader what to do.

## 6. Declining: "not received" versus cancelling

Both need a reason, and the reason is shown to the reader verbatim. Write it for them, not for the
audit log.

**Mark as not received** - the money did not arrive, or not yet.

- The order stays `pending`; the payment status becomes `failed`.
- The reader's transfer page shows "Transfer not received yet", your reason, and the report button
  again. They can transfer and report as many times as it takes, and once they report again the
  page says "Transfer report received" - their order is back with you, not still showing them a
  decline they have already answered.
- Their claim is released, so the order returns to the queue as unreported rather than sitting there
  looking reviewed.
- Each decline is recorded separately, in sequence, on the same order.
- No entitlement is touched, because a pending order never granted one.

**Cancel order** - this order is over.

- The order becomes `cancelled` and the payment `cancelled`. This is terminal: the order cannot be
  confirmed afterwards, and a later decline or confirm on it is refused.
- The reader sees "Order cancelled" with a link back to the book, and can buy again, which creates a
  fresh order with a fresh reference.
- No entitlement is touched.

Neither decline ever removes access. An order that already granted access is `completed`, not
`pending`, so it cannot be declined at all. To take access away from a completed order, use
**Revoke access** on `/admin/orders/<orderId>` ([get and buy](checkout.md)).

Use "not received" for anything recoverable - money not arrived yet, wrong amount the reader will
top up, a transfer you cannot find. Use "cancel" when the reader asked to cancel, or when an order
has been dead long enough that leaving it payable is misleading.

## 7. Money with no matching reference

A credit on the statement whose memo does not match any reference. Common causes: the reader
transferred before opening the transfer page, typed the memo by hand, or their bank truncated it.

1. Search `/admin/payments` by the customer's email. If they have a pending manual order, the amount
   and the timing usually settle it.
2. If that finds nothing, search `/admin/orders` by email or order ID. That page covers every order,
   not only pending manual ones, so it is where you find an order that was already cancelled, or one
   on a different provider.
3. Confirm against **the order the money was for**, entering the real bank reference. Never confirm
   a different reader's order because the amount happens to match.
4. If there is no order at all, the reader has paid for nothing we can grant. Ask them to place the
   order, then confirm it against the credit already on the statement. Do not improvise with a
   complimentary grant: that leaves the money with no financial trail to reconcile against.

A reader who reports a transfer they have not actually made is harmless. Decline as "not received".

## 8. Operator alerts

Every reported transfer that nobody has reviewed raises the **Unreviewed bank transfer reports**
finding, visible on `/admin/operations`. There is no grace period: the finding exists from the
moment the reader presses the button, and clears when you confirm or decline.

**Alerts arrive on the scheduler's interval, not instantly.** The operations worker
(`POST /api/operations/run`) is what evaluates the findings and sends the email, and it is called by
Supabase `pg_cron` every five minutes. So a report made at 09:00 raises an email somewhere in
09:00-09:05. There is no push from the reader's click. Vercel has no cron job for this; the schedule
lives in Supabase and is configured in section 4 of
[SEO and operations](seo-and-operations.md). Change the interval there if five minutes is wrong for
your volume.

Alert mail goes to `OPS_ALERT_EMAIL`. A rule alerts when it becomes active, when the set of
findings changes, and then once every 24 hours while it stays active - so a queue you have not
worked through will not mail you every five minutes, and equally will not stay silent about it.

This alert is a backstop for something you forgot, not the way you find out about transfers. The
reconciliation loop in section 4 is that.

## 9. Testing this locally

`e2e/manual-payment.spec.ts` covers the whole journey: buy, transfer instructions, report, admin
confirm, entitlement, reader opens the book; and the decline path back to the instructions.

It cannot run against the ordinary Playwright server, because `PAYMENT_PROVIDER` belongs to the
running process. `playwright.config.ts` therefore starts a **second** Next server on
`http://127.0.0.1:3100` with the manual environment, and the `chromium-manual` project - the only
project that collects this spec - points at it. The bank values it asserts come from
`e2e/support/server-env.ts`, which is also where the config reads them, so the page and the spec
cannot drift apart.

That second server is never reused: if anything is already listening on 3100 the run fails rather
than quietly testing against whatever is there. A simulator server answering on that port would make
this spec green for the wrong reason.

It also starts **only when the run could collect the manual spec** - that is, when no `--project`
is given, or when `--project` names `chromium-manual`. Playwright would otherwise start every
`webServer` entry whatever project was selected, so `--project=chromium` runs, including
`scripts/run-reader-visual-container.sh`, would need port 3100 free to test something that has
nothing to do with payments.

```bash
supabase start
eval "$(supabase status -o env)"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL" \
       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY" \
       SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
       E2E_MAILPIT_URL="$MAILPIT_URL" \
       E2E_DATABASE_URL="$DB_URL"
npx playwright test e2e/manual-payment.spec.ts
```

`npm run check:full` runs it along with everything else. Never point any of this at the cloud
project; see [testing environments](testing-environments.md).

To drive the manual provider by hand in `npm run dev`, put the five variables from section 1 in
`.env.local` and set `payments_enabled` on the local stack.

## 10. Common questions

- **`/admin/payments` is empty but a reader says they transferred.** The queue shows pending manual
  orders only. If their order was cancelled or already completed, look on `/admin/orders`.
- **Confirm says "This order is no longer awaiting a transfer."** Someone else decided it while the
  page was open, or the order was cancelled. Reload and look at the current state.
- **The confirm button is disabled.** There is an unaccepted amount mismatch. Either fix the amount
  or tick the override; see section 5.
- **The app will not start after setting `PAYMENT_PROVIDER=manual`.** One of the four
  `BANK_TRANSFER_*` values is missing or fails its format check. The startup error names them.
- **A reader's status page says "Awaiting confirmation" and nothing changes.** That is correct until
  an admin confirms. Nothing in the system will move it on its own.
- **A reader says the transfer page sends them to "You already own this book".** They were granted
  the book from somewhere else - an admin grant, a free offer, another order - after this order was
  created. They are not asked to pay again, and the order stays pending: it does not cancel itself,
  because they may already have transferred against it. Cancel it from `/admin/orders` once you have
  checked the statement, and if money did arrive, confirm it instead and refund off-platform.
- **A reader's status page says the order can no longer be paid.** The order was created under the
  other payment provider - the deployment's `PAYMENT_PROVIDER` changed after they placed it. Nothing
  can settle such an order, and the page tells them to start a new one from the book page. They
  reach it from **Orders → the order → View order status**; the transfer page for such an order
  sends them there too rather than 404ing, because a reader who has already transferred comes back
  to that page for the account number and the reference. Cancel the stale order from `/admin/orders`,
  and check the statement first: if the money arrived before the switch, confirm the order instead.
- **A reader's status page says payments are paused.** `PAYMENT_PROVIDER=disabled`, or
  `commerce_settings.payments_enabled` is false. Their order is untouched and still theirs; it is
  not stale, and they are not told to start a new one, because `create_ebook_order` would refuse it
  (`EB011`). Section 1 has the two settings to put back.

Keep the request ID from any error. Server logs include it.
