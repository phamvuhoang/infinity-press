# Runbook: SePay payment gateway

Readers pay for an order by scanning a VietQR code on SePay's hosted payment page. SePay then
notifies this application, and the order completes with no admin step. This is the `sepay` payment
provider. [Get and buy](checkout.md) covers what every provider shares.

Only the bank-transfer (VietQR) method is used. Card and NAPAS QR are not.

## 1. Turn it on

Four settings in the app and two in the database. They must name the same provider; nothing
enforces that.

| Variable | Value |
| --- | --- |
| `PAYMENT_PROVIDER` | `sepay` |
| `SEPAY_MERCHANT_ID` | from my.sepay.vn → Payment gateway → integration details |
| `SEPAY_SECRET_KEY` | the same screen. Server-only. Never in a client bundle, a log, or a ticket |
| `SEPAY_ENV` | `sandbox` or `production`. Must match the credentials |

`APP_ENV=production` refuses `SEPAY_ENV=sandbox`. `APP_ENV=local` and `test` refuse
`SEPAY_ENV=production`. The app does not start otherwise.

```sql
update public.commerce_settings set payments_enabled = true, payment_provider = 'sepay';
```

In SePay (Payment gateway → Configuration → IPN), set the IPN URL to
`https://<site>/api/payments/sepay/ipn`. Sandbox and production each have their own. Set IPN
authentication type to `SECRET_KEY` and verify the configured key matches `SEPAY_SECRET_KEY`.
Without this authentication type, SePay does not send `X-Secret-Key` and the app refuses every IPN.
Confirm this with an actual sandbox delivery; never log the header value.

## 2. What happens

| Step | Where |
| --- | --- |
| Reader presses **Pay** | `/{locale}/checkout/<orderId>` |
| A signed form posts the order to SePay | `/{locale}/checkout/<orderId>/sepay` |
| Reader scans the QR and pays | SePay |
| SePay notifies the app; the order completes | `POST /api/payments/sepay/ipn` |
| Reader is sent back | `/{locale}/checkout/<orderId>/status` |

Only the notification completes an order. Coming back from SePay never does.

The invoice number SePay shows is the order reference plus the amount: `IB-7K2MX-89000` is order
`IB-7K2MX` for 89,000 VND. Search `/admin/orders` by the reference.

## 3. Test in the sandbox

1. Use sandbox credentials and `SEPAY_ENV=sandbox` on a staging deployment, or locally behind a
   tunnel (`cloudflared tunnel --url http://localhost:3000`). SePay cannot reach `localhost`.
2. Set the sandbox IPN URL to that HTTPS origin and enable auth type `SECRET_KEY`. Verify the
   header matches without storing its value. An unset or wrong header must produce 401.
3. Buy a paid book and complete the sandbox payment.
4. The status page shows **Payment complete** within a few seconds.

Last run against the sandbox: _not yet - record the date here after the first run (S18 plan Task 1)._

## 4. Go live

1. In SePay, link the real bank account and switch the gateway to Production.
2. Replace `SEPAY_MERCHANT_ID` and `SEPAY_SECRET_KEY` with the production pair; set
   `SEPAY_ENV=production`.
3. Set the production IPN URL and auth type `SECRET_KEY`; verify the key matches the deployment.
4. Run the SQL in section 1 against production.
5. Buy the cheapest book with a real transfer. Confirm it completes, then refund yourself in the
   bank.

## 5. When a payment does not settle

Find the notification in the server logs by the invoice number or by "SePay IPN". Every line has a
request ID.

| Log | Meaning | Do |
| --- | --- | --- |
| No line at all | SePay never reached the app | Check the IPN URL in SePay and SePay's own IPN log |
| `rejected: malformed` (400, error level) | The secret was right but a field was not in the expected shape. The line carries the invoice number, SePay's order ID and the amount as received | Look the order up by the invoice number; if the reader paid, grant access or refund, then send the payload to SePay support and fix the parser |
| `rejected: bad secret` (401) | IPN auth is not `SECRET_KEY`, or the key does not match | Check auth type, key and environment; verify a delivery. If redelivery is unavailable, reconcile and grant by hand |
| `does not match its order` (422) | The amount paid is not the order's total. Usually a coupon was applied after the QR was shown | Compare `amountMinor` with the order. Grant access and settle the difference, or refund |
| `paid a cancelled order` (422, `manual_resolution_required`) | Money arrived after local cancellation | Use the logged invoice, event ID, SePay order ID, amount and currency to reconcile; grant access or refund. Retrying does not reopen the order |
| `already completed by another payment` (422, `manual_resolution_required`) | The order was paid once and a second, different SePay order was paid for it - typically a coupon repriced the order after a first QR was shown, and both QRs were paid | `externalPaymentId` is the extra payment, `recordedExternalPaymentId` the one that completed the order. The reader owns the book; refund the extra payment in the bank. Retrying does not change anything |
| `names no order` (422) | No order has that reference | Refund in the bank |
| `acknowledged without action` | Not a completed bank-transfer payment | Nothing |
| `failed` (500) | The app or the database failed | Fix the cause. SePay should retry; if it does not, grant by hand |

Operators must monitor the SePay IPN error logs, including `manual_resolution_required`; a 422
is not a refund and SePay retries are not a recovery procedure. Retain these logs because late
payments on cancelled orders do not update the payment row with their external ID or amount.

To grant by hand, use `/admin/users` → the reader → grant access. There is no admin action that
cancels a SePay order, and none is needed: leave a still-pending order alone. If its QR is paid
later the order completes and keeps the access you granted (the grant is by reader and book, so no
second entitlement is created); if you refunded instead, the reader's next **Buy** simply reuses it.
An already cancelled order stays cancelled. Refunds happen in the bank, not here.

There is no reconciliation job. An order paid on SePay whose notification never arrived stays
pending until someone handles it as above.

## 6. Turn it off or switch back to manual

Set `PAYMENT_PROVIDER=manual` and `commerce_settings.payment_provider = 'manual'`. Leave the three
`SEPAY_*` variables in place for a day: the notification endpoint keeps answering while they are
set. An existing SePay order settles while still pending. The next **Buy** cancels and replaces
it as stale; if its QR is paid afterwards, the handler logs `manual_resolution_required` and
returns 422 without reopening the order. Follow section 5 to grant access or refund.

## 7. Rotate the secret

Generate the new secret in SePay, set `SEPAY_SECRET_KEY`, and redeploy at once. Between the two
steps every notification is refused with 401; handle any payment in that window with section 5.
