# S7 Manual Bank-Transfer Payment Design

**Status:** Approved
**Date:** 2026-09-21
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (supersedes its "real provider is a separate post-launch spec" note)
**Builds on:** S3 get and buy, S4 reader completion, S5 SEO and operations, S5.5 reader depth
**Followed by:** S8 commerce growth (coupons, bundles, gifts), S10 physical fulfillment

## 1. Goal

Infinity Books sells paid ebooks before any payment partner is integrated. A reader buys a book,
transfers money to the company bank account, and an admin confirms receipt. Confirmation grants the
entitlement, and the reader opens the book immediately.

S7 is the first sub-project after the MVP. It replaces the launch decision that production ships with
free books only: with a manual provider, production can charge for ebooks on the day it goes live.

## 2. What S7 Delivers

| Surface | Who | Result |
| --- | --- | --- |
| `PAYMENT_PROVIDER=manual` | Operator | Production accepts paid orders without a payment partner |
| `/{locale}/checkout/[orderId]/transfer` | Reader | Bank details, order reference, VietQR image, and "I have transferred" |
| `/{locale}/checkout/[orderId]/status` | Reader | Awaiting transfer, awaiting confirmation, confirmed, or declined |
| `/{locale}/account/orders` | Reader | The same manual states in order history |
| `/admin/payments` | Admin | A queue of manual payments, claimed orders first |
| `/admin/orders/[orderId]` | Admin | Confirm with received amount and bank reference, or decline with a reason |
| `/admin/operations` | Admin | Claims unhandled for more than 24 hours |
| `/admin/operations` and the scheduled alert | Admin | Unreviewed claims, through the existing S5 alerting path |
| `notification_outbox` | Reader | The existing book-ready email on confirmation, unchanged |

## 3. Out of Scope

- Physical books, shipping addresses, and fulfillment status. S10 owns those.
- Bank statement import, webhook, or API from any bank or payment intermediary.
- Automatic reconciliation of transfers against orders.
- Refunds of money already received. Access revocation already exists through
  `revoke_order_entitlement`; returning funds stays a manual, off-platform action.
- Coupons, discounts, bundles, and gifts. S8 owns those.
- Partial payments and instalments. An order is confirmed in full or not at all.
- Cart and multi-book orders. One order still holds one ebook item.
- Automatic expiry of pending orders.

## 4. Decisions

| Topic | Decision |
| --- | --- |
| Architecture | `manual` is a `PaymentProvider`, not a parallel path. Admin confirmation becomes a synthetic payment event applied through the existing `apply_payment_event` RPC. |
| Entitlement path | Unchanged. `apply_payment_event` remains the only way a purchase grants access. |
| Order states | No new `order_status` or `payment_status` value. Manual states are derived, not stored as enum values. |
| Reader claim | Optional. An admin can confirm a transfer the reader never reported. |
| Expiry | A pending order never expires on its own. Only an admin cancels it. |
| Reconciliation | Confirmation requires the received amount and the bank transaction reference. |
| Amount mismatch | Blocked by default. An admin may override explicitly, and the override is audited. |
| Bank details | Read from the server environment. Changing them is a deployment, not an admin screen. |

## 5. Architecture

### 5.1 Why a provider and not a separate flow

`apply_payment_event` already carries the correctness this feature needs: it locks the order row,
deduplicates by `(provider, provider_event_id)`, refuses to resurrect a cancelled order, refuses to
re-derive an outcome for a completed one, and grants exactly one entitlement through the
`entitlements_active_subject_key` conflict target. A second grant path would have to reproduce all of
it, and AGENTS.md requires entitlements to flow through the authenticated database functions.

Two alternatives were rejected:

- A dedicated `manual_payments` table with its own entitlement insert. Faster to write, but it
  creates a second authorization model for paid access and duplicates every idempotency rule.
- Reusing `admin_grant` entitlements. There is then no order, no payment record, and no financial
  trail to reconcile against a bank statement.

### 5.2 Provider registration

- `payments.provider` check constraint gains `'manual'`.
- `entitlement_source` enum gains `'manual_payment'`.
- A new migration replaces `apply_payment_event` so `source_type` is derived from `p_provider`
  (`simulator` → `simulated_payment`, `manual` → `manual_payment`, anything else raises). Every other
  line of the function is unchanged; the replacement carries the existing pgTAP suite forward.
- `PAYMENT_PROVIDER` accepts `disabled | simulator | manual`. Production accepts `manual` and
  continues to reject `simulator`. `commerce_settings.payments_enabled` is set to `true` where manual
  payments are live.
