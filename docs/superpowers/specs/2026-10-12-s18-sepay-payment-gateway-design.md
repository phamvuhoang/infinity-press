# S18 SePay Payment Gateway (VietQR) Design

**Status:** Draft - awaiting review
**Date:** 2026-10-12
**Builds on:** S3 get and buy, S7 manual bank-transfer payment, S8 coupons, S9 bundles and gifts
**Source:** SePay payment gateway docs, <https://developer.sepay.vn/vi/cong-thanh-toan/bat-dau>
(quick start, payment flow, sandbox, API overview, IPN, Node.js SDK) and the SDK source
`sepayvn/sepay-pg-node` for the signature format, which the docs do not describe.

## 1. Goal

A reader pays for an ebook order by scanning a VietQR code on SePay's hosted payment page, and the
order completes on its own within seconds. Nobody confirms a transfer by hand.

S7's manual provider stays in the codebase as the fallback. S18 adds a third provider value,
`sepay`, behind the existing `PaymentProvider` interface. A deployment still runs exactly one
provider, chosen by `PAYMENT_PROVIDER`.

## 2. What S18 delivers

| Surface | Who | Result |
| --- | --- | --- |
| `PAYMENT_PROVIDER=sepay` | Operator | Paid orders settle through SePay, in sandbox or production |
| `/{locale}/checkout/[orderId]/sepay` | Reader | A signed form that posts the order to SePay's checkout page |
| SePay hosted page | Reader | The VietQR code, scanned in a banking app |
| `POST /api/payments/sepay/ipn` | SePay | The payment notification that completes the order |
| `/{locale}/checkout/[orderId]/status` | Reader | Processing, then completed with **Read now** |
| `/admin/orders/[orderId]` | Admin | The payment row with provider `sepay` and SePay's order ID |
| `docs/runbooks/sepay-payment.md` | Operator | Setup, go-live, and what to do when a payment does not settle |

## 3. Not in S18

- **Card and NAPAS QR.** Only `payment_method=BANK_TRANSFER`. The other two need a separate SePay
  application.
- **Refunds, void, and cancel through the API.** Refunds stay off-platform, as in S7.
- **Two providers at once.** A reader is not offered a choice between SePay and manual transfer.
- **An in-page QR.** The QR lives on SePay's page. Embedding it would mean the bank-API product, a
  different integration from the one this spec follows.
- **The `sepay-pg-node` SDK.** See 5.1.
- **Order lookup against SePay's REST API** (reconciliation, IPN double-check). See 9.
- **Recurring payments.** SePay has not shipped them.

## 4. Flow

1. The reader clicks **Buy**. `create_ebook_order` or `create_bundle_order` books a pending order
   under `commerce_settings.payment_provider = 'sepay'`. Unchanged.
2. The reader clicks **Pay** on `/{locale}/checkout/[orderId]`. `payOrderAction` runs its existing
   checks and calls `SepayProvider.createSession`, which returns
   `/{locale}/checkout/[orderId]/sepay`.
3. That page builds the checkout fields from the order, signs them, and renders a form that posts to
   SePay's `/v1/checkout/init`. The form submits itself; a visible button covers a browser without
   JavaScript.
4. SePay shows the VietQR code. The reader pays in their banking app.
5. SePay sends `ORDER_PAID` to `/api/payments/sepay/ipn`. The handler checks `X-Secret-Key`, maps
   the notification to a `VerifiedPaymentEvent`, and calls `apply_payment_event`. That function
   completes the order and grants the entitlement, or activates the gift.
6. SePay redirects the reader to the status page, which reads the order from the database.

Step 5 is the only step that changes an order. The redirect in step 6 never does; that is the S3
rule and it holds here.

## 5. Checkout request

### 5.1 Signing without the SDK

The SDK pulls in `axios` for REST calls S18 does not make. The only thing S18 needs from it is the
signature, which is a few lines of `node:crypto`:

- Take the fields in the order of 5.2. Every field S18 sends is in SePay's signed set.
- Join them as `name=value` pairs separated by commas, with no escaping.
- `signature = base64(HMAC-SHA256(secret_key, that string))`.

