# S3 Get and Buy Design

**Status:** Implemented
**Date:** 2026-09-15
**Issues:** #5, #6, #7 (ebook subset)
**Parent spec:** `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md` (section S3)
**Builds on:** S1 catalog admin (PR #15), S2 public discovery (PR #17)

## 1. Goal

A signed-in reader gets a free ebook, or buys a paid ebook on the simulator, and reads it right away.
Operators can find any order and revoke the access it granted.

Today the book page renders the correct action, but the signed-in Get and Buy buttons are disabled.
Orders exist only as fixtures from `/admin/test-payments`. S3 builds the real flow.

## 2. What S3 Delivers

| Route | Who | What it does |
| --- | --- | --- |
| `/{locale}/books/[slug]` | Reader | Get free and Buy become working forms |
| `/{locale}/checkout/[orderId]` | Owner | Order summary and Pay |
| `/{locale}/checkout/[orderId]/simulate` | Owner, simulator envs | Succeed, Fail, Cancel, Send duplicate |
| `/{locale}/checkout/[orderId]/status` | Owner | Processing, success, failed, or cancelled |
| `/{locale}/account/orders` | Reader | The reader's own orders |
| `/{locale}/account/orders/[orderId]` | Owner | One order |
| `POST /api/payments/simulator/webhook` | Signed simulator event | Applies a payment event |
| `/admin/orders` | Admin | Find an order by email or ID |
| `/admin/orders/[orderId]` | Admin | Items, payments, events, entitlement, Revoke access |

## 3. Out of Scope

- A real payment provider, refunds, and invoices.
- Cart, coupons, and more than one item per order.
- Order expiry. A pending order stays pending until it is paid, cancelled, or replaced.
- Emails ("your book is ready"). S5 builds them.
- Analytics events (`begin_checkout`, `purchase`). S5 builds them.
- The lost-access reader state. S4 builds it.
- An admin UI for the payments flag. Operators set it with SQL (section 4.2).

## 4. Key Decisions

### 4.1 Changes from the parent spec

- `create_ebook_order` takes `p_book_id`, not an offer ID. The server resolves the active offer, so a
  client-supplied offer ID is never trusted. This matches `acquire_free_ebook`.
- The simulator verifies an HMAC signature. The parent spec did not say how staging is protected.
- `/admin/test-payments` is deleted. Its service-role order inserts would bypass `create_ebook_order`.
- The Playwright journey checks that the reader page opens for the bought book. Seeded books have no
  processed EPUB, so the engine itself is not rendered here. The golden-path spec already covers the
  engine with a processed EPUB.

### 4.2 Payments flag in the database

Postgres cannot see `PAYMENT_PROVIDER`. So S3 adds a one-row table:

```sql
commerce_settings (id boolean primary key default true check (id), payments_enabled boolean not null default false, updated_at timestamptz)
```

- The migration inserts the row with `payments_enabled = false`.
- Browser roles cannot read or write it. Only the RPCs read it.
- An operator sets it per environment. Production stays `false`.
- Local, CI, and staging set it to `true` when they use the simulator. E2E enables it through the
  service role before paid journeys.

Two gates must both pass to create a paid order: the app gate (`PAYMENT_PROVIDER !== "disabled"`) and
the database gate (`payments_enabled`). This is what lets pgTAP prove that production cannot create a
paid order.

### 4.3 `create_ebook_order(p_book_id uuid) returns uuid`

`security definer`, executable by `authenticated` only. In order:

1. Resolve the caller's profile from `auth.uid()`. None → `P0002`.
2. Require a verified email → `EB005` (the same code as `acquire_free_ebook`).
3. Require `commerce_settings.payments_enabled` → `EB011`.
4. Take a transaction advisory lock on `(profile_id, book_id)`. A double click makes one order.
5. An active entitlement for the book → `EB013`. The action sends the reader to the reader.
6. Resolve the purchasable offer: the book is `published`, its active publication is `published`, and
   an active in-window offer with `price_minor > 0` exists. Otherwise → `EB012`.
7. Look for a `pending` order by this profile for this book.
   - Its total and currency match the offer → return that order.
   - They differ → set it to `cancelled` with `payment_status = cancelled`, then continue.
8. Insert `orders` (`pending`, `payment_status = pending`), one `order_items` row with the title
   snapshot, and one `payments` row (`provider = simulator`, `status = pending`). Return the order ID.

The title snapshot uses the book's original-language localization, like `acquire_free_ebook`.

A reader on the checkout page of an old-price order still pays that order's snapshot price. Only a
new Buy click replaces the order. The snapshot is what the reader saw on the checkout page.

### 4.4 `revoke_order_entitlement(p_order_id uuid, p_reason text) returns uuid`

`security definer`, executable by `authenticated`, gated by `is_admin()` → `42501`.

- A blank reason → `22023`.
- It finds the entitlement whose `source_order_id = p_order_id`. It works for `free_order` and
  `simulated_payment`. None → `P0002`.
- An `admin_grant` never has a `source_order_id`, so a grant is never touched. An entitlement from a
  different order is never touched.
- When the entitlement is active: set `revoked`, delete its `library_items` row, and write one
  `audit_logs` row (`revoke_order_entitlement`, entity `entitlements`, metadata `order_id`,
  `profile_id`, `book_id`).
- When it is already revoked: return its ID. No second audit row.
- The order itself does not change. It stays `completed`.

A reader whose free-order access was revoked can claim the free book again. That is expected.

### 4.5 Order state rules

`lib/commerce/order-state.ts` holds one pure function and one case table. `apply_payment_event`
already implements these rules. S3 adds no change to that RPC.

| Order before | Event | Order after | Payment status after | Entitlement |
| --- | --- | --- | --- | --- |
| `pending` | `succeeded` | `completed` | `succeeded` | One granted |
| `pending` | `failed` | `pending` | `failed` | None |
| `pending` | `cancelled` | `cancelled` | `cancelled` | None |
| `completed` | any | unchanged | unchanged | Nothing new |
| `cancelled` | any | unchanged | unchanged | Nothing new |

A duplicate event ID changes nothing. The Vitest suite and pgTAP run the same table.

A `pending` order with `payment_status = failed` can still succeed later. That is "Try again".

### 4.6 Simulator events are signed

- A new env var `PAYMENT_SIMULATOR_SECRET` (at least 32 characters) is required when
  `PAYMENT_PROVIDER=simulator`.
- `signSimulatedEvent(body, secret)` returns `sha256=<hex HMAC of the raw body>`.
- The event is sent in the `x-simulator-signature` header.
- `SimulatorProvider.verifyEvent(request)` reads the raw body, checks the signature with a
  timing-safe compare, and only then parses the JSON. A bad or missing signature throws
  `InvalidSimulatorSignatureError`.

### 4.7 Event delivery runs in-process

`lib/commerce/simulator-webhook.ts` exports `handleSimulatorWebhook(request): Promise<Response>`.

- The route file `app/api/payments/simulator/webhook/route.ts` only calls it.
- The simulate page's Server Action builds a signed `Request` and calls the same function.
- So `verifyEvent` and `apply_payment_event` run exactly as for a network delivery. No server fetches
  its own URL, which staging deployment protection would block.

The handler returns:

| Case | Status |
| --- | --- |
| `APP_ENV` not `local`, `test`, or `staging`, or provider not `simulator` | 404 |
| Bad or missing signature | 401 |
| Malformed body | 400 |
| Order not found or amount mismatch (`P0002`, `EB004`) | 422 |
| Applied, or a duplicate | 200 with `{ orderStatus, paymentStatus }` |
| Anything else | 500 |

Every non-200 response logs the request ID and never returns raw database text.

### 4.8 `PaymentProvider.createSession`

```ts
createSession(input: { orderId: string; locale: Locale }): Promise<{ redirectUrl: string }>;
```

The simulator returns `/{locale}/checkout/{orderId}/simulate`. A future real provider returns its
hosted checkout URL. A browser redirect never changes order state.

### 4.9 Reader-facing authorization

- Every S3 page and action calls `requireUser()` or `requireAdmin()` itself.
- `checkout` joins `account`, `library`, and `read` as a member area in the proxy.
- Order reads use the session client. The existing "owner reads own orders" and "owner reads own order
  items" policies scope them. Another reader's order ID returns 404, the same as a missing one.
  Admins can read every order under RLS, so customer data functions also filter by the caller's
  profile ID.
- Only the webhook handler creates a service-role client, after the signature passes.

## 5. Flows

### 5.1 Get free

The signed-in `get_free` control becomes a form that posts to `getFreeEbookAction(locale, bookId, slug)`.

- Success: `revalidatePath` for the library, then redirect to `/{locale}/read/[bookId]`.
- Repeating it returns the same entitlement and redirects the same way.
- Error: redirect to the book page with `?action-error=<code>`. The page shows localized copy.
  Codes: `email-not-verified`, `no-free-offer`, `unexpected`.

### 5.2 Buy

1. The signed-in `buy` control posts to `buyEbookAction(locale, bookId, slug)`.
   - The app gate fails → `?action-error=payments-unavailable`.
   - Success → redirect to `/{locale}/checkout/[orderId]`.
   - `EB013` → redirect to `/{locale}/read/[bookId]`.
   - `EB005` → `email-not-verified`. `EB011` → `payments-unavailable`. `EB012` → `not-purchasable`.
2. **Checkout page.** `noindex`. It shows the cover, title, "Ebook (EPUB, read on the web)", the
   server total, the account email, and Pay. It has no shipping fields.
   - An order that is not `pending` → redirect to its status page.
   - The reader already owns the book → "You already own this book" with Read now, and no Pay.
   - `payment_status = failed` → a "Your last payment did not go through" notice above Pay.
3. **Pay** posts to `payOrderAction(locale, orderId)`. It re-checks ownership, `pending`, and
   no active entitlement. It calls `createSession` and redirects to the URL.
4. **Simulate page.** It returns 404 unless the environment allows the simulator and the viewer owns a
   `pending` order. It has four buttons. Each posts to `simulatePaymentAction(locale, orderId, outcome)`
   and then redirects to the status page.
   - Succeed, Fail, and Cancel send one event with a fresh event ID.
   - Send duplicate sends one `succeeded` event twice with the same event ID.
   - Amount and currency come from the order. The page never accepts them from the form.
5. **Status page.** `noindex`. It reads the order from the database only.

| Order | Payment status | View | Control |
| --- | --- | --- | --- |
| `completed` | any | Success | Read now |
| `pending` | `failed` | Failed | Try again → checkout for the same order |
| `pending` | `pending` | Processing | Refreshes every 2s for up to 30s, with a "Check again" link |
| `cancelled` | any | Cancelled | Back to the book |

`lib/commerce/checkout-view.ts` maps an order to this view. It is pure and unit-tested.

### 5.3 Coming soon

When `PAYMENT_PROVIDER=disabled`, paid books show the disabled "Coming soon" control (S2).
`buyEbookAction`, `payOrderAction`, and the checkout page all refuse. `create_ebook_order` refuses
through `EB011` when the database flag is off.

## 6. Account Orders

- `/{locale}/account/orders` lists the reader's orders, newest first: date, title, total ("Free" for
  0), and status.