- `commerce_settings` gains `payment_provider text not null default 'simulator'`, constrained to
  `simulator` or `manual`, and `create_ebook_order` books the order's `payments` row from it instead
  of the `'simulator'` literal it hard-coded for the MVP. **Without this the entire manual path is
  inert**: `claim_manual_transfer`, `confirm_manual_payment`, `reject_manual_payment` and
  `listManualPaymentQueue` all identify a manual order by joining `payments` on
  `provider = 'manual'`, so with no such row a reader's first "I have transferred" raises `EB020`,
  the admin queue is permanently empty, and the confirm and decline forms never render.

  The provider is not a parameter of `create_ebook_order`. That function is executable by
  `authenticated`, so a reader calling PostgREST directly could otherwise choose which provider their
  own order is booked under. `commerce_settings` already exists to be the database's own half of a
  decision the environment also knows — `payments_enabled` duplicates "is a provider configured" on
  purpose, so that a database test can prove a production database refuses paid orders — and this
  extends that deliberate duplication rather than adding a new kind.

  The duplication has a cost: `commerce_settings.payment_provider` and the `PAYMENT_PROVIDER`
  environment variable can disagree, and if they do, orders are booked under one provider while the
  application renders and confirms under the other. The two are set together, in one procedure, and
  `docs/runbooks/manual-payment.md` states the steps. An operational rule comparing them is
  worthwhile follow-up work and is deliberately not in S7.

  `create_ebook_order` reuses a caller's existing pending order for the same book. It reuses one only
  when that order's payments row matches the active provider, and otherwise cancels and replaces it —
  the same treatment it already gives an order whose price snapshot has gone stale. A provider switch
  is the second way an order goes stale.
- `ManualProvider implements PaymentProvider` in `lib/commerce/manual.ts`. `createSession(order)`
  returns `/{locale}/checkout/[orderId]/transfer`, an internal path, so no browser redirect ever
  leaves the site. `verifyEvent` accepts only events this application generated, and the only caller
  is the admin confirm/decline action.

### 5.3 Order reference code

`orders.reference_code text not null unique`. Format `IB-` followed by five Crockford base32
characters, excluding the visually ambiguous letters. `create_ebook_order` generates it and retries on
a unique violation. The migration backfills existing rows before adding the not-null constraint.

The reference is the bank transfer memo, the string the reader copies, and the admin's search key.

### 5.4 Derived manual states

No enum changes. A manual order awaiting money is `status='pending'`, `payment_status='pending'`, with
`orders.payment_provider = 'manual'`. What separates "waiting for the reader" from "waiting for us" is
whether a claim row exists.

The provider a reader-facing surface reads is `orders.payment_provider`, never `payments.provider`.
`public.payments` carries one RLS policy and it is admin-only, so a reader's embed of it returns
nothing and any state derived from it is dead code in production. This was not obvious and cost the
branch a Critical finding: the spec originally said nothing about how a reader-facing surface learns
the provider, and every reader-facing manual state was unreachable until the whole-branch review
caught it. A column grant was considered and rejected — an admin is also the `authenticated` role
and column privileges attach to a role rather than to a policy, so withholding `external_payment_id`
from `authenticated` would break the admin order page.

`lib/commerce/manual-transfer-view.ts` holds one pure function:

```ts
type ManualTransferState =
  | "awaiting_transfer"
  | "awaiting_confirmation"
  | "confirmed"
  | "declined"
  | "cancelled";

resolveManualTransferState(input: {
  orderStatus: OrderStatus;
  paymentStatus: PaymentStatus;
  claimedAt: string | null;
  declinedAt: string | null;
}): ManualTransferState;
```

- `confirmed` when the order is `completed`.
- `cancelled` when the order is `cancelled`.
- `declined` when the order is `pending`, the payment status is `failed`, and no claim is newer than
  the most recent decline.
- `awaiting_confirmation` when the order is `pending` and a claim exists that is newer than the most
  recent decline, or newer than nothing because there has been no decline.
- `awaiting_transfer` otherwise.

**A decline is not permanent, so this is a recency comparison rather than a precedence.**
`reject_manual_payment` with `not_received` leaves `payment_status = 'failed'` and nothing resets it,
so ranking `failed` above the presence of a claim — which the spec originally did — leaves a reader
who transfers again looking at the decline banner forever, on the screen the runbook tells them to
use as many times as it takes. The admin side is unaffected, which is what made it invisible: the
queue and the operator alert both see the recreated claim.

Adding `awaiting_confirmation` to `payment_status` was considered and rejected: it would reopen the
S3 transition table in `lib/commerce/order-state.ts` and its pgTAP mirror for a distinction that only
ever affects a label.