The signed string follows the order of the fields, so the form must render its inputs in the same
order it signed. One ordered array feeds both. The order in 5.2 is the one the SDK produces, with
`merchant` last, so the request is byte-for-byte what an SDK integration would send.

This format comes from reading the SDK source, not from the docs. It was checked on 2026-10-12
against `sepay-pg-node` 1.0.0: the vector in the plan's Task 3 is the SDK's own output. Task 1 of
the plan confirms it against the sandbox before release. Implementation may proceed in parallel,
but sandbox acceptance remains a release gate.

### 5.2 Fields

| Field | Value |
| --- | --- |
| `operation` | `PURCHASE` |
| `payment_method` | `BANK_TRANSFER` |
| `order_invoice_number` | `<reference_code>-<totalMinor>`, e.g. `IB-7K2MX-89000` |
| `order_amount` | `String(order.totalMinor)` |
| `currency` | `VND` |
| `order_description` | `Infinity Books <reference_code>` |
| `success_url` | `<SITE_URL>/{locale}/checkout/<orderId>/status?sepay=success` |
| `error_url` | the same path with `?sepay=error` |
| `cancel_url` | the same path with `?sepay=cancel` |
| `merchant` | `SEPAY_MERCHANT_ID` |
| `signature` | 5.1 |

Amount and currency come from the order row, never from the request.

**VND only.** `order_amount` passes the minor amount straight through, which is right for VND and
100x wrong for a currency with a minor unit. The page sends a non-VND order to the status page
instead. This is the same rule as `buildVietQrImageUrl` in S7.

**Why the amount is in the invoice number.** SePay requires a unique invoice number per order. A
reader can apply a coupon to a pending order after a first trip to SePay, which changes the total
on the same order. With the bare reference, the second trip would reuse an invoice number under a
different amount. With the amount as a suffix, an unchanged order maps to the same SePay order and
a repriced order maps to a new one, and nothing has to be stored. The IPN handler reads the
reference back out of the prefix.

### 5.3 The page

`/{locale}/checkout/[orderId]/sepay` calls `requireUser()` itself. It redirects to the status page
unless the order is the viewer's, is pending, is not already fully owned, was booked under `sepay`,
and the deployment runs `sepay`. This mirrors the transfer page: the provider check is on the order
and on the environment.

The form's hidden inputs carry no secret. The signature is public by design.

## 6. Payment notification (IPN)

### 6.1 Request

Configure IPN authentication as `SECRET_KEY` in each SePay environment. SePay sends
`X-Secret-Key: <secret_key>` only with that authentication type enabled; setting the IPN URL alone
is insufficient. Confirm an actual sandbox delivery carries the expected header.

SePay sends `POST` with `Content-Type: application/json`. The docs
describe no body signature, so the header is the whole authentication. The handler compares it to
`SEPAY_SECRET_KEY` with `timingSafeEqual`.

The fields S18 reads:

```json
{
  "timestamp": 1757058220,
  "notification_type": "ORDER_PAID",
  "order": {
    "order_id": "NPSETVI00101000042R",
    "order_status": "CAPTURED",
    "order_currency": "VND",
    "order_amount": "89000.00",
    "order_invoice_number": "IB-7K2MX-89000"
  },
  "transaction": {
    "transaction_id": "...",
    "payment_method": "BANK_TRANSFER",
    "transaction_status": "APPROVED"
  }
}
```

### 6.2 Mapping

| `VerifiedPaymentEvent` | From |
| --- | --- |
| `provider` | `"sepay"` |
| `eventId` | `transaction.transaction_id` |
| `externalPaymentId` | `order.order_id` |
| `orderId` | the order whose `reference_code` is the invoice number's prefix |
| `status` | `"succeeded"` |
| `amountMinor` | `order.order_amount` parsed as a number; must be a non-negative integer |
| `currency` | `order.order_currency` |
| `occurredAt` | `timestamp` as ISO 8601 |

The parser requires a non-empty `transaction.payment_method`; missing or malformed values are
400. A method other than `BANK_TRANSFER` is acknowledged without action.

`apply_payment_event` already does the rest: it ignores a repeated event ID, ignores an event for a
completed or cancelled order, and refuses an amount, currency, or provider that does not match the
order.

### 6.3 Responses