- `/{locale}/account/orders/[orderId]` shows the item, total, status, and placed date.
  - A pending order links to checkout.
  - An order whose entitlement is active links to the reader.
- `AccountNav` on the account, library, and order pages gets an "Orders" item.
- Both pages are `noindex`.

Reader-facing statuses: `completed` → "Completed", `pending` → "Awaiting payment", `pending` with
`failed` → "Payment failed", `cancelled` → "Cancelled".

## 7. Admin Orders

Admin pages stay English-only, like the rest of `/admin`.

- `/admin/orders?q=`:
  - A UUID → that order.
  - Three or more characters → orders for matching customer emails, newest first, at most 50.
  - Otherwise → the 50 newest orders.
  - Columns: date, email, title, total, order status, payment status.
- `/admin/orders/[orderId]` has these sections:
  - Customer (email, link to `/admin/users/[profileId]`).
  - Item.
  - Payments.
  - Events (provider event ID, received and processed times).
  - Entitlement from this order (status, source, granted and revoked times).
  - Revoke access: shown only when that entitlement is active. A required reason, then
    `revoke_order_entitlement`. The page revalidates and shows the revoked state.
- `AdminNav` gets "Orders".

## 8. Security

- A browser redirect never changes order state. Only `apply_payment_event` does.
- The webhook trusts nothing before the HMAC check.
- `PAYMENT_SIMULATOR_SECRET` is server-only and never reaches client code.
- The simulate page and webhook return 404 outside `local`, `test`, and `staging`, and whenever the
  provider is not `simulator`.