### 5.5 Claims

```
manual_transfer_claims
- order_id uuid primary key references orders(id)
- profile_id uuid not null references profiles(id)
- claimed_at timestamptz not null default now()
- note text            -- optional, at most 500 characters
```

Writes go through `claim_manual_transfer(p_order_id uuid, p_note text)`, a `security definer` RPC
executable by `authenticated`, matching how every other state change in this codebase is made. It
resolves the profile from `auth.uid()`, refuses any order that is not the caller's own `pending`
order with a `manual` payment, and inserts the row. The primary key on `order_id` makes a double
click a no-op.

RLS on the table itself grants `select` only: a reader reads rows whose `profile_id` resolves from
`auth.uid()`, an admin reads every row, and no role holds `insert`, `update`, or `delete`.

### 5.6 Confirmation and decline

Two `security definer` RPCs. Both check the admin role in the database as well as in the Server
Action, and both write one `audit_logs` row.

```
confirm_manual_payment(
  p_order_id uuid,
  p_received_amount_minor bigint,
  p_bank_reference text,
  p_note text,
  p_accept_mismatch boolean default false
) returns table (entitlement_id uuid, order_status order_status, payment_status payment_status)
```

`apply_payment_event` raises `EB004` when the event amount differs from the order total, so the
received amount is recorded on the confirmation record while the event itself carries the order total.
When `p_received_amount_minor` differs from the order total and `p_accept_mismatch` is false, the RPC
raises a dedicated error code and changes nothing; the admin form then shows the difference and
requires an explicit override. An accepted mismatch is recorded in the audit summary.

`p_bank_reference` is required and non-empty. The synthetic event uses
`provider_event_id = 'manual:' || p_order_id || ':confirmed'` and `external_payment_id = p_bank_reference`,
so confirming twice replays into the existing no-op branch and grants nothing new.

```
reject_manual_payment(
  p_order_id uuid,
  p_reason text,
  p_outcome text           -- 'not_received' | 'cancel'
) returns table (order_status order_status, payment_status payment_status)
```

`not_received` emits a `failed` event: the order stays `pending`, so the reader can transfer again.
It also deletes the claim row, returning the order to
`awaiting_transfer` and letting the reader report a fresh transfer. `cancel` emits a `cancelled` event
and ends the order. Both require a non-empty reason, and the reason is stored on
`manual_payment_declines` (`order_id`, `sequence`, `admin_profile_id`, `reason`, `outcome`,
`declined_at`) so the reader-facing status can quote the most recent one.

`provider_event_id` is `manual:<order_id>:cancelled` for a cancellation, which is therefore idempotent,
and `manual:<order_id>:not_received:<sequence>` for a decline, where `sequence` is the
`manual_payment_declines` row's own sequence number for that order. A repeated "not received" is a new
decline and a new event; replaying a given decline is a no-op.

Confirmation stores its evidence in a `manual_payment_confirmations` row (`order_id` primary key,
`admin_profile_id`, `received_amount_minor`, `bank_reference`, `note`, `mismatch_accepted`,
`confirmed_at`), readable by admins only.

## 6. Screens

### 6.1 Transfer instructions

`/{locale}/checkout/[orderId]/transfer`, dynamic, `noindex`, `requireUser()`, and 404 for an order the
caller does not own.

It shows the book, the total, the bank name, account number and account holder from the server
environment, the order reference with a copy control, and a VietQR image built from a static image
URL carrying the account, amount, and reference. The QR is decoration: the page stays complete and
usable when the image fails to load, and it carries no credential.

A single Server Action inserts the claim and re-renders the page as "awaiting confirmation". A signed-in
reader who is not the owner, or an order that is not `pending` manual, gets a 403 from the action.

### 6.2 Status and order history

`/{locale}/checkout/[orderId]/status` and `/{locale}/account/orders[/[orderId]]` render the five
`ManualTransferState` values: instructions to transfer, waiting on us, confirmed with "Read now",
declined with the admin's reason and a link back to transfer instructions, and cancelled. Both locales
have copy.

The status page also carries two states that are not manual-transfer states at all, because it is
where every provider-specific surface sends a reader it cannot serve:

- **The active provider cannot settle this order.** An order is booked under the provider that was
  active when it was created and nothing moves it afterwards, so a provider switch strands any
  pending order made before it. This view says the order can no longer be paid and points at the
  book page. Nothing in it links onward to a provider surface, which is what stops the redirect into
  this page becoming a loop back out of it.