| Case | Status | Body |
| --- | --- | --- |
| SePay is not configured on this deployment | 404 | `{"error":"not_found"}` |
| Missing or wrong `X-Secret-Key` | 401 | `{"error":"unauthorized"}` |
| Not JSON, or a required paid-event field in 6.2 (including payment method) is missing or malformed | 400 | `{"error":"malformed_event"}` |
| `notification_type` is not `ORDER_PAID`, statuses are not `CAPTURED` and `APPROVED`, or a non-empty `payment_method` is not `BANK_TRANSFER` | 200 | `{"success":true}`, logged, no state change |
| No order has that reference; or `apply_payment_event` refuses the event | 422 | `{"error":"event_rejected"}` |
| Authenticated paid notification resolves to a cancelled order | 422 | `{"error":"manual_resolution_required"}`, error log with payment identifiers and amount |
| Authenticated paid notification names a SePay order other than the one that completed the order (a second payment, e.g. a repriced invoice and the old QR both paid) | 422 | `{"error":"manual_resolution_required"}`, error log with both SePay order IDs, amount and currency |
| Applied, including a repeat of a completed payment | 200 | `{"success":true}` |
| Anything else | 500 | `{"error":"unexpected"}` |

Every response carries the request ID, and every log line does too. Logs never carry the secret.

A 422 means SePay took money this application could not attach to an order. It is logged at error
level with the invoice number and SePay's order ID. The runbook covers it (8).

**The handler answers whenever SePay credentials are configured, not only when
`PAYMENT_PROVIDER=sepay`.** If an operator switches the deployment back to `manual` while a reader
is on SePay's page, their payment must still be handled. `apply_payment_event` checks the provider the
order was booked under. This settles an in-flight payment only while its order remains pending.

A new **Buy** after a provider switch can cancel the old order through the existing stale-order
logic. S18 preserves that cancellation policy and never resurrects a cancelled order. After
`apply_payment_event`, inspect the returned order status: a cancelled outcome from `ORDER_PAID`
requires an error log and a 422 `manual_resolution_required` response, including on redelivery.
The log contains request ID, local order ID, invoice number, provider event ID, SePay order ID,
amount and currency. Operators must review these errors and grant access or refund; retries alone
cannot resolve them. Do not record purchase analytics for this outcome. The database records the
event but does not attach its external payment ID or amount to the cancelled payment row, so the
operational log must retain these details.

Analytics (`purchase`, `payment_failed`) are recorded from the state `apply_payment_event` returns,
through the function the simulator webhook already uses, moved to a shared module.

## 7. Configuration and data

### 7.1 Environment

| Variable | Rule |
| --- | --- |
| `PAYMENT_PROVIDER` | gains `sepay` |
| `SEPAY_MERCHANT_ID` | required when `PAYMENT_PROVIDER=sepay` |
| `SEPAY_SECRET_KEY` | required when `PAYMENT_PROVIDER=sepay`; server-only |
| `SEPAY_ENV` | `sandbox` or `production`; required when `PAYMENT_PROVIDER=sepay` |

Normalize empty strings in the three `SEPAY_*` variables to unset before validation, so the
blank values in `.env.example` work for non-SePay deployments. All three or none. `APP_ENV=production` requires `SEPAY_ENV=production`, so production cannot
complete orders from sandbox payments. `APP_ENV=local` and `test` require `SEPAY_ENV=sandbox`, so
a development machine cannot take real money.

| `SEPAY_ENV` | Checkout form action |
| --- | --- |
| `sandbox` | `https://pay-sandbox.sepay.vn/v1/checkout/init` |
| `production` | `https://pay.sepay.vn/v1/checkout/init` |

The IPN URL is set once per SePay environment in the SePay dashboard:
`<SITE_URL>/api/payments/sepay/ipn`.

### 7.2 Database

Two migrations, because Postgres will not use a new enum value in the transaction that added it.

1. `entitlement_source` gains `sepay_payment`.
2. - `payments_provider_check`, `orders_payment_provider_check`, and the check on
     `commerce_settings.payment_provider` accept `sepay`.
   - `apply_payment_event` and `claim_gift` map provider `sepay` to source `sepay_payment`.
   - `revoke_order_entitlement` counts `sepay_payment` among the order-backed sources. S7 missed
     this list for `manual_payment` and S9 had to fix it.