- Production config already rejects `simulator`. With `disabled`, no route can create a paid order.
- Order IDs are UUIDs. A guessed ID for another reader's order returns 404.
- Customer-facing errors are stable codes mapped to localized copy. Raw errors never reach a page.

## 9. Testing

- **pgTAP (`018_ebook_orders.sql`):**
  - `create_ebook_order`:
    - creates one pending order, item, and payment;
    - a repeat returns the same order;
    - a price change cancels and replaces the order;
    - the flag off → `EB011`;
    - unverified → `EB005`;
    - free, draft, or no-publication books → `EB012`;
    - an owned book → `EB013`;
    - anon cannot execute it.
  - The order-state table, run through `apply_payment_event` on orders made by `create_ebook_order`,
    including a duplicate and an out-of-order event.
  - A reader cannot read another reader's order or order items.
  - `revoke_order_entitlement`:
    - revokes a simulated-payment entitlement and a free-order entitlement;
    - never touches an admin grant or another order's entitlement;
    - a repeat writes no second audit row;
    - a non-admin gets `42501`;
    - a blank reason gets `22023`.
  - Browser roles cannot select or update `commerce_settings`.
- **Vitest:**
  - `nextOrderState` (the section 4.5 table), `checkoutStatusView`, and the order status label;
  - HMAC sign and verify (valid, tampered body, wrong secret, missing header);
  - the env schema (secret required with the simulator);
  - `handleSimulatorWebhook` (every row of the section 4.7 table);
  - the four customer actions (redirects and error codes);
  - `BookActionControl` forms;
  - the data layers;
  - the proxy member area for `checkout`;
  - the admin revoke action.