- **Payments are off.** Distinct from the one above and must not borrow its copy: "start a new order"
  is advice nobody can act on while `create_ebook_order` refuses every order with `EB011`. That
  reader's order is not stale, it is waiting on us.

**Every provider-specific surface loads the order before it looks at any provider**, and a pending
order belonging to the caller redirects here rather than 404ing. `notFound()` is reserved for an
order that is missing or is somebody else's, so ownership still cannot leak. This ordering is
load-bearing and was got wrong once: an environment check placed ahead of the order load gave a
blank 404 to a reader who had already transferred money and reopened the only page carrying the bank
details. The order detail page carries a "View order status" link for the same reason — a reader
needs a route they can click, not only one they can be redirected to.

### 6.3 Admin

`/admin/payments` lists pending manual payments, claimed orders first and oldest claim at the top,
filterable by order reference or buyer email. Each row links to `/admin/orders/[orderId]`, which gains
a confirm form (received amount, bank reference, note, mismatch override) and a decline form (reason,
outcome). Both are Server Actions calling `requireAdmin()` before the RPC.

## 7. Notifications and Operations

S7 adds no email template and no outbox row. `notification_outbox` is keyed by a unique, non-null
`entitlement_id`, constrains `template_key` to `book_ready`, and grants `insert` to no role at all:
only the entitlement trigger writes it. An operator notification for a claim does not fit that table,
and widening it for one message would weaken a deliberately narrow surface.

Operators are told through the S5 alerting path instead:

- `lib/ops/checks.ts` gains the rule `unreviewed_manual_transfer_claim`: any claim on an order that is
  still `pending`, with no age threshold, so a claim is a finding from the moment it is made. It
  appears on `/admin/operations` and in the scheduled operator alert like every other rule.
- `lib/ops/alerts.ts` already fingerprints a rule's finding IDs and alerts when that fingerprint
  changes, so each new claim produces one alert rather than one email per claim. Alert latency equals
  the scheduler interval, which the runbook states explicitly.
- Confirmation grants an entitlement, which the existing S5 trigger already turns into one book-ready
  email for the reader. No new reader email.

## 8. Extension Point for Physical Books

S7 deliberately keeps money and delivery separate, so S10 adds fulfillment without a migration of
anything built here:

- `confirm_manual_payment` states only that money arrived. It never asserts anything about delivery.
- Entitlement granting stays driven by the order's items. When an order contains a physical SKU
  alongside an ebook, confirmation grants the ebook entitlement and leaves the physical line to a
  separate fulfillment state machine.
- `manual_transfer_claims` and `manual_payment_confirmations` are keyed by `order_id`, not by book, so
  a multi-line order needs no change to either table.
- `reference_code` is on `orders`, so it serves a physical order unchanged.

## 9. Testing

| Layer | Coverage |
| --- | --- |
| Vitest | `resolveManualTransferState` across every input combination; reference-code generation and its alphabet; `ManualProvider.createSession` and `verifyEvent`; the VietQR URL builder; the admin confirm form's mismatch rule |
| pgTAP | `claim_manual_transfer` happy path and its refusals; `confirm_manual_payment` and `reject_manual_payment` happy paths; confirming twice yields one entitlement; confirming a cancelled order changes nothing; a mismatch without override raises and writes nothing; a non-admin is refused; reader B cannot insert or read reader A's claim; a claim on a completed order is refused; a declined order accepts a second claim; `reference_code` uniqueness and backfill |
| Playwright | Book → sign in → buy → transfer page → claim → admin confirm → "Read now" → reader renders; and a decline that returns the reader to transfer instructions. **The journey asserts the intermediate reader states on `/status` — awaiting transfer before the report, awaiting confirmation after it — and a second report after a decline.** Visiting `/status` only after confirmation is what let an entire dead branch pass twelve reviews and a green suite: both branches answer "success" there, so the assertion proved nothing about the states that precede it |
| Runbook | `docs/runbooks/manual-payment.md`: daily reconciliation, confirming, declining, handling a wrong amount, and what to do when a reader transfers without an order |

## 10. Exit Criteria

- A production configuration with `PAYMENT_PROVIDER=manual` creates paid orders; `simulator` is still
  refused in production.
- Every paid entitlement in the manual flow originates from `apply_payment_event`.
- Confirming the same order twice, from two admin sessions, produces one entitlement and one email.
- A confirmation with a mismatched amount is refused until an admin overrides it, and the override is
  in `audit_logs`.
- A declined order returns to a state the reader can pay again from; a cancelled order cannot.
- Reader B cannot see, claim, or act on reader A's order, through the UI or the Data API.
- `npm run check`, `npm run db:test`, and `npm run check:full` pass against a local Supabase stack.
