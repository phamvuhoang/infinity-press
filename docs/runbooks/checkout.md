# Runbook: get and buy

Readers get free ebooks and buy paid ebooks under `/{locale}`. There are three payment providers, and
which one is live is `PAYMENT_PROVIDER` on the running server:

- `simulator` - buttons that pretend to be a payment provider. Local, test, and staging only;
  production refuses it. Covered here.
- `manual` - bank transfer, confirmed by hand by an admin. This is what production runs. Its
  configuration, reconciliation loop, and decline paths are in
  [manual bank transfer](manual-payment.md).
Press has no `sepay` provider. `PAYMENT_PROVIDER=sepay` fails the environment check at startup.

An order can also be discounted by a promotion code before it is paid, on either provider - see
[coupons](coupons.md) for issuing, scoping, and retiring codes, and for where the reason a code was
rejected actually goes.

Everything below applies to every provider except the **Simulator** section: order creation, the
order states, the order reference, the customer's order list, and revoking access are shared.

## Flows

| Step | URL | What happens |
| --- | --- | --- |
| Get free | Book page → **Get free** | `acquire_free_ebook` grants access. The reader opens at `/{locale}/read/<bookId>`. |
| Buy | Book page → **Buy ebook** | `create_edition_order` creates or reuses a pending order for ONE edition (`create_ebook_order` is the work-level wrapper and refuses a work with several editions on sale). |
| Checkout | `/{locale}/checkout/<orderId>` | Shows the ebook, the total, the account email, and **Pay**. |
| Simulate | `/{locale}/checkout/<orderId>/simulate` | **Succeed**, **Fail**, **Cancel**, or **Send duplicate**. Simulator only; local, test, and staging only. |
| Transfer | `/{locale}/checkout/<orderId>/transfer` | Bank details and the order reference. Manual provider only - see [manual bank transfer](manual-payment.md). |
| Status | `/{locale}/checkout/<orderId>/status` | Reads the order from the database. |
| Orders | `/{locale}/account/orders` | The reader's own orders. |
| Admin | `/admin/orders` | Find an order by email or ID. Revoke the access it granted. |

A signed-out reader who clicks Get or Buy signs in first and returns to the book page.

## Order states

| Order | Payment | Reader sees |
| --- | --- | --- |
| `pending` | `pending` | Awaiting payment |
| `pending` | `failed` | Payment failed. **Try again** reuses the same order. |
| `completed` | `succeeded` or `not_required` | Completed, with **Read now** |
| `cancelled` | `cancelled` | Cancelled |

On the manual provider these same four rows carry different labels, and whether a reader has reported
their transfer splits the first row in two; see
[manual bank transfer](manual-payment.md). No status value is added for it.

Only `apply_payment_event` changes an order after it is created. It ignores a duplicate event ID and any
event for an order that is already completed or cancelled. A browser redirect never changes an order.

If the price changes while an order is pending (an admin edit, or a [book sale](book-sale.md)
starting or ending), the next **Buy** click cancels that order and creates a new one at the current
price. The one exception is a manual order whose transfer the reader has already reported: it is
kept at the price they transferred, and **Buy** returns it.

## The payment settings

A paid order needs all three of these, and the two providers must agree:

1. The app: `PAYMENT_PROVIDER` set to a real provider - `simulator` outside production, or `manual`
   anywhere including production. The app refuses to start with `simulator` in
   production, and `manual` additionally requires all four `BANK_TRANSFER_*` variables
   ([manual bank transfer](manual-payment.md)). `disabled` means nobody can buy anything. This
   decides which checkout pages and actions exist.
2. The database: `commerce_settings.payments_enabled = true`. The default is `false`.
3. The database: `commerce_settings.payment_provider`, which is the provider `create_ebook_order`
   books each new order under - it writes that value into the order's `payments` row, and every
   provider-specific surface finds an order by it. It must be set to the same provider as
   `PAYMENT_PROVIDER`; nothing enforces that. A pending order booked under the other provider is
   cancelled and replaced on the next **Buy** click rather than reused.

The cloud Supabase project is shared with production. **Keep `payments_enabled = false` there.** With it
off, `create_ebook_order` fails with `EB011`, and readers see "Buying ebooks is not available yet."

On a local stack, turn it on with:

```bash
psql "$(supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" \
  -c "update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';"
```

The Playwright suite does this through the service role before paid journeys.

## Simulator

- The webhook is `POST /api/payments/simulator/webhook`. It needs the `x-simulator-signature: sha256=<hex>`
  header, which is an HMAC-SHA256 of the raw body using `PAYMENT_SIMULATOR_SECRET`.
- Missing or wrong signature: 401. Malformed body: 400. Unknown order or amount mismatch: 422.
- Outside local, test, and staging, or when the provider is not `simulator`, the webhook and the
  simulate page return 404.
- The simulate buttons call the same handler in the server process. They do not send an HTTP request.

## Revoke access from an order

1. Open `/admin/orders` and search by the customer's email or the order ID.
2. Open the order. **Access** shows the entitlement this order granted.
3. Enter a reason and choose **Revoke access**.

This revokes only the entitlement whose source is this order. Complimentary grants and other orders
are never affected. The order stays `completed`. One `audit_logs` row records the actor, reason, order,
reader, and book. A reader whose free-order access was revoked can claim a still-free book again.

## Common questions

- **"Buy ebook" returns to the book page with an error.** Read the message:
  - "not available yet" means the database gate is off.
  - "cannot be bought right now" means the book is not published, has no published active
    publication, or has no active paid offer.
- **The status page says "Processing".** No event has reached the order yet. The page refreshes for 30
  seconds. On the simulator, return to the simulate page and choose an outcome.
- **The app will not start after pulling S3.** Add `PAYMENT_SIMULATOR_SECRET` (at least 32 characters) to
  `.env.local` when `PAYMENT_PROVIDER=simulator`.
- **The status page never says "Processing" on the manual provider.** It has no processing moment:
  it is waiting on the reader, waiting on us, or resolved. See
  [manual bank transfer](manual-payment.md).

Keep the request ID from any error. Server logs include it.