- **Playwright (`e2e/checkout.spec.ts`):**
  - A paid book → sign in → Buy → Pay → Succeed → Read now → the reader page opens for that book.
  - Fail → Try again → Succeed → one active entitlement.
  - A free book → Get free → the reader page.
  - A non-owner opening another reader's checkout URL gets 404.
  - Admin revokes the order's access; the reader's library no longer lists the book.
  - Update `e2e/public-discovery.spec.ts`: the signed-in Get free button is now enabled.

## 10. Documentation

- New `docs/runbooks/checkout.md`: the flow, order states, simulator use, the payments flag, and
  revoking access.
- Update `docs/runbooks/deployment.md` and `docs/runbooks/testing-environments.md`:
  `PAYMENT_SIMULATOR_SECRET` and `commerce_settings`.
- Update `README.md`, `.env.example`, `playwright.config.ts`, and the CI workflow for the new env var.

## 11. Exit Criteria

- Free and simulated paid acquisition each create exactly one active entitlement, including duplicate
  and out-of-order events.
- A browser redirect never marks an order paid.
- Production configuration cannot create a paid order (Vitest for the app gate, pgTAP for the
  database gate).
- An unsigned or wrongly signed simulator event changes nothing.
- Playwright: book → sign in → buy → simulate success → Read now → the reader page opens.
- `npm run db:reset`, `npm run db:test`, and `npm run check:full` pass on a clean local stack.