Each function is replaced whole, copied from its latest definition, with one added line. No
signature, grant, or lock order changes.

`lib/supabase/database.types.ts` is regenerated. The hand-written source-type unions in
`lib/data/admin-orders.ts` and `lib/data/users.ts` gain `sepay_payment`.

### 7.3 Reader-facing states

A SePay order uses the S3 views that the simulator uses: processing, success, failed, cancelled.
No new status value and no change to `customerOrderStatus`.

Returning from SePay with `?sepay=cancel` or `?sepay=error` shows a still-pending SePay order in
the existing failed view, with **Try again** leading back to checkout. The query parameter selects
the view only; it changes no data, and it is ignored once the order is completed or cancelled.

## 8. Operations

`docs/runbooks/sepay-payment.md` covers:

- **Setup.** The four environment variables, the two `commerce_settings` values, and the IPN URL,
  given as one procedure, because the app and the database must name the same provider. Include
  IPN auth type `SECRET_KEY` and an actual sandbox header check.
- **Go-live.** Link the bank account in SePay, switch SePay to production, replace the sandbox
  credentials, set the production IPN URL, make one real purchase.
- **A reader paid and has no book.** Find the request by invoice number in the logs. A 401 means
  the secret in the deployment and in SePay differ. A 422 means the amount no longer matches (a
  coupon changed the total after the QR was shown) or the order is unknown. Grant access from
  `/admin/users`, or refund in the bank.
- **Switching back to manual.** Keep the credentials configured for late IPNs. Pending SePay
  orders still settle until cancelled; they become stale on the next **Buy**. A payment received
  for a cancelled order requires manual resolution (6.3), never silent acknowledgement.

`docs/runbooks/checkout.md` and `.env.example` gain the third provider.

## 9. Known limits

- **A lost IPN leaves a paid order pending.** SePay's retry policy is undocumented. S18 has no
  reconciliation job. The remedy is the runbook's manual grant. Add an admin "check with SePay"
  action, which is one `GET` on SePay's order API, the first time this actually happens.
- **A leaked secret forges payments.** The IPN's only authentication is the shared secret. Looking
  the order up on SePay's API before applying the event would close that. It is deferred because
  the damage is bounded to ebook access and the lookup's response shape is undocumented.
- **A payment against a superseded amount is not applied.** See 8.

## 10. Testing

| Layer | Covers |
| --- | --- |
| Vitest, `lib/commerce/sepay.test.ts` | The signature against an SDK-generated vector; field order; the invoice number round trip; VND refusal; every 6.2 parse failure |
| Vitest, `lib/commerce/sepay-ipn.test.ts` | Every row of 6.3 |
| Vitest, `lib/config/server-env.test.ts` | Every rule in 7.1 |
| Vitest, page and action tests | The `/sepay` page's guards and its rendered form; `payOrderAction` redirecting a SePay order |
| pgTAP | The three constraints accept `sepay`; a `sepay` event completes an order and grants `sepay_payment`; a gift order activates; revoke works on a SePay order; EB016 on a provider mismatch |
| Playwright, `e2e/sepay-payment.spec.ts` | Real database regression: provider switch → Buy cancels old order → late IPN and repeat both require manual resolution, no entitlement. Also Buy, reach the form with the right action and fields, post an IPN with the test secret, see **Read now**. A third web server, as S7 added a second. SePay itself is never contacted |
| Manual, sandbox | One real sandbox payment through a tunnel, recorded in the runbook |

## 11. Open questions for the sandbox

Task 1 of the plan answers these before release. Each has a fallback that changes one
function.

1. Does the sandbox accept the signature? It already matches the SDK's. Fallback: adopt the SDK
   for signing only.
2. Does SePay accept hyphens in `order_invoice_number`? Fallback: underscores.
3. What happens when the same unpaid invoice number is posted again: is the order reopened or
   refused? Fallback if refused: add a time suffix to the invoice number.
4. What is `transaction.transaction_id` for a bank transfer, and is it stable across IPN retries?
   Fallback: use `order.order_id` as the event ID.
