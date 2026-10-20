# S3 Get and Buy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in reader gets a free ebook or buys a paid ebook on the simulator and reads it right away, and an admin can find any order and revoke the access it granted.

**Architecture:** Two new RPCs own order creation (`create_ebook_order`) and order-based revocation (`revoke_order_entitlement`). A one-row `commerce_settings` table is the database payments gate, next to the existing `PAYMENT_PROVIDER` app gate. Simulated payment events are HMAC-signed. They enter through one handler (`handleSimulatorWebhook`), which both the webhook route and the simulate page's Server Action call. Payment outcomes still go only through the existing `apply_payment_event`.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase Postgres, pgTAP, Zod 4, Vitest, Testing Library, Playwright, `node:crypto`

**Spec:** `docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md` (parent: `docs/superpowers/specs/2026-09-13-remaining-mvp-ebook-launch-design.md`, section S3)

## Global Constraints

- MVP is ebook-only. Add no physical products, cart, shipping, coupons, or order expiry.
- Customer routes stay under `/{locale}` (`vi`, `en`). `/admin` has no locale and stays English-only.
- Every page and Server Action calls `requireUser()` or `requireAdmin()` itself. Layouts never authorize.
- A browser redirect never changes order state. Only `apply_payment_event` does.
- Only `handleSimulatorWebhook` (through `applyVerifiedPaymentEvent`) creates a service-role client in S3, and only after the signature check passes.
- Customer data functions filter by the caller's profile ID, because admins can read every order under RLS.
- Customer-facing errors are stable codes mapped to dictionary copy. Never render raw Supabase or Postgres text.
- Server errors log the request ID (`getRequestId` from `lib/observability/request-id.ts`).
- Error codes are new: `EB011` payments disabled, `EB012` not purchasable, `EB013` already owned. Reuse `EB005` for an unverified email.
- `PAYMENT_SIMULATOR_SECRET` is at least 32 characters. It is required when `PAYMENT_PROVIDER=simulator`, and it is server-only.
- Pages under `/checkout` and `/account/orders` set `robots: { index: false, follow: false }`.
- Touch targets are at least 44px (`min-h-11`).
- A `"use server"` module exports only async functions and types. Put constants and sync helpers elsewhere.
- Read the local Next.js guides before you change Next.js code: `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md` and `15-route-handlers.md`.
- Add new migrations only. Name them after `20260915110000`.
- Update `lib/supabase/database.types.ts` after every migration with `supabase gen types --local --lang typescript > lib/supabase/database.types.ts`.
- Run database and Playwright tests only against a local Supabase stack. If another stack owns the default ports, use a scratch `--workdir` stack (see `docs/runbooks/testing-environments.md`).
- The cloud Supabase project is shared with production. Never set `commerce_settings.payments_enabled = true` there.
- Run `npm run check` at the end of every task.
- Never stage `cmd.txt`, `.env.local`, or `docs/ref/`.
- Work on branch `feat/s3-get-and-buy` (it already holds the spec commit).

## Decisions This Plan Locks In

1. **Two payment gates.** App: `PAYMENT_PROVIDER !== "disabled"` (`arePaymentsEnabled`). Database: `commerce_settings.payments_enabled` (default `false`). A paid order needs both.
2. **`create_ebook_order(p_book_id)`**, not an offer ID. The RPC resolves the offer itself.
3. **Stale pending orders are replaced.** A pending order whose total or currency no longer matches the offer is cancelled when the reader clicks Buy again.
4. **Signed simulator events.** `x-simulator-signature: sha256=<hex HMAC of the raw body>`.
5. **In-process delivery.** The simulate action builds a signed `Request` and calls `handleSimulatorWebhook` directly. No server fetches its own URL.
6. **Revocation by order** works for `free_order` and `simulated_payment` entitlements whose `source_order_id` is that order. Grants and other orders are never touched. The order row does not change.
7. **`/admin/test-payments` is deleted.**
8. **Form actions always end in `redirect()`.** Invalid input redirects to a safe page. Server Actions do not call `notFound()`.
9. **The Playwright buy journey checks that the reader page opens** (`/read/[bookId]` with the book's `h1`). Seeded books have no processed EPUB. `ebook-golden-path.spec.ts` covers engine rendering.

## File Map

| Path | Responsibility |
| --- | --- |
| `supabase/migrations/20260915120000_ebook_orders.sql` | `commerce_settings`, `create_ebook_order` |
| `supabase/migrations/20260915130000_revoke_order_entitlement.sql` | `revoke_order_entitlement` |
| `supabase/tests/018_ebook_orders.sql` | Order creation, gates, order-state table through `apply_payment_event`, cross-user reads |
| `supabase/tests/019_revoke_order_entitlement.sql` | Revocation scope, audit, authorization |
| `lib/commerce/order-state.ts` | `nextOrderState` (spec 4.5 table) |
| `lib/commerce/checkout-view.ts` | `checkoutStatusView`, `customerOrderStatus` |
| `lib/commerce/errors.ts` | `PaymentsDisabledError`, `NotPurchasableError`, `AlreadyOwnedError`, `PaymentEventRejectedError` |
| `lib/commerce/types.ts` | `PaymentProvider` with `createSession` |
| `lib/commerce/simulator.ts` | Environment gate, HMAC sign and verify, simulated event builders, `SimulatorProvider` |
| `lib/commerce/payment-provider.ts` | `arePaymentsEnabled`, `getPaymentProvider` |
| `lib/commerce/simulator-webhook.ts` | `handleSimulatorWebhook` |
| `lib/commerce/orders.ts` | `createEbookOrder` (RPC wrapper) |
| `lib/catalog/action-error.ts` | Book action error codes and parsing |
| `lib/config/server-env-schema.ts` | `PAYMENT_SIMULATOR_SECRET` |
| `lib/i18n/routes.ts` | `orders` route, `getCommerceRoutes` |
| `lib/i18n/format.ts` | `formatDate` |
| `lib/auth/route-access.ts` | `checkout` is a member area |
| `lib/access/grant.ts` | `PaymentEventRejectedError` mapping, `revokeOrderEntitlement` |
| `lib/data/orders.ts` | Customer order reads |
| `lib/data/admin-orders.ts` | Admin order search and detail |
| `lib/data/supabase-test-client.ts` | `recordingChain` test helper |
| `app/api/payments/simulator/webhook/route.ts` | `POST` → `handleSimulatorWebhook` |
| `app/[locale]/(public)/books/[slug]/actions.ts` | `getFreeEbookAction`, `buyEbookAction` |
| `app/[locale]/(public)/books/[slug]/page.tsx` | Wires the forms and the action error |
| `components/catalog/book-action-control.tsx` | Signed-in Get and Buy forms |
| `components/auth/submit-button.tsx` | `className`, `size`, `variant` props |
| `app/[locale]/(account)/checkout/[orderId]/{page,actions}.tsx` | Checkout and Pay |
| `app/[locale]/(account)/checkout/[orderId]/simulate/{page,actions}.tsx` | Simulator buttons |
| `app/[locale]/(account)/checkout/[orderId]/status/page.tsx` | Order status |
| `components/commerce/status-auto-refresh.tsx` | Processing refresh |
| `components/account/account-nav-items.ts` | Shared account nav items |
| `app/[locale]/(account)/account/orders/page.tsx`, `[orderId]/page.tsx` | Reader orders |
| `app/admin/orders/page.tsx`, `[orderId]/{page,actions}.tsx` | Admin orders and revoke |
| `components/admin/order-revoke-form.tsx` | Revoke form |
| `components/admin/admin-nav.tsx` | Orders link |
| `lib/i18n/dictionaries/{en,vi}.json` | `catalog.actions.pending`, `catalog.actionErrors`, `checkout`, `orders` |
| `app/admin/test-payments/*` | Deleted |
| `e2e/support/commerce.ts`, `e2e/checkout.spec.ts` | S3 journeys |
| `docs/runbooks/checkout.md` | New runbook |

---

### Task 1: Payments flag and `create_ebook_order`

**Files:**
- Create: `supabase/migrations/20260915120000_ebook_orders.sql`
- Create: `supabase/tests/018_ebook_orders.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `orders`, `order_items`, `payments`, `entitlements`, `offers`, `skus`, `editions`, `books.active_publication_id`, `ebook_publications.status`, `customer_identities.verified_at`, and the existing `apply_payment_event`.
- Produces:
  - Table `public.commerce_settings (id boolean pk, payments_enabled boolean, updated_at timestamptz)`. One row. No browser-role privileges. `service_role` can select and update.
  - `public.create_ebook_order(p_book_id uuid) returns uuid` (the order ID). Errors: `P0002`, `EB005`, `EB011`, `EB012`, `EB013`. Executable by `authenticated` only.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/018_ebook_orders.sql`:

```sql
begin;
select plan(32);

-- S3: create_ebook_order, the commerce_settings gate, and the spec 4.5 order-state table run
-- through apply_payment_event on orders that create_ebook_order made.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's3-orders-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's3-orders-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's3-orders-unverified@example.test', '', null, '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 's3-orders-d@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '5a000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 's3-orders-e@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '5a000000-0000-0000-0000-000000000001') as a_id,
  (select id from public.profiles where auth_user_id = '5a000000-0000-0000-0000-000000000004') as d_id;
grant select on t_ids to public;

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('5b000000-0000-0000-0000-000000000001', 's3-orders-author', 'S3 Orders Author', 'published');

-- 1 paid, 2 second paid (price change), 3 free, 4 draft, 5 no active publication.
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('5c000000-0000-0000-0000-000000000001', 's3-orders-paid', 'vi', '5b000000-0000-0000-0000-000000000001', 'published'),
  ('5c000000-0000-0000-0000-000000000002', 's3-orders-paid-two', 'vi', '5b000000-0000-0000-0000-000000000001', 'published'),
  ('5c000000-0000-0000-0000-000000000003', 's3-orders-free', 'vi', '5b000000-0000-0000-0000-000000000001', 'published'),
  ('5c000000-0000-0000-0000-000000000004', 's3-orders-draft', 'vi', '5b000000-0000-0000-0000-000000000001', 'draft'),
  ('5c000000-0000-0000-0000-000000000005', 's3-orders-no-publication', 'vi', '5b000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title) values
  ('5c000000-0000-0000-0000-000000000001', 'en', 's3-paid-book', 'S3 Paid Book'),
  ('5c000000-0000-0000-0000-000000000001', 'vi', 's3-sach-tra-phi', 'Sách trả phí S3'),
  ('5c000000-0000-0000-0000-000000000002', 'vi', 's3-sach-tra-phi-hai', 'Sách trả phí hai S3');

insert into public.editions (id, book_id, language_code)
select ('5d000000-0000-0000-0000-00000000000' || n)::uuid, ('5c000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 5) as n;

insert into public.skus (id, edition_id, sku_code)
select ('5e000000-0000-0000-0000-00000000000' || n)::uuid, ('5d000000-0000-0000-0000-00000000000' || n)::uuid, 's3-orders-sku-' || n
from generate_series(1, 5) as n;

insert into public.offers (sku_id, market_code, currency, price_minor) values
  ('5e000000-0000-0000-0000-000000000001', 'VN', 'VND', 150000),
  ('5e000000-0000-0000-0000-000000000002', 'VN', 'VND', 90000),
  ('5e000000-0000-0000-0000-000000000003', 'VN', 'VND', 0),
  ('5e000000-0000-0000-0000-000000000004', 'VN', 'VND', 150000),
  ('5e000000-0000-0000-0000-000000000005', 'VN', 'VND', 150000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('5f000000-0000-0000-0000-00000000000' || n)::uuid, ('5d000000-0000-0000-0000-00000000000' || n)::uuid, 's3-orders/' || n || '.epub', 1, 'published'
from generate_series(1, 4) as n;

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
select ('60000000-0000-0000-0000-00000000000' || n)::uuid, ('5f000000-0000-0000-0000-00000000000' || n)::uuid, 1, 's3-orders/' || n || '/manifest.json', 'published'
from generate_series(1, 4) as n;

update public.books b
set active_publication_id = ('60000000-0000-0000-0000-00000000000' || right(b.id::text, 1))::uuid
where b.id in (
  '5c000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-000000000002',
  '5c000000-0000-0000-0000-000000000003', '5c000000-0000-0000-0000-000000000004'
);

update public.commerce_settings set payments_enabled = true;

-- Privileges (1-5)
select is(has_function_privilege('anon', 'public.create_ebook_order(uuid)', 'execute'), false, 'anon cannot create an order');
select is(has_function_privilege('authenticated', 'public.create_ebook_order(uuid)', 'execute'), true, 'a signed-in reader can create an order');
select is(has_table_privilege('authenticated', 'public.commerce_settings', 'select'), false, 'readers cannot read commerce_settings');
select is(has_table_privilege('anon', 'public.commerce_settings', 'select'), false, 'anon cannot read commerce_settings');
select is(has_table_privilege('authenticated', 'public.commerce_settings', 'update'), false, 'readers cannot change commerce_settings');

-- Creation and idempotency (6-10)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000001', true);
insert into t_orders values ('a-first', public.create_ebook_order('5c000000-0000-0000-0000-000000000001'));
insert into t_orders values ('a-repeat', public.create_ebook_order('5c000000-0000-0000-0000-000000000001'));
reset role;

select is((select order_id from t_orders where label = 'a-repeat'), (select order_id from t_orders where label = 'a-first'), 'a repeat Buy returns the same pending order');
select results_eq(
  $$ select status::text, payment_status::text, total_minor, currency from public.orders where id = (select order_id from t_orders where label = 'a-first') $$,
  $$ values ('pending', 'pending', 150000::bigint, 'VND') $$,
  'the order is pending at the server-read offer price'
);
select is(
  (select title_snapshot from public.order_items where order_id = (select order_id from t_orders where label = 'a-first')),
  'Sách trả phí S3',
  'the title snapshot uses the original-language localization'
);
select is((select count(*)::int from public.order_items where order_id = (select order_id from t_orders where label = 'a-first')), 1, 'the order has exactly one item');
select is(
  (select count(*)::int from public.payments where order_id = (select order_id from t_orders where label = 'a-first') and provider = 'simulator' and status = 'pending' and amount_minor = 150000),
  1,
  'the order has one pending simulator payment'
);

-- Cross-user reads (11-12)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000002', true);
select is((select count(*)::int from public.orders where id = (select order_id from t_orders where label = 'a-first')), 0, 'a reader cannot read another reader''s order');
select is((select count(*)::int from public.order_items where order_id = (select order_id from t_orders where label = 'a-first')), 0, 'a reader cannot read another reader''s order items');
reset role;

-- Failed, then succeeded, then a duplicate and a late event (13-19)
select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-a-failed', (select order_id from t_orders where label = 'a-first'), 's3-pay-a', 'failed', 150000, 'VND', now()) $$,
  $$ values ('pending', 'failed') $$,
  'pending + failed keeps the order pending with payment_status failed'
);
select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-a-succeeded', (select order_id from t_orders where label = 'a-first'), 's3-pay-a', 'succeeded', 150000, 'VND', now()) $$,
  $$ values ('completed', 'succeeded') $$,
  'a retry succeeds on the same order'
);
select is(
  (select count(*)::int from public.entitlements e, t_ids where e.profile_id = t_ids.a_id and e.book_id = '5c000000-0000-0000-0000-000000000001' and e.status = 'active' and e.source_type = 'simulated_payment' and e.source_order_id = (select order_id from t_orders where label = 'a-first')),
  1,
  'pending + succeeded grants one simulated-payment entitlement'
);
select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-a-succeeded', (select order_id from t_orders where label = 'a-first'), 's3-pay-a', 'succeeded', 150000, 'VND', now()) $$,
  $$ values ('completed', 'succeeded') $$,
  'a duplicate event changes nothing'
);
select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-a-late-cancel', (select order_id from t_orders where label = 'a-first'), 's3-pay-a', 'cancelled', 150000, 'VND', now()) $$,
  $$ values ('completed', 'succeeded') $$,
  'completed + cancelled changes nothing'
);
select is(
  (select count(*)::int from public.entitlements e, t_ids where e.profile_id = t_ids.a_id and e.book_id = '5c000000-0000-0000-0000-000000000001'),
  1,
  'duplicate and late events grant nothing new'
);
select is(
  (select count(*)::int from public.library_items l, t_ids where l.profile_id = t_ids.a_id and l.book_id = '5c000000-0000-0000-0000-000000000001'),
  1,
  'the bought book is in the library once'
);

-- Already owned (20)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000001', true);
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000001') $$, 'EB013', null, 'an owned book cannot be ordered again');
reset role;

-- Cancelled (21-23)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000004', true);
insert into t_orders values ('d-order', public.create_ebook_order('5c000000-0000-0000-0000-000000000001'));
reset role;

select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-d-cancel', (select order_id from t_orders where label = 'd-order'), 's3-pay-d', 'cancelled', 150000, 'VND', now()) $$,
  $$ values ('cancelled', 'cancelled') $$,
  'pending + cancelled cancels the order'
);
select results_eq(
  $$ select order_status::text, payment_status::text from public.apply_payment_event('simulator', 's3-evt-d-late-success', (select order_id from t_orders where label = 'd-order'), 's3-pay-d', 'succeeded', 150000, 'VND', now()) $$,
  $$ values ('cancelled', 'cancelled') $$,
  'cancelled + succeeded changes nothing'
);
select is(
  (select count(*)::int from public.entitlements e, t_ids where e.profile_id = t_ids.d_id and e.book_id = '5c000000-0000-0000-0000-000000000001'),
  0,
  'a cancelled order grants no entitlement'
);

-- Price change replaces the pending order (24-27)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000005', true);
insert into t_orders values ('e-first', public.create_ebook_order('5c000000-0000-0000-0000-000000000002'));
reset role;
update public.offers set price_minor = 120000 where sku_id = '5e000000-0000-0000-0000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000005', true);
insert into t_orders values ('e-second', public.create_ebook_order('5c000000-0000-0000-0000-000000000002'));
insert into t_orders values ('e-third', public.create_ebook_order('5c000000-0000-0000-0000-000000000002'));
reset role;

select isnt((select order_id from t_orders where label = 'e-second'), (select order_id from t_orders where label = 'e-first'), 'a price change creates a new order');
select results_eq(
  $$ select status::text, payment_status::text from public.orders where id = (select order_id from t_orders where label = 'e-first') $$,
  $$ values ('cancelled', 'cancelled') $$,
  'the stale pending order is cancelled'
);
select is((select total_minor from public.orders where id = (select order_id from t_orders where label = 'e-second')), 120000::bigint, 'the new order uses the current price');
select is((select order_id from t_orders where label = 'e-third'), (select order_id from t_orders where label = 'e-second'), 'the replacement order is then reused');

-- Refusals (28-32)
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000005', true);
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000003') $$, 'EB012', null, 'a free book cannot be bought');
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000004') $$, 'EB012', null, 'a draft book cannot be bought');
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000005') $$, 'EB012', null, 'a book without an active publication cannot be bought');
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000003', true);
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000001') $$, 'EB005', null, 'an unverified reader cannot buy');
reset role;

update public.commerce_settings set payments_enabled = false;
set local role authenticated;
select set_config('request.jwt.claim.sub', '5a000000-0000-0000-0000-000000000002', true);
select throws_ok($$ select public.create_ebook_order('5c000000-0000-0000-0000-000000000001') $$, 'EB011', null, 'no paid order can be created while payments are disabled');
reset role;

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `supabase test db` (add `--workdir <scratch>` on a scratch stack)
Expected: FAIL in `018_ebook_orders.sql` with `relation "public.commerce_settings" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260915120000_ebook_orders.sql`:

```sql
-- S3: paid ebook orders (docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md 4.2, 4.3).
--
-- New error codes:
--   EB011 - create_ebook_order: payments are disabled in this database (commerce_settings).
--   EB012 - create_ebook_order: the book has no purchasable paid offer (the book is not published,
--           its active publication is not published, or it has no active in-window offer above 0).
--   EB013 - create_ebook_order: the caller already holds an active entitlement for the book.

-- The database half of the payments gate. Postgres cannot see PAYMENT_PROVIDER, so this row is what
-- lets a database test prove that a production database refuses paid orders. The cloud project is
-- shared with production: keep payments_enabled false there.
create table public.commerce_settings (
  id boolean primary key default true check (id),
  payments_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.commerce_settings (id, payments_enabled) values (true, false);

alter table public.commerce_settings enable row level security;
revoke all on public.commerce_settings from public, anon, authenticated;
grant select, update on public.commerce_settings to service_role;

-- create_ebook_order: invoked by a signed-in reader. The profile comes from auth.uid(); the offer,
-- price, and title come from the database, never from the caller.
create function public.create_ebook_order(p_book_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_sku_id uuid;
  v_market_code text;
  v_currency text;
  v_price_minor bigint;
  v_order_id uuid;
  v_original_language text;
  v_title_snapshot text;
begin
  select p.id into v_profile_id from public.profiles p where p.auth_user_id = auth.uid();
  if v_profile_id is null then
    raise exception 'create_ebook_order: no profile for the current session' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.customer_identities ci
    where ci.profile_id = v_profile_id and ci.verified_at is not null
  ) then
    raise exception 'create_ebook_order: profile % has no verified email', v_profile_id using errcode = 'EB005';
  end if;

  if not coalesce((select cs.payments_enabled from public.commerce_settings cs where cs.id), false) then
    raise exception 'create_ebook_order: payments are disabled' using errcode = 'EB011';
  end if;

  -- One reader clicking Buy twice must not create two orders. The lock is per (profile, book) and
  -- ends with the transaction.
  perform pg_advisory_xact_lock(hashtextextended('create_ebook_order:' || v_profile_id::text || ':' || p_book_id::text, 0));

  if exists (
    select 1 from public.entitlements e
    where e.profile_id = v_profile_id and e.book_id = p_book_id and e.status = 'active'
  ) then
    raise exception 'create_ebook_order: profile % already owns book %', v_profile_id, p_book_id using errcode = 'EB013';
  end if;

  select o.sku_id, o.market_code, o.currency, o.price_minor
  into v_sku_id, v_market_code, v_currency, v_price_minor
  from public.offers o
  join public.skus s on s.id = o.sku_id
  join public.editions ed on ed.id = s.edition_id
  join public.books b on b.id = ed.book_id
  join public.ebook_publications pub on pub.id = b.active_publication_id
  where b.id = p_book_id
    and b.status = 'published'
    and pub.status = 'published'
    and o.active
    and o.price_minor > 0
    and (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at is null or o.ends_at > now())
  order by o.market_code
  limit 1
  for update of o;

  if v_sku_id is null then
    raise exception 'create_ebook_order: book % is not purchasable', p_book_id using errcode = 'EB012';
  end if;

  -- A pending order whose snapshot no longer matches the offer is stale: cancel it so the reader
  -- always pays the price the book page shows (spec 4.3).
  update public.payments pay
  set status = 'cancelled'
  where pay.status = 'pending'
    and pay.order_id in (
      select o.id from public.orders o
      join public.order_items oi on oi.order_id = o.id
      where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
        and (o.total_minor <> v_price_minor or o.currency <> v_currency)
    );

  update public.orders o
  set status = 'cancelled', payment_status = 'cancelled'
  from public.order_items oi
  where oi.order_id = o.id
    and o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
    and (o.total_minor <> v_price_minor or o.currency <> v_currency);

  select o.id into v_order_id
  from public.orders o
  join public.order_items oi on oi.order_id = o.id
  where o.profile_id = v_profile_id and oi.book_id = p_book_id and o.status = 'pending'
  order by o.created_at desc
  limit 1;

  if v_order_id is not null then
    return v_order_id;
  end if;

  select b.original_language into v_original_language from public.books b where b.id = p_book_id;
  select bl.title into v_title_snapshot
  from public.book_localizations bl
  where bl.book_id = p_book_id
  order by (bl.locale = v_original_language) desc, bl.locale
  limit 1;

  insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
  values (v_profile_id, 'pending', 'pending', v_market_code, v_currency, v_price_minor)
  returning id into v_order_id;

  insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
  values (v_order_id, v_sku_id, p_book_id, coalesce(v_title_snapshot, ''), v_price_minor, 1);

  -- The simulator is the only provider this MVP wires up. apply_payment_event resolves this row by
  -- (order_id, provider) when events arrive.
  insert into public.payments (order_id, provider, status, amount_minor, currency)
  values (v_order_id, 'simulator', 'pending', v_price_minor, v_currency);

  return v_order_id;
end;
$$;

revoke execute on function public.create_ebook_order(uuid) from public, anon;
grant execute on function public.create_ebook_order(uuid) to authenticated;
```

- [ ] **Step 4: Apply and run the tests**

Run: `supabase db reset && supabase test db`
Expected: PASS, including `018_ebook_orders.sql` (32 tests) and every earlier file.

- [ ] **Step 5: Regenerate types**

Run: `supabase gen types --local --lang typescript > lib/supabase/database.types.ts`
Expected: the diff adds `commerce_settings` and `create_ebook_order: { Args: { p_book_id: string }; Returns: string }`.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add supabase/migrations/20260915120000_ebook_orders.sql supabase/tests/018_ebook_orders.sql lib/supabase/database.types.ts
git commit -m "feat(db): add create_ebook_order and payments flag"
```

---

### Task 2: `revoke_order_entitlement`

**Files:**
- Create: `supabase/migrations/20260915130000_revoke_order_entitlement.sql`
- Create: `supabase/tests/019_revoke_order_entitlement.sql`
- Modify: `lib/supabase/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: `is_admin()`, `entitlements`, `library_items`, `audit_logs`.
- Produces: `public.revoke_order_entitlement(p_order_id uuid, p_reason text) returns uuid` (the entitlement ID). Errors: `42501` not admin, `22023` blank reason, `P0002` no entitlement from this order. Executable by `authenticated`.

- [ ] **Step 1: Write the failing pgTAP test**

Create `supabase/tests/019_revoke_order_entitlement.sql`:

```sql
begin;
select plan(16);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's3-revoke-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's3-revoke-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '61000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = '61000000-0000-0000-0000-000000000002') as reader_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

create temporary table t_results (label text primary key, entitlement_id uuid);
grant select, insert on t_results to public;

insert into public.authors (id, canonical_slug, display_name)
values ('63000000-0000-0000-0000-000000000001', 's3-revoke-author', 'S3 Revoke Author');

insert into public.books (id, canonical_key, original_language, primary_author_id)
select ('62000000-0000-0000-0000-00000000000' || n)::uuid, 's3-revoke-book-' || n, 'vi', '63000000-0000-0000-0000-000000000001'
from generate_series(1, 4) as n;
insert into public.editions (id, book_id, language_code)
select ('64000000-0000-0000-0000-00000000000' || n)::uuid, ('62000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 4) as n;
insert into public.skus (id, edition_id, sku_code)
select ('65000000-0000-0000-0000-00000000000' || n)::uuid, ('64000000-0000-0000-0000-00000000000' || n)::uuid, 's3-revoke-sku-' || n
from generate_series(1, 4) as n;

-- O1 paid book 1, O2 free book 2, O4 paid book 4, O6 pending (no entitlement).
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select o.id::uuid, t_ids.reader_id, o.status::public.order_status, o.payment_status::public.payment_status, 'VN', 'VND', o.total
from t_ids, (values
  ('66000000-0000-0000-0000-000000000001', 'completed', 'succeeded', 150000),
  ('66000000-0000-0000-0000-000000000002', 'completed', 'not_required', 0),
  ('66000000-0000-0000-0000-000000000004', 'completed', 'succeeded', 150000),
  ('66000000-0000-0000-0000-000000000006', 'pending', 'pending', 150000)
) as o(id, status, payment_status, total);

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values
  ('66000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Book 1', 150000),
  ('66000000-0000-0000-0000-000000000002', '65000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000002', 'Book 2', 0),
  ('66000000-0000-0000-0000-000000000004', '65000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000004', 'Book 4', 150000),
  ('66000000-0000-0000-0000-000000000006', '65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Book 1', 150000);

insert into public.entitlements (id, profile_id, book_id, source_type, source_order_id, actor_profile_id, reason, status)
select e.id::uuid, t_ids.reader_id, e.book_id::uuid, e.source::public.entitlement_source, e.order_id::uuid,
  case when e.source = 'admin_grant' then t_ids.admin_id end,
  case when e.source = 'admin_grant' then 'Gift' end,
  'active'
from t_ids, (values
  ('67000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'simulated_payment', '66000000-0000-0000-0000-000000000001'),
  ('67000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000002', 'free_order', '66000000-0000-0000-0000-000000000002'),
  ('67000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000003', 'admin_grant', null),
  ('67000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000004', 'simulated_payment', '66000000-0000-0000-0000-000000000004')
) as e(id, book_id, source, order_id);

insert into public.library_items (profile_id, book_id, entitlement_id)
select t_ids.reader_id, e.book_id, e.id from t_ids, public.entitlements e where e.profile_id = t_ids.reader_id;

-- Authorization and validation (1-2)
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000002', true);
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'No') $$, '42501', null, 'a reader cannot revoke order access');
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', '  ') $$, '22023', null, 'a reason is required');

-- Revoke a paid order (3-10)
insert into t_results values ('o1', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'Chargeback'));
reset role;

select is((select entitlement_id from t_results where label = 'o1'), '67000000-0000-0000-0000-000000000001'::uuid, 'returns the order''s entitlement');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000001'), 'revoked', 'the paid entitlement is revoked');
select isnt((select revoked_at from public.entitlements where id = '67000000-0000-0000-0000-000000000001'), null, 'revoked_at is set');
select is((select count(*)::int from public.library_items where entitlement_id = '67000000-0000-0000-0000-000000000001'), 0, 'the library item is removed');
select is((select count(*)::int from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '67000000-0000-0000-0000-000000000001'), 1, 'one audit row is written');
select is((select metadata ->> 'order_id' from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '67000000-0000-0000-0000-000000000001'), '66000000-0000-0000-0000-000000000001', 'the audit row names the order');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000004'), 'active', 'another order''s entitlement is untouched');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000003'), 'active', 'an admin grant is untouched');

-- Repeat, free order, missing entitlement (11-15)
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
insert into t_results values ('o1-repeat', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'Again'));
insert into t_results values ('o2', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000002', 'Abuse'));
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000006', 'Nothing') $$, 'P0002', null, 'an order that granted nothing cannot be revoked');
reset role;

select is((select entitlement_id from t_results where label = 'o1-repeat'), '67000000-0000-0000-0000-000000000001'::uuid, 'a repeat returns the same entitlement');
select is((select count(*)::int from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '67000000-0000-0000-0000-000000000001'), 1, 'a repeat writes no second audit row');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000002'), 'revoked', 'a free-order entitlement can be revoked');
select is((select status::text from public.orders where id = '66000000-0000-0000-0000-000000000001'), 'completed', 'the order itself does not change');

-- Privileges (16)
select is(has_function_privilege('anon', 'public.revoke_order_entitlement(uuid, text)', 'execute'), false, 'anon cannot revoke');

select * from finish();
rollback;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `supabase test db`
Expected: FAIL in `019_revoke_order_entitlement.sql` with `function public.revoke_order_entitlement(unknown, unknown) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260915130000_revoke_order_entitlement.sql`:

```sql
-- S3: revoke the access one order granted (docs/superpowers/specs/2026-09-15-s3-get-and-buy-design.md 4.4).
-- It only finds the entitlement whose source_order_id is this order. An admin_grant never has a
-- source_order_id, so no grant can be revoked here, and another order's entitlement is never touched.
-- The order row is history and does not change.
create function public.revoke_order_entitlement(p_order_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_profile_id uuid;
  v_entitlement_id uuid;
  v_profile_id uuid;
  v_book_id uuid;
  v_status public.entitlement_status;
begin
  if not public.is_admin() then
    raise exception 'revoke_order_entitlement: caller is not an admin' using errcode = '42501';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'revoke_order_entitlement: a reason is required' using errcode = '22023';
  end if;

  select pr.id into v_actor_profile_id from public.profiles pr where pr.auth_user_id = auth.uid();
  if v_actor_profile_id is null then
    raise exception 'revoke_order_entitlement: admin caller has no profile' using errcode = 'P0002';
  end if;

  select e.id, e.profile_id, e.book_id, e.status
  into v_entitlement_id, v_profile_id, v_book_id, v_status
  from public.entitlements e
  where e.source_order_id = p_order_id
    and e.source_type in ('free_order', 'simulated_payment')
  order by (e.status = 'active') desc, e.granted_at desc
  limit 1
  for update;

  if v_entitlement_id is null then
    raise exception 'revoke_order_entitlement: order % granted no entitlement', p_order_id using errcode = 'P0002';
  end if;

  if v_status = 'active' then
    update public.entitlements set status = 'revoked', revoked_at = now() where id = v_entitlement_id;

    delete from public.library_items where entitlement_id = v_entitlement_id;

    insert into public.audit_logs (actor_profile_id, action, entity_type, entity_id, reason, metadata)
    values (
      v_actor_profile_id,
      'revoke_order_entitlement',
      'entitlements',
      v_entitlement_id,
      p_reason,
      jsonb_build_object('order_id', p_order_id, 'profile_id', v_profile_id, 'book_id', v_book_id)
    );
  end if;

  return v_entitlement_id;
end;
$$;

revoke execute on function public.revoke_order_entitlement(uuid, text) from public, anon;
grant execute on function public.revoke_order_entitlement(uuid, text) to authenticated;
```

- [ ] **Step 4: Apply and run the tests**

Run: `supabase db reset && supabase test db`
Expected: PASS, including `019_revoke_order_entitlement.sql` (16 tests).

- [ ] **Step 5: Regenerate types, check, and commit**

Run: `supabase gen types --local --lang typescript > lib/supabase/database.types.ts && npm run check`
Expected: the types gain `revoke_order_entitlement`, and the checks pass.

```bash
git add supabase/migrations/20260915130000_revoke_order_entitlement.sql supabase/tests/019_revoke_order_entitlement.sql lib/supabase/database.types.ts
git commit -m "feat(db): add revoke_order_entitlement"
```

---

### Task 3: Commerce pure logic, routes, and the checkout member area

**Files:**
- Create: `lib/commerce/order-state.ts`, `lib/commerce/order-state.test.ts`
- Create: `lib/commerce/checkout-view.ts`, `lib/commerce/checkout-view.test.ts`
- Create: `lib/catalog/action-error.ts`, `lib/catalog/action-error.test.ts`
- Modify: `lib/i18n/routes.ts`, `lib/i18n/routes.test.ts`
- Modify: `lib/i18n/format.ts`, `lib/i18n/format.test.ts`
- Modify: `lib/auth/route-access.ts`, `lib/auth/route-access.test.ts`

**Interfaces:**
- Consumes: `withLocale`, `Locale` from `lib/i18n/config.ts`.
- Produces:
  - `type OrderStatus = "draft" | "pending" | "completed" | "cancelled"`
  - `type PaymentStatus = "not_required" | "pending" | "succeeded" | "failed" | "cancelled"`
  - `type PaymentEventStatus = "succeeded" | "failed" | "cancelled"`
  - `type OrderState = { status: OrderStatus; paymentStatus: PaymentStatus }`
  - `nextOrderState(order: OrderState, event: PaymentEventStatus): OrderState & { grantsEntitlement: boolean }`
  - `checkoutStatusView(order: OrderState): "success" | "failed" | "processing" | "cancelled"`
  - `customerOrderStatus(order: OrderState): "completed" | "awaitingPayment" | "paymentFailed" | "cancelled"`
  - `BOOK_ACTION_ERROR_CODES`, `type BookActionErrorCode`, `parseBookActionError(value: string | string[] | undefined): BookActionErrorCode | null`
  - `getLocaleRoutes(locale).orders` = `/{locale}/account/orders`
  - `getCommerceRoutes(locale)` → `{ checkout(orderId), checkoutSimulate(orderId), checkoutStatus(orderId), order(orderId), bookActionError(slug, code) }`
  - `formatDate(iso: string, locale: Locale, options?: { withTime?: boolean }): string` (Asia/Ho_Chi_Minh time zone)

- [ ] **Step 1: Write the failing tests**

Create `lib/commerce/order-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { nextOrderState, type OrderState, type PaymentEventStatus } from "@/lib/commerce/order-state";

const pending: OrderState = { status: "pending", paymentStatus: "pending" };
const pendingFailed: OrderState = { status: "pending", paymentStatus: "failed" };
const completed: OrderState = { status: "completed", paymentStatus: "succeeded" };
const cancelled: OrderState = { status: "cancelled", paymentStatus: "cancelled" };

// S3 spec 4.5. supabase/tests/018_ebook_orders.sql runs the same rows through apply_payment_event.
const cases: [string, OrderState, PaymentEventStatus, ReturnType<typeof nextOrderState>][] = [
  ["pending + succeeded", pending, "succeeded", { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true }],
  ["pending + failed", pending, "failed", { status: "pending", paymentStatus: "failed", grantsEntitlement: false }],
  ["pending + cancelled", pending, "cancelled", { status: "cancelled", paymentStatus: "cancelled", grantsEntitlement: false }],
  ["failed payment + succeeded (try again)", pendingFailed, "succeeded", { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true }],
  ["completed + succeeded", completed, "succeeded", { ...completed, grantsEntitlement: false }],
  ["completed + failed", completed, "failed", { ...completed, grantsEntitlement: false }],
  ["completed + cancelled", completed, "cancelled", { ...completed, grantsEntitlement: false }],
  ["cancelled + succeeded", cancelled, "succeeded", { ...cancelled, grantsEntitlement: false }],
  ["cancelled + failed", cancelled, "failed", { ...cancelled, grantsEntitlement: false }],
  ["cancelled + cancelled", cancelled, "cancelled", { ...cancelled, grantsEntitlement: false }],
];

describe("nextOrderState", () => {
  it.each(cases)("%s", (_label, before, event, after) => {
    expect(nextOrderState(before, event)).toEqual(after);
  });
});
```

Create `lib/commerce/checkout-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { checkoutStatusView, customerOrderStatus } from "@/lib/commerce/checkout-view";
import type { OrderState } from "@/lib/commerce/order-state";

const rows: [OrderState, ReturnType<typeof checkoutStatusView>, ReturnType<typeof customerOrderStatus>][] = [
  [{ status: "completed", paymentStatus: "succeeded" }, "success", "completed"],
  [{ status: "completed", paymentStatus: "not_required" }, "success", "completed"],
  [{ status: "pending", paymentStatus: "failed" }, "failed", "paymentFailed"],
  [{ status: "pending", paymentStatus: "pending" }, "processing", "awaitingPayment"],
  [{ status: "cancelled", paymentStatus: "cancelled" }, "cancelled", "cancelled"],
];

describe("checkout views", () => {
  it.each(rows)("maps %j to %s and %s", (order, view, label) => {
    expect(checkoutStatusView(order)).toBe(view);
    expect(customerOrderStatus(order)).toBe(label);
  });
});
```

Create `lib/catalog/action-error.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseBookActionError } from "@/lib/catalog/action-error";

describe("parseBookActionError", () => {
  it.each(["email-not-verified", "no-free-offer", "payments-unavailable", "not-purchasable", "unexpected"])(
    "accepts %s",
    (code) => {
      expect(parseBookActionError(code)).toBe(code);
    },
  );

  it.each([undefined, "", "<script>", "invalid-locale"])("ignores %j", (value) => {
    expect(parseBookActionError(value)).toBeNull();
  });

  it("uses the first value of a repeated parameter", () => {
    expect(parseBookActionError(["not-purchasable", "unexpected"])).toBe("not-purchasable");
  });
});
```

In `lib/i18n/routes.test.ts`, change the import to
`import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes, otherLocale } from "@/lib/i18n/routes";`,
add `orders: "/en/account/orders",` to the expected object in "keeps primary navigation in the selected
locale" (between `library` and `search`), and add this test inside `describe("localized route graph", ...)`:

```ts
  it("builds checkout and order routes", () => {
    const routes = getCommerceRoutes("vi");
    const orderId = "70000000-0000-4000-8000-000000000001";
    expect(routes.checkout(orderId)).toBe(`/vi/checkout/${orderId}`);
    expect(routes.checkoutSimulate(orderId)).toBe(`/vi/checkout/${orderId}/simulate`);
    expect(routes.checkoutStatus(orderId)).toBe(`/vi/checkout/${orderId}/status`);
    expect(routes.order(orderId)).toBe(`/vi/account/orders/${orderId}`);
    expect(routes.bookActionError("mot-cuon-sach", "not-purchasable")).toBe("/vi/books/mot-cuon-sach?action-error=not-purchasable");
  });
```

In `lib/i18n/format.test.ts`, add `formatDate` to the import from `@/lib/i18n/format` and add:

```ts
describe("formatDate", () => {
  it("formats in Vietnam time", () => {
    // 20:00 UTC on 15 September is 03:00 on 16 September in Asia/Ho_Chi_Minh.
    expect(formatDate("2026-09-15T20:00:00Z", "en")).toBe("Sep 16, 2026");
    expect(formatDate("2026-09-15T20:00:00Z", "vi")).toContain("2026");
  });

  it("adds the time when asked", () => {
    expect(formatDate("2026-09-15T20:00:00Z", "en", { withTime: true })).toMatch(/3:00/);
  });
});
```

If `lib/i18n/format.test.ts` has no `describe` import yet, import `describe` from `vitest` too.

In `lib/auth/route-access.test.ts`, add this row to the first `it.each` (anonymous visitors sent to sign in):

```ts
    ["/en/checkout/order-1", "", "/en/sign-in?next=%2Fen%2Fcheckout%2Forder-1"],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/commerce lib/catalog/action-error.test.ts lib/i18n lib/auth/route-access.test.ts`
Expected: FAIL. The new modules are missing, `getCommerceRoutes` and `formatDate` are not exported, and `/en/checkout/order-1` returns `null`.

- [ ] **Step 3: Implement**

Create `lib/commerce/order-state.ts`:

```ts
// Order state rules for one payment event (S3 spec 4.5). apply_payment_event implements the same
// rules in the database, and supabase/tests/018_ebook_orders.sql runs the same cases. This function
// never changes an order; it is the tested statement of the contract the RPC keeps.
export type OrderStatus = "draft" | "pending" | "completed" | "cancelled";
export type PaymentStatus = "not_required" | "pending" | "succeeded" | "failed" | "cancelled";
export type PaymentEventStatus = "succeeded" | "failed" | "cancelled";

export type OrderState = { status: OrderStatus; paymentStatus: PaymentStatus };

export function nextOrderState(order: OrderState, event: PaymentEventStatus): OrderState & { grantsEntitlement: boolean } {
  // Only a pending order reacts. A failed payment leaves the order pending, so a retry can succeed.
  if (order.status !== "pending") return { ...order, grantsEntitlement: false };

  switch (event) {
    case "succeeded":
      return { status: "completed", paymentStatus: "succeeded", grantsEntitlement: true };
    case "failed":
      return { status: "pending", paymentStatus: "failed", grantsEntitlement: false };
    case "cancelled":
      return { status: "cancelled", paymentStatus: "cancelled", grantsEntitlement: false };
  }
}
```

Create `lib/commerce/checkout-view.ts`:

```ts
import type { OrderState } from "@/lib/commerce/order-state";

export type CheckoutStatusView = "success" | "failed" | "processing" | "cancelled";

// What /checkout/[orderId]/status shows (S3 spec 5.2). Read from the database only.
export function checkoutStatusView(order: OrderState): CheckoutStatusView {
  if (order.status === "completed") return "success";
  if (order.status === "cancelled") return "cancelled";
  if (order.paymentStatus === "failed") return "failed";
  return "processing";
}

export type CustomerOrderStatus = "completed" | "awaitingPayment" | "paymentFailed" | "cancelled";

// The status label on the reader's order pages (S3 spec 6). Keys match dictionary orders.statuses.
export function customerOrderStatus(order: OrderState): CustomerOrderStatus {
  switch (checkoutStatusView(order)) {
    case "success":
      return "completed";
    case "failed":
      return "paymentFailed";
    case "processing":
      return "awaitingPayment";
    case "cancelled":
      return "cancelled";
  }
}
```

Create `lib/catalog/action-error.ts`:

```ts
// Stable codes a Get or Buy form action puts in `?action-error=` on the book page (S3 spec 5.1, 5.2).
// The page maps each code to dictionary copy, so no server error text reaches the reader.
export const BOOK_ACTION_ERROR_CODES = [
  "email-not-verified",
  "no-free-offer",
  "payments-unavailable",
  "not-purchasable",
  "unexpected",
] as const;

export type BookActionErrorCode = (typeof BOOK_ACTION_ERROR_CODES)[number];

export function parseBookActionError(value: string | string[] | undefined): BookActionErrorCode | null {
  const first = Array.isArray(value) ? value[0] : value;
  return (BOOK_ACTION_ERROR_CODES as readonly string[]).includes(first ?? "") ? (first as BookActionErrorCode) : null;
}
```

In `lib/i18n/routes.ts`, add `orders: withLocale(locale, "/account/orders"),` to the object `getLocaleRoutes` returns (after `library`), and add below `getCatalogRoutes`:

```ts
export function getCommerceRoutes(locale: Locale) {
  return {
    checkout: (orderId: string) => withLocale(locale, `/checkout/${orderId}`),
    checkoutSimulate: (orderId: string) => withLocale(locale, `/checkout/${orderId}/simulate`),
    checkoutStatus: (orderId: string) => withLocale(locale, `/checkout/${orderId}/status`),
    order: (orderId: string) => withLocale(locale, `/account/orders/${orderId}`),
    bookActionError: (slug: string, code: string) =>
      `${withLocale(locale, `/books/${slug}`)}?${new URLSearchParams({ "action-error": code })}`,
  };
}
```

In `lib/i18n/format.ts`, add:

```ts
const dateLocaleTags: Record<Locale, string> = { vi: "vi-VN", en: "en-US" };

// Order dates render on the server, so the time zone is fixed to the launch market rather than the
// server's own zone.
export function formatDate(iso: string, locale: Locale, options: { withTime?: boolean } = {}): string {
  return new Intl.DateTimeFormat(dateLocaleTags[locale], {
    dateStyle: "medium",
    ...(options.withTime ? { timeStyle: "short" as const } : {}),
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(iso));
}
```

In `lib/auth/route-access.ts`, change the member set to:

```ts
const readerPages = new Set(["account", "checkout", "library", "read"]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run lib/commerce lib/catalog/action-error.test.ts lib/i18n lib/auth/route-access.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/commerce/order-state.ts lib/commerce/order-state.test.ts lib/commerce/checkout-view.ts lib/commerce/checkout-view.test.ts lib/catalog/action-error.ts lib/catalog/action-error.test.ts lib/i18n/routes.ts lib/i18n/routes.test.ts lib/i18n/format.ts lib/i18n/format.test.ts lib/auth/route-access.ts lib/auth/route-access.test.ts
git commit -m "feat(commerce): add order state rules and checkout routes"
```

---

### Task 4: Signed simulator, provider sessions, and the simulator secret

**Files:**
- Create: `lib/commerce/errors.ts`
- Create: `lib/commerce/payment-provider.test.ts`
- Modify: `lib/commerce/types.ts`, `lib/commerce/simulator.ts`, `lib/commerce/simulator.test.ts` (rewritten), `lib/commerce/payment-provider.ts`
- Modify: `lib/config/server-env-schema.ts`, `lib/config/server-env.test.ts`
- Modify: `lib/data/catalog.ts` (line 189)
- Delete: `app/admin/test-payments/actions.ts`, `app/admin/test-payments/actions.test.ts`
- Modify: `.env.example`, `playwright.config.ts`, `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: `getCommerceRoutes` (Task 3), `REQUEST_ID_HEADER` from `lib/observability/request-id.ts`, `VerifiedPaymentEvent`.
- Produces:
  - `ServerEnv.simulatorSecret: string | null`
  - `interface PaymentProvider { createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }>; verifyEvent(request: Request): Promise<VerifiedPaymentEvent> }`, where `CheckoutSessionInput = { orderId: string; locale: Locale }`
  - `arePaymentsEnabled(env: Pick<ServerEnv, "paymentProvider">): boolean`
  - `getPaymentProvider(env: Pick<ServerEnv, "appEnv" | "paymentProvider" | "simulatorSecret">): PaymentProvider`
  - From `lib/commerce/simulator.ts`:
    - `isSimulatorAllowedEnvironment(appEnv)`, `isSimulatorCheckoutEnabled(env: Pick<ServerEnv, "appEnv" | "paymentProvider">)`
    - `SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature"`, `signSimulatedEvent(body: string, secret: string): string`
    - `SIMULATED_OUTCOMES`, `type SimulatedOutcome = "succeeded" | "failed" | "cancelled" | "duplicate"`, `isSimulatedOutcome(value: string): value is SimulatedOutcome`
    - `type SimulatedPaymentEvent = Omit<VerifiedPaymentEvent, "provider">`
    - `buildSimulatedEvents(order: { id: string; totalMinor: number; currency: string }, outcome: SimulatedOutcome, eventId: string, now: Date): SimulatedPaymentEvent[]`
    - `buildSimulatedEventRequest(event: SimulatedPaymentEvent, secret: string, requestId: string): Request`
    - errors `SimulatorProviderEnvironmentError`, `SimulatorSecretMissingError`, `InvalidSimulatorSignatureError`, `MalformedSimulatedEventError`
    - `class SimulatorProvider`
  - From `lib/commerce/errors.ts`: `PaymentsDisabledError`, `NotPurchasableError`, `AlreadyOwnedError`, `PaymentEventRejectedError`

- [ ] **Step 1: Write the failing tests**

In `lib/config/server-env.test.ts`, add `PAYMENT_SIMULATOR_SECRET: "test-simulator-secret-0123456789abcdef",` to `base`, and add:

```ts
  it("requires a simulator secret with the simulator", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_SIMULATOR_SECRET: undefined })).toThrow(
      "PAYMENT_SIMULATOR_SECRET is required when PAYMENT_PROVIDER=simulator",
    );
  });

  it("rejects a short simulator secret", () => {
    expect(() => parseServerEnv({ ...base, PAYMENT_SIMULATOR_SECRET: "short" })).toThrow();
  });

  it("needs no secret when payments are disabled", () => {
    const env = parseServerEnv({ ...base, APP_ENV: "production", PAYMENT_PROVIDER: "disabled", PAYMENT_SIMULATOR_SECRET: undefined });
    expect(env.simulatorSecret).toBeNull();
  });
```

Replace `lib/commerce/simulator.test.ts` with:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  buildSimulatedEventRequest,
  buildSimulatedEvents,
  InvalidSimulatorSignatureError,
  isSimulatedOutcome,
  isSimulatorAllowedEnvironment,
  isSimulatorCheckoutEnabled,
  MalformedSimulatedEventError,
  signSimulatedEvent,
  SIMULATOR_SIGNATURE_HEADER,
  SimulatorProvider,
  SimulatorProviderEnvironmentError,
  SimulatorSecretMissingError,
} from "@/lib/commerce/simulator";

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const validPayload = {
  eventId: "evt-1",
  externalPaymentId: "pay-1",
  orderId: ORDER_ID,
  status: "succeeded" as const,
  amountMinor: 150000,
  currency: "VND",
  occurredAt: "2026-09-12T00:00:00.000Z",
};

function signedRequest(body: string, signature: string | null = signSimulatedEvent(body, SECRET)) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set(SIMULATOR_SIGNATURE_HEADER, signature);
  return new Request("https://simulator.local/events", { method: "POST", headers, body });
}

const provider = () => new SimulatorProvider({ appEnv: "local", simulatorSecret: SECRET });

// One predicate decides where the simulator may run. The provider, the simulate page, and the webhook
// all call it instead of restating the policy.
describe("isSimulatorAllowedEnvironment", () => {
  it.each(["local", "staging", "test"])("permits %s", (appEnv) => {
    expect(isSimulatorAllowedEnvironment(appEnv)).toBe(true);
  });

  it.each(["preview", "production"])("refuses %s", (appEnv) => {
    expect(isSimulatorAllowedEnvironment(appEnv)).toBe(false);
  });
});

describe("isSimulatorCheckoutEnabled", () => {
  it("needs the simulator provider in an allowed environment", () => {
    expect(isSimulatorCheckoutEnabled({ appEnv: "staging", paymentProvider: "simulator" })).toBe(true);
    expect(isSimulatorCheckoutEnabled({ appEnv: "staging", paymentProvider: "disabled" })).toBe(false);
    expect(isSimulatorCheckoutEnabled({ appEnv: "production", paymentProvider: "simulator" })).toBe(false);
  });
});

describe("SimulatorProvider construction", () => {
  it.each(["production", "preview"])("refuses appEnv=%s", (appEnv) => {
    expect(() => new SimulatorProvider({ appEnv, simulatorSecret: SECRET })).toThrow(SimulatorProviderEnvironmentError);
  });

  it("refuses to run without a secret", () => {
    expect(() => new SimulatorProvider({ appEnv: "local", simulatorSecret: null })).toThrow(SimulatorSecretMissingError);
  });

  it.each(["local", "staging", "test"])("constructs in %s", (appEnv) => {
    expect(() => new SimulatorProvider({ appEnv, simulatorSecret: SECRET })).not.toThrow();
  });
});

describe("SimulatorProvider.createSession", () => {
  it("sends the reader to the simulate page for the order", async () => {
    await expect(provider().createSession({ orderId: ORDER_ID, locale: "vi" })).resolves.toEqual({
      redirectUrl: `/vi/checkout/${ORDER_ID}/simulate`,
    });
  });
});

describe("SimulatorProvider.verifyEvent", () => {
  it("verifies a signed event and stamps its provider key", async () => {
    await expect(provider().verifyEvent(signedRequest(JSON.stringify(validPayload)))).resolves.toEqual({
      ...validPayload,
      provider: "simulator",
    });
  });

  it("rejects a body changed after signing", async () => {
    const signature = signSimulatedEvent(JSON.stringify(validPayload), SECRET);
    const tampered = signedRequest(JSON.stringify({ ...validPayload, amountMinor: 1 }), signature);
    await expect(provider().verifyEvent(tampered)).rejects.toThrow(InvalidSimulatorSignatureError);
  });

  it("rejects a signature made with another secret", async () => {
    const body = JSON.stringify(validPayload);
    const request = signedRequest(body, signSimulatedEvent(body, "another-secret-0123456789abcdefghij"));
    await expect(provider().verifyEvent(request)).rejects.toThrow(InvalidSimulatorSignatureError);
  });

  it("rejects a missing signature", async () => {
    await expect(provider().verifyEvent(signedRequest(JSON.stringify(validPayload), null))).rejects.toThrow(
      InvalidSimulatorSignatureError,
    );
  });

  it.each([
    ["not JSON", "not json"],
    ["missing eventId", JSON.stringify({ ...validPayload, eventId: undefined })],
    ["non-UUID orderId", JSON.stringify({ ...validPayload, orderId: "order-1" })],
    ["invalid status", JSON.stringify({ ...validPayload, status: "pending" })],
    ["non-integer amount", JSON.stringify({ ...validPayload, amountMinor: 1.5 })],
    ["negative amount", JSON.stringify({ ...validPayload, amountMinor: -1 })],
    ["missing currency", JSON.stringify({ ...validPayload, currency: undefined })],
  ])("rejects a signed but malformed event: %s", async (_label, body) => {
    await expect(provider().verifyEvent(signedRequest(body))).rejects.toThrow(MalformedSimulatedEventError);
  });
});

describe("simulated events", () => {
  const order = { id: ORDER_ID, totalMinor: 150000, currency: "VND" };
  const now = new Date("2026-09-15T00:00:00.000Z");

  it.each(["succeeded", "failed", "cancelled"] as const)("sends one %s event priced from the order", (outcome) => {
    expect(buildSimulatedEvents(order, outcome, "evt-1", now)).toEqual([
      {
        eventId: "evt-1",
        externalPaymentId: `sim_pay_${ORDER_ID}`,
        orderId: ORDER_ID,
        status: outcome,
        amountMinor: 150000,
        currency: "VND",
        occurredAt: "2026-09-15T00:00:00.000Z",
      },
    ]);
  });

  it("sends the same succeeded event twice for a duplicate", () => {
    const events = buildSimulatedEvents(order, "duplicate", "evt-1", now);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(events[1]);
    expect(events[0].status).toBe("succeeded");
  });

  it("recognizes only the four outcomes", () => {
    expect(["succeeded", "failed", "cancelled", "duplicate"].every(isSimulatedOutcome)).toBe(true);
    expect(isSimulatedOutcome("refunded")).toBe(false);
  });

  it("builds a request that verifyEvent accepts and that carries the request ID", async () => {
    const [event] = buildSimulatedEvents(order, "failed", "evt-2", now);
    const request = buildSimulatedEventRequest(event, SECRET, "req-12345678");
    expect(request.headers.get("x-request-id")).toBe("req-12345678");
    await expect(provider().verifyEvent(request)).resolves.toMatchObject({ eventId: "evt-2", status: "failed" });
  });
});
```

Create `lib/commerce/payment-provider.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from "vitest";

import { arePaymentsEnabled, getPaymentProvider, PaymentProviderDisabledError } from "@/lib/commerce/payment-provider";
import { SimulatorProvider } from "@/lib/commerce/simulator";

describe("payment provider selection", () => {
  it("treats only PAYMENT_PROVIDER=disabled as disabled", () => {
    expect(arePaymentsEnabled({ paymentProvider: "disabled" })).toBe(false);
    expect(arePaymentsEnabled({ paymentProvider: "simulator" })).toBe(true);
  });

  it("fails closed when payments are disabled", () => {
    expect(() => getPaymentProvider({ appEnv: "production", paymentProvider: "disabled", simulatorSecret: null })).toThrow(
      PaymentProviderDisabledError,
    );
  });

  it("returns the simulator with its secret", () => {
    const provider = getPaymentProvider({ appEnv: "test", paymentProvider: "simulator", simulatorSecret: "test-simulator-secret-0123456789abcdef" });
    expect(provider).toBeInstanceOf(SimulatorProvider);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/commerce lib/config`
Expected: FAIL. `signSimulatedEvent`, `arePaymentsEnabled`, and `simulatorSecret` do not exist yet.

- [ ] **Step 3: Add the env var**

In `lib/config/server-env-schema.ts`, add to the Zod object after `PAYMENT_PROVIDER`:

```ts
  PAYMENT_SIMULATOR_SECRET: z.string().min(32).optional(),
```

After the existing production-and-simulator check, add:

```ts
  if (parsed.PAYMENT_PROVIDER === "simulator" && !parsed.PAYMENT_SIMULATOR_SECRET) {
    throw new Error("PAYMENT_SIMULATOR_SECRET is required when PAYMENT_PROVIDER=simulator");
  }
```

Add `simulatorSecret: parsed.PAYMENT_SIMULATOR_SECRET ?? null,` to the returned object after `paymentProvider`.

- [ ] **Step 4: Add the commerce errors and provider interface**

Create `lib/commerce/errors.ts`:

```ts
// Commerce errors shared by server modules and the webhook handler. This file has no "server-only"
// import, so tests can use the real classes while they mock the modules that throw them.
export class PaymentsDisabledError extends Error {
  constructor() {
    super("Payments are not enabled in this environment.");
    this.name = "PaymentsDisabledError";
  }
}

export class NotPurchasableError extends Error {
  constructor() {
    super("This book cannot be bought right now.");
    this.name = "NotPurchasableError";
  }
}

export class AlreadyOwnedError extends Error {
  constructor() {
    super("The reader already owns this book.");
    this.name = "AlreadyOwnedError";
  }
}

// apply_payment_event refused the event: the order does not exist (P0002) or the amount or currency
// does not match it (EB004). The webhook answers 422 instead of 500.
export class PaymentEventRejectedError extends Error {
  constructor() {
    super("The payment event does not match an order.");
    this.name = "PaymentEventRejectedError";
  }
}
```

Replace `lib/commerce/types.ts` with:

```ts
import type { Locale } from "@/lib/i18n/config";

// Provider-neutral commerce contracts. Nothing in lib/access/grant.ts or apply_payment_event knows a
// specific provider - only this shape, produced once a request has been verified. A real provider
// later implements the same interface with its own signature check.
export type VerifiedPaymentEvent = {
  provider: string;
  eventId: string;
  externalPaymentId: string;
  orderId: string;
  status: "succeeded" | "failed" | "cancelled";
  amountMinor: number;
  currency: string;
  occurredAt: string;
};

export type CheckoutSessionInput = { orderId: string; locale: Locale };

export interface PaymentProvider {
  // Where Pay sends the reader. A redirect back from this URL never changes order state (S3 spec 4.8).
  createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }>;
  verifyEvent(request: Request): Promise<VerifiedPaymentEvent>;
}
```

- [ ] **Step 5: Rewrite the simulator**

Replace `lib/commerce/simulator.ts` with:

```ts
import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import type { CheckoutSessionInput, PaymentProvider, VerifiedPaymentEvent } from "@/lib/commerce/types";
import type { ServerEnv } from "@/lib/config/server-env-schema";
import { getCommerceRoutes } from "@/lib/i18n/routes";
import { REQUEST_ID_HEADER } from "@/lib/observability/request-id";

// The single source of truth for "may the simulator run here". `test` is allowed because every
// automated run uses it; `preview` and `production` are refused.
const SIMULATOR_ALLOWED_APP_ENVS = new Set(["local", "staging", "test"]);

export function isSimulatorAllowedEnvironment(appEnv: string): boolean {
  return SIMULATOR_ALLOWED_APP_ENVS.has(appEnv);
}

// The simulate page and the webhook exist only when both hold (S3 spec 8).
export function isSimulatorCheckoutEnabled(env: Pick<ServerEnv, "appEnv" | "paymentProvider">): boolean {
  return env.paymentProvider === "simulator" && isSimulatorAllowedEnvironment(env.appEnv);
}

export const SIMULATOR_ENVIRONMENT_ERROR_MESSAGE =
  "The payment simulator is only available in local, staging, and test environments.";

export const SIMULATOR_SIGNATURE_HEADER = "x-simulator-signature";

export class SimulatorProviderEnvironmentError extends Error {
  constructor() {
    super(SIMULATOR_ENVIRONMENT_ERROR_MESSAGE);
    this.name = "SimulatorProviderEnvironmentError";
  }
}

export class SimulatorSecretMissingError extends Error {
  constructor() {
    super("PAYMENT_SIMULATOR_SECRET is required for the payment simulator.");
    this.name = "SimulatorSecretMissingError";
  }
}

export class InvalidSimulatorSignatureError extends Error {
  constructor() {
    super("SimulatorProvider.verifyEvent: missing or invalid signature");
    this.name = "InvalidSimulatorSignatureError";
  }
}

export class MalformedSimulatedEventError extends Error {
  constructor(reason: string) {
    super(`SimulatorProvider.verifyEvent: malformed simulated event payload (${reason})`);
    this.name = "MalformedSimulatedEventError";
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HMAC-SHA256 over the exact bytes sent. Staging is publicly reachable, so an unsigned event must
// never reach apply_payment_event (S3 spec 4.6).
export function signSimulatedEvent(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function hasValidSignature(body: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signSimulatedEvent(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const SIMULATED_OUTCOMES = ["succeeded", "failed", "cancelled", "duplicate"] as const;
export type SimulatedOutcome = (typeof SIMULATED_OUTCOMES)[number];

export function isSimulatedOutcome(value: string): value is SimulatedOutcome {
  return (SIMULATED_OUTCOMES as readonly string[]).includes(value);
}

export type SimulatedPaymentEvent = Omit<VerifiedPaymentEvent, "provider">;

// Amount and currency always come from the order, never from a form (S3 spec 5.2). "duplicate"
// delivers one succeeded event twice with the same event ID.
export function buildSimulatedEvents(
  order: { id: string; totalMinor: number; currency: string },
  outcome: SimulatedOutcome,
  eventId: string,
  now: Date,
): SimulatedPaymentEvent[] {
  const event: SimulatedPaymentEvent = {
    eventId,
    externalPaymentId: `sim_pay_${order.id}`,
    orderId: order.id,
    status: outcome === "duplicate" ? "succeeded" : outcome,
    amountMinor: order.totalMinor,
    currency: order.currency,
    occurredAt: now.toISOString(),
  };
  return outcome === "duplicate" ? [event, event] : [event];
}

// The same signed request a network delivery would carry, for in-process delivery (S3 spec 4.7).
export function buildSimulatedEventRequest(event: SimulatedPaymentEvent, secret: string, requestId: string): Request {
  const body = JSON.stringify(event);
  return new Request("http://simulator.internal/api/payments/simulator/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIMULATOR_SIGNATURE_HEADER]: signSimulatedEvent(body, secret),
      [REQUEST_ID_HEADER]: requestId,
    },
    body,
  });
}

type SimulatorEnv = { appEnv: string; simulatorSecret: string | null };

// The MVP's only PaymentProvider. Construction refuses disallowed environments and a missing secret,
// so no code path - a unit test, a route handler, or a Server Action - can build a working simulator
// in production.
export class SimulatorProvider implements PaymentProvider {
  private readonly secret: string;

  constructor(env: SimulatorEnv) {
    if (!isSimulatorAllowedEnvironment(env.appEnv)) {
      throw new SimulatorProviderEnvironmentError();
    }
    if (!env.simulatorSecret) {
      throw new SimulatorSecretMissingError();
    }
    this.secret = env.simulatorSecret;
  }

  async createSession(input: CheckoutSessionInput): Promise<{ redirectUrl: string }> {
    return { redirectUrl: getCommerceRoutes(input.locale).checkoutSimulate(input.orderId) };
  }

  async verifyEvent(request: Request): Promise<VerifiedPaymentEvent> {
    const raw = await request.text();
    if (!hasValidSignature(raw, request.headers.get(SIMULATOR_SIGNATURE_HEADER), this.secret)) {
      throw new InvalidSimulatorSignatureError();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new MalformedSimulatedEventError("json");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new MalformedSimulatedEventError("json");
    }
    const body = parsed as Partial<Record<keyof VerifiedPaymentEvent, unknown>>;

    if (typeof body.eventId !== "string" || body.eventId.length === 0) {
      throw new MalformedSimulatedEventError("eventId");
    }
    if (typeof body.externalPaymentId !== "string" || body.externalPaymentId.length === 0) {
      throw new MalformedSimulatedEventError("externalPaymentId");
    }
    if (typeof body.orderId !== "string" || !uuidPattern.test(body.orderId)) {
      throw new MalformedSimulatedEventError("orderId");
    }
    if (body.status !== "succeeded" && body.status !== "failed" && body.status !== "cancelled") {
      throw new MalformedSimulatedEventError("status");
    }
    if (typeof body.amountMinor !== "number" || !Number.isInteger(body.amountMinor) || body.amountMinor < 0) {
      throw new MalformedSimulatedEventError("amountMinor");
    }
    if (typeof body.currency !== "string" || body.currency.length === 0) {
      throw new MalformedSimulatedEventError("currency");
    }
    if (typeof body.occurredAt !== "string" || body.occurredAt.length === 0) {
      throw new MalformedSimulatedEventError("occurredAt");
    }

    return {
      provider: "simulator",
      eventId: body.eventId,
      externalPaymentId: body.externalPaymentId,
      orderId: body.orderId,
      status: body.status,
      amountMinor: body.amountMinor,
      currency: body.currency,
      occurredAt: body.occurredAt,
    };
  }
}
```

- [ ] **Step 6: Update provider selection and the book action gate**

Replace `lib/commerce/payment-provider.ts` with:

```ts
import "server-only";

import { SimulatorProvider } from "@/lib/commerce/simulator";
import type { PaymentProvider } from "@/lib/commerce/types";
import type { ServerEnv } from "@/lib/config/server-env-schema";

export class PaymentProviderDisabledError extends Error {
  constructor() {
    super("No payment provider is configured.");
    this.name = "PaymentProviderDisabledError";
  }
}

// The app half of the payments gate (S3 spec 4.2). create_ebook_order checks the database half.
export function arePaymentsEnabled(env: Pick<ServerEnv, "paymentProvider">): boolean {
  return env.paymentProvider !== "disabled";
}

// PAYMENT_PROVIDER=disabled has no provider to hand back, so this fails closed instead of returning
// something that silently does nothing.
export function getPaymentProvider(env: Pick<ServerEnv, "appEnv" | "paymentProvider" | "simulatorSecret">): PaymentProvider {
  if (env.paymentProvider === "simulator") {
    return new SimulatorProvider(env);
  }
  throw new PaymentProviderDisabledError();
}
```

In `lib/data/catalog.ts`, import `arePaymentsEnabled` from `@/lib/commerce/payment-provider` and replace

```ts
    paymentsEnabled: getServerEnv().paymentProvider !== "disabled",
```

with

```ts
    paymentsEnabled: arePaymentsEnabled(getServerEnv()),
```

- [ ] **Step 7: Delete the old harness**

```bash
git rm app/admin/test-payments/actions.ts app/admin/test-payments/actions.test.ts
```

Its service-role order inserts bypassed `create_ebook_order`. Checkout and the simulate page replace it.

- [ ] **Step 8: Update configuration**

In `.env.example`, add after `PAYMENT_PROVIDER=simulator`:

```text
# Signs simulated payment events. At least 32 characters. Required when PAYMENT_PROVIDER=simulator.
PAYMENT_SIMULATOR_SECRET=replace-with-at-least-32-random-characters
```

In `playwright.config.ts`, add to `serverEnvironmentDefaults`:

```ts
  PAYMENT_SIMULATOR_SECRET: "e2e-simulator-secret-not-for-real-use-0000",
```

In `.github/workflows/ci.yml`, in both "Point the app and the fixtures at the local stack" steps, add after `echo "PAYMENT_PROVIDER=simulator"`:

```yaml
            echo "PAYMENT_SIMULATOR_SECRET=ci-simulator-secret-not-for-real-use-0000"
```

In `README.md`, add this row after `PAYMENT_PROVIDER`:

```markdown
| `PAYMENT_SIMULATOR_SECRET` | Signs simulated payment events. At least 32 characters. Required when `PAYMENT_PROVIDER=simulator`. |
```

Add the same variable to your own `.env.local` before you run the app. Do not commit `.env.local`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run lib/commerce lib/config lib/data/catalog.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/commerce lib/config lib/data/catalog.ts .env.example playwright.config.ts .github/workflows/ci.yml README.md
git commit -m "feat(commerce): sign simulator events and add provider sessions"
```

---

### Task 5: Simulator webhook

**Files:**
- Create: `lib/commerce/simulator-webhook.ts`, `lib/commerce/simulator-webhook.test.ts`
- Create: `app/api/payments/simulator/webhook/route.ts`
- Modify: `lib/access/grant.ts`, `lib/access/grant.test.ts`

**Interfaces:**
- Consumes: `getPaymentProvider`, `isSimulatorCheckoutEnabled`, `InvalidSimulatorSignatureError`, `MalformedSimulatedEventError` (Task 4); `PaymentEventRejectedError` (Task 4); `applyVerifiedPaymentEvent`; `getRequestId`, `REQUEST_ID_HEADER`.
- Produces:
  - `handleSimulatorWebhook(request: Request): Promise<Response>`. The JSON body always has `requestId`. Status and body are:
    - 404 `{ error: "not_found" }`
    - 401 `{ error: "invalid_signature" }`
    - 400 `{ error: "malformed_event" }`
    - 422 `{ error: "event_rejected" }`
    - 200 `{ orderStatus, paymentStatus }`
    - 500 `{ error: "unexpected" }`
  - `applyVerifiedPaymentEvent` throws `PaymentEventRejectedError` for RPC codes `P0002` and `EB004`.
  - `POST /api/payments/simulator/webhook`.

- [ ] **Step 1: Write the failing tests**

Create `lib/commerce/simulator-webhook.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyVerifiedPaymentEvent } from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { buildSimulatedEventRequest, buildSimulatedEvents, signSimulatedEvent, SIMULATOR_SIGNATURE_HEADER } from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";

vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/access/grant", () => ({ applyVerifiedPaymentEvent: vi.fn() }));

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "req-12345678";

function env(overrides: Partial<{ appEnv: string; paymentProvider: string; simulatorSecret: string | null }> = {}) {
  return { appEnv: "test", paymentProvider: "simulator", simulatorSecret: SECRET, ...overrides } as unknown as ReturnType<typeof getServerEnv>;
}

function validRequest() {
  const [event] = buildSimulatedEvents({ id: ORDER_ID, totalMinor: 150000, currency: "VND" }, "succeeded", "evt-1", new Date("2026-09-15T00:00:00Z"));
  return buildSimulatedEventRequest(event, SECRET, REQUEST_ID);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerEnv).mockReturnValue(env());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSimulatorWebhook", () => {
  it.each([
    ["production", env({ appEnv: "production" })],
    ["preview", env({ appEnv: "preview" })],
    ["payments disabled", env({ paymentProvider: "disabled", simulatorSecret: null })],
  ])("returns 404 when the simulator is off (%s)", async (_label, value) => {
    vi.mocked(getServerEnv).mockReturnValue(value);
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(404);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("returns 401 for a bad signature and applies nothing", async () => {
    const body = JSON.stringify({ orderId: ORDER_ID });
    const request = new Request("http://simulator.internal/", {
      method: "POST",
      headers: { [SIMULATOR_SIGNATURE_HEADER]: "sha256=bad" },
      body,
    });
    const response = await handleSimulatorWebhook(request);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for a signed but malformed event", async () => {
    const body = JSON.stringify({ orderId: "not-a-uuid" });
    const request = new Request("http://simulator.internal/", {
      method: "POST",
      headers: { [SIMULATOR_SIGNATURE_HEADER]: signSimulatedEvent(body, SECRET) },
      body,
    });
    const response = await handleSimulatorWebhook(request);
    expect(response.status).toBe(400);
    expect(applyVerifiedPaymentEvent).not.toHaveBeenCalled();
  });

  it("applies a valid event and returns the outcome with the request ID", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockResolvedValue({ entitlementId: "e1", orderStatus: "completed", paymentStatus: "succeeded" });
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(await response.json()).toEqual({ orderStatus: "completed", paymentStatus: "succeeded", requestId: REQUEST_ID });
    expect(applyVerifiedPaymentEvent).toHaveBeenCalledWith(expect.objectContaining({ provider: "simulator", orderId: ORDER_ID, eventId: "evt-1" }));
  });

  it("returns 422 when the event does not match an order", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new PaymentEventRejectedError());
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(422);
  });

  it("returns 500 without database text and logs the request ID", async () => {
    vi.mocked(applyVerifiedPaymentEvent).mockRejectedValue(new Error("relation secret_table does not exist"));
    const response = await handleSimulatorWebhook(validRequest());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
    expect(console.error).toHaveBeenCalledWith("Simulator webhook failed.", expect.objectContaining({ requestId: REQUEST_ID }));
  });
});
```

In `lib/access/grant.test.ts`, add `import { PaymentEventRejectedError } from "@/lib/commerce/errors";` and add inside `describe("applyVerifiedPaymentEvent", ...)`:

```ts
  it.each(["P0002", "EB004"])("maps RPC code %s to PaymentEventRejectedError", async (code) => {
    vi.mocked(createAdminClient).mockReturnValue(adminRpcClient({ data: null, error: { code, message: "x" } }));
    await expect(applyVerifiedPaymentEvent(baseEvent)).rejects.toThrow(PaymentEventRejectedError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/commerce/simulator-webhook.test.ts lib/access/grant.test.ts`
Expected: FAIL. `simulator-webhook` does not exist, and the grant wrapper throws a plain `Error`.

- [ ] **Step 3: Map rejected events in the grant wrapper**

In `lib/access/grant.ts`, add `import { PaymentEventRejectedError } from "@/lib/commerce/errors";`. In `applyVerifiedPaymentEvent`, replace

```ts
  if (error) {
    throw new Error(`applyVerifiedPaymentEvent: apply_payment_event failed: ${error.message}`);
  }
```

with

```ts
  if (error) {
    if (error.code === "P0002" || error.code === "EB004") throw new PaymentEventRejectedError();
    throw new Error(`applyVerifiedPaymentEvent: apply_payment_event failed: ${error.message}`);
  }
```

In the header comment of `lib/access/grant.ts`, replace

```
// - applyVerifiedPaymentEvent: reached with no session at all (a webhook handler, or - until this
//   MVP has a real provider - the admin test-payments harness after it has already gated on
//   requireAdmin itself). Never gated here on requireAdmin/requireUser, and always the
```

with

```
// - applyVerifiedPaymentEvent: reached with no session at all, from the simulator webhook handler
//   (lib/commerce/simulator-webhook.ts) after the event signature has passed. Never gated here on
//   requireAdmin/requireUser, and always the
```

- [ ] **Step 4: Write the handler and route**

Create `lib/commerce/simulator-webhook.ts`:

```ts
import "server-only";

import { applyVerifiedPaymentEvent } from "@/lib/access/grant";
import { PaymentEventRejectedError } from "@/lib/commerce/errors";
import { getPaymentProvider } from "@/lib/commerce/payment-provider";
import {
  InvalidSimulatorSignatureError,
  isSimulatorCheckoutEnabled,
  MalformedSimulatedEventError,
} from "@/lib/commerce/simulator";
import type { VerifiedPaymentEvent } from "@/lib/commerce/types";
import { getServerEnv } from "@/lib/config/server-env";
import { getRequestId, REQUEST_ID_HEADER } from "@/lib/observability/request-id";

function respond(status: number, body: Record<string, unknown>, requestId: string): Response {
  return Response.json({ ...body, requestId }, { status, headers: { [REQUEST_ID_HEADER]: requestId } });
}

// The one entry point for a simulated payment event (S3 spec 4.7). The webhook route and the simulate
// page's Server Action both call it, so a click and a network delivery take the same path:
// verifyEvent checks the HMAC signature, then apply_payment_event decides the outcome. Responses never
// carry database text; logs carry the request ID.
export async function handleSimulatorWebhook(request: Request): Promise<Response> {
  const requestId = getRequestId(request.headers);
  const env = getServerEnv();
  if (!isSimulatorCheckoutEnabled(env)) {
    return respond(404, { error: "not_found" }, requestId);
  }

  let event: VerifiedPaymentEvent;
  try {
    event = await getPaymentProvider(env).verifyEvent(request);
  } catch (error) {
    if (error instanceof InvalidSimulatorSignatureError) return respond(401, { error: "invalid_signature" }, requestId);
    if (error instanceof MalformedSimulatedEventError) return respond(400, { error: "malformed_event" }, requestId);
    console.error("Simulator webhook could not verify an event.", { requestId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }

  try {
    const outcome = await applyVerifiedPaymentEvent(event);
    return respond(200, { orderStatus: outcome.orderStatus, paymentStatus: outcome.paymentStatus }, requestId);
  } catch (error) {
    if (error instanceof PaymentEventRejectedError) {
      console.warn("Simulator webhook rejected an event.", { requestId, orderId: event.orderId, eventId: event.eventId });
      return respond(422, { error: "event_rejected" }, requestId);
    }
    console.error("Simulator webhook failed.", { requestId, orderId: event.orderId, eventId: event.eventId, error: String(error) });
    return respond(500, { error: "unexpected" }, requestId);
  }
}
```

Create `app/api/payments/simulator/webhook/route.ts`:

```ts
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";

// Signed simulator events only. The handler returns 404 outside local, test, and staging.
export async function POST(request: Request) {
  return handleSimulatorWebhook(request);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/commerce/simulator-webhook.test.ts lib/access/grant.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS. The build lists `ƒ /api/payments/simulator/webhook`.

```bash
git add lib/commerce/simulator-webhook.ts lib/commerce/simulator-webhook.test.ts app/api/payments/simulator/webhook/route.ts lib/access/grant.ts lib/access/grant.test.ts
git commit -m "feat(commerce): add signed simulator webhook"
```

---

### Task 6: Order creation wrapper and customer order reads

**Files:**
- Create: `lib/commerce/orders.ts`, `lib/commerce/orders.test.ts`
- Create: `lib/data/orders.ts`, `lib/data/orders.test.ts`
- Modify: `lib/data/supabase-test-client.ts`

**Interfaces:**
- Consumes: `create_ebook_order` (Task 1); `arePaymentsEnabled` and the commerce errors (Task 4); `EmailNotVerifiedError` from `lib/access/grant.ts`; `getActiveEntitlementBookIds` from `lib/data/catalog.ts`; `getCurrentProfile`; `OrderStatus` and `PaymentStatus` (Task 3).
- Produces:
  - `createEbookOrder(locale: Locale, bookId: string): Promise<{ orderId: string }>`. It throws `PaymentsDisabledError`, `EmailNotVerifiedError`, `NotPurchasableError`, `AlreadyOwnedError`, or `Error`.
  - `type CustomerOrderDTO = { id: string; bookId: string; title: string; status: OrderStatus; paymentStatus: PaymentStatus; totalMinor: number; currency: string; createdAt: string; hasActiveEntitlement: boolean }`
  - `getCustomerOrder(orderId: string): Promise<CustomerOrderDTO | null>` returns null for a bad ID, a signed-out caller, or another reader's order.
  - `listCustomerOrders(): Promise<CustomerOrderDTO[]>` returns newest first, at most 100.
  - Test helper `recordingChain(result): { chain: unknown; calls: [string, unknown[]][] }`.

- [ ] **Step 1: Add the recording test helper**

Append to `lib/data/supabase-test-client.ts`:

```ts
// Like chainResult, but records each builder call, so a test can assert on a security-relevant filter
// such as .eq("profile_id", ...).
export function recordingChain(result: { data: unknown; error: unknown }): { chain: unknown; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          calls.push([String(property), args]);
          return proxy;
        };
      },
    },
  );
  return { chain: proxy, calls };
}
```

- [ ] **Step 2: Write the failing tests**

Create `lib/commerce/orders.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createEbookOrder } from "@/lib/commerce/orders";
import { getServerEnv } from "@/lib/config/server-env";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";

function rpcClient(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  vi.mocked(createClient).mockResolvedValue({ rpc } as unknown as Awaited<ReturnType<typeof createClient>>);
  return rpc;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "simulator" } as ReturnType<typeof getServerEnv>);
});

describe("createEbookOrder", () => {
  it("gates on the signed-in user before anything else", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow("NEXT_REDIRECT");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("refuses without calling the RPC when the app gate is off", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ paymentProvider: "disabled" } as ReturnType<typeof getServerEnv>);
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow(PaymentsDisabledError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the order ID from create_ebook_order", async () => {
    const rpc = rpcClient({ data: ORDER_ID, error: null });
    await expect(createEbookOrder("en", BOOK_ID)).resolves.toEqual({ orderId: ORDER_ID });
    expect(rpc).toHaveBeenCalledWith("create_ebook_order", { p_book_id: BOOK_ID });
  });

  it.each([
    ["EB005", EmailNotVerifiedError],
    ["EB011", PaymentsDisabledError],
    ["EB012", NotPurchasableError],
    ["EB013", AlreadyOwnedError],
  ] as const)("maps %s to a typed error", async (code, ErrorClass) => {
    rpcClient({ data: null, error: { code, message: "x" } });
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow(ErrorClass);
  });

  it("throws a plain error for anything else", async () => {
    rpcClient({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(createEbookOrder("en", BOOK_ID)).rejects.toThrow("createEbookOrder: create_ebook_order failed");
  });
});
```

Create `lib/data/orders.test.ts`:

```ts
// @vitest-environment node
import { headers } from "next/headers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getActiveEntitlementBookIds } from "@/lib/data/catalog";
import { getCustomerOrder, listCustomerOrders } from "@/lib/data/orders";
import { getCurrentProfile } from "@/lib/data/profiles";
import { recordingChain } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/data/catalog", () => ({ getActiveEntitlementBookIds: vi.fn() }));
vi.mock("@/lib/data/profiles", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const PROFILE_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const BOOK_ID = "30000000-0000-4000-8000-000000000001";

const row = {
  id: ORDER_ID,
  status: "pending",
  payment_status: "failed",
  total_minor: 129000,
  currency: "VND",
  created_at: "2026-09-15T00:00:00+00:00",
  items: [{ book_id: BOOK_ID, title_snapshot: "A Book" }],
};

function mockOrders(result: { data: unknown; error: unknown }) {
  const recorded = recordingChain(result);
  const from = vi.fn(() => recorded.chain);
  vi.mocked(createClient).mockResolvedValue({ from } as unknown as Awaited<ReturnType<typeof createClient>>);
  return { from, calls: recorded.calls };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCurrentProfile).mockResolvedValue({ id: PROFILE_ID, auth_user_id: "u1", display_name: null, locale: "en" });
  vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set());
  vi.mocked(headers).mockResolvedValue(new Headers() as unknown as Awaited<ReturnType<typeof headers>>);
});

describe("getCustomerOrder", () => {
  it("returns null for a non-UUID without querying", async () => {
    await expect(getCustomerOrder("order-1")).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns null when signed out", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue(null);
    await expect(getCustomerOrder(ORDER_ID)).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("filters by the caller's profile and maps the order", async () => {
    const { from, calls } = mockOrders({ data: row, error: null });
    vi.mocked(getActiveEntitlementBookIds).mockResolvedValue(new Set([BOOK_ID]));

    await expect(getCustomerOrder(ORDER_ID)).resolves.toEqual({
      id: ORDER_ID,
      bookId: BOOK_ID,
      title: "A Book",
      status: "pending",
      paymentStatus: "failed",
      totalMinor: 129000,
      currency: "VND",
      createdAt: "2026-09-15T00:00:00+00:00",
      hasActiveEntitlement: true,
    });
    expect(from).toHaveBeenCalledWith("orders");
    expect(calls).toContainEqual(["eq", ["id", ORDER_ID]]);
    expect(calls).toContainEqual(["eq", ["profile_id", PROFILE_ID]]);
  });

  it("returns null when no row matches", async () => {
    mockOrders({ data: null, error: null });
    await expect(getCustomerOrder(ORDER_ID)).resolves.toBeNull();
  });

  it("throws a generic error on a database failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockOrders({ data: null, error: { code: "XX000", message: "secret detail" } });
    await expect(getCustomerOrder(ORDER_ID)).rejects.toThrow("getCustomerOrder failed.");
  });
});

describe("listCustomerOrders", () => {
  it("returns the caller's orders and skips rows without an item", async () => {
    const { calls } = mockOrders({ data: [row, { ...row, id: "other", items: [] }], error: null });
    const orders = await listCustomerOrders();
    expect(orders.map((order) => order.id)).toEqual([ORDER_ID]);
    expect(calls).toContainEqual(["eq", ["profile_id", PROFILE_ID]]);
    expect(calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
  });

  it("returns an empty list when signed out", async () => {
    vi.mocked(getCurrentProfile).mockResolvedValue(null);
    await expect(listCustomerOrders()).resolves.toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run lib/commerce/orders.test.ts lib/data/orders.test.ts`
Expected: FAIL. Both modules are missing.

- [ ] **Step 4: Implement**

Create `lib/commerce/orders.ts`:

```ts
import "server-only";

import { EmailNotVerifiedError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import type { Locale } from "@/lib/i18n/config";
import { createClient } from "@/lib/supabase/server";

// Paid order creation (S3 spec 4.3). The app gate runs first. create_ebook_order repeats the check
// against commerce_settings, so neither gate alone can open paid checkout. The profile, offer, and
// price are resolved inside the RPC; this wrapper forwards only the book ID.
export async function createEbookOrder(locale: Locale, bookId: string): Promise<{ orderId: string }> {
  await requireUser(locale);
  if (!arePaymentsEnabled(getServerEnv())) throw new PaymentsDisabledError();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_ebook_order", { p_book_id: bookId });

  if (error) {
    if (error.code === "EB005") throw new EmailNotVerifiedError();
    if (error.code === "EB011") throw new PaymentsDisabledError();
    if (error.code === "EB012") throw new NotPurchasableError();
    if (error.code === "EB013") throw new AlreadyOwnedError();
    throw new Error(`createEbookOrder: create_ebook_order failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("createEbookOrder: create_ebook_order returned no order id");
  }

  return { orderId: data };
}
```

Create `lib/data/orders.ts`:

```ts
import "server-only";

import { headers } from "next/headers";

import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";
import { getActiveEntitlementBookIds } from "@/lib/data/catalog";
import { getCurrentProfile } from "@/lib/data/profiles";
import { getRequestId } from "@/lib/observability/request-id";
import { createClient } from "@/lib/supabase/server";

export type CustomerOrderDTO = {
  id: string;
  bookId: string;
  title: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  totalMinor: number;
  currency: string;
  createdAt: string;
  hasActiveEntitlement: boolean;
};

type OrderRow = {
  id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total_minor: number;
  currency: string;
  created_at: string;
  items: { book_id: string; title_snapshot: string }[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orderColumns = "id, status, payment_status, total_minor, currency, created_at, items:order_items ( book_id, title_snapshot )";

async function failure(operation: string, cause: unknown): Promise<Error> {
  let requestId: string | null = null;
  try {
    requestId = getRequestId(await headers());
  } catch {
    // Outside a request scope there is no request ID.
  }
  console.error("Order read failed.", { operation, code: (cause as { code?: string } | null)?.code ?? null, requestId });
  return new Error(`${operation} failed.`, { cause });
}

function toDTO(row: OrderRow, owned: Set<string>): CustomerOrderDTO | null {
  const item = row.items[0];
  if (!item) return null;
  return {
    id: row.id,
    bookId: item.book_id,
    title: item.title_snapshot,
    status: row.status,
    paymentStatus: row.payment_status,
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    createdAt: row.created_at,
    hasActiveEntitlement: owned.has(item.book_id),
  };
}

// Customer order reads (S3 spec 4.9). RLS limits a reader to their own orders, but admins can read
// every order, so each query also filters by the caller's own profile ID. Another reader's order
// looks exactly like a missing one.
export async function getCustomerOrder(orderId: string): Promise<CustomerOrderDTO | null> {
  if (!uuidPattern.test(orderId)) return null;
  const profile = await getCurrentProfile();
  if (!profile) return null;

  const supabase = await createClient();
  const [{ data, error }, owned] = await Promise.all([
    supabase.from("orders").select(orderColumns).eq("id", orderId).eq("profile_id", profile.id).maybeSingle(),
    getActiveEntitlementBookIds(profile.id),
  ]);
  if (error) throw await failure("getCustomerOrder", error);
  return data ? toDTO(data as unknown as OrderRow, owned) : null;
}

export async function listCustomerOrders(): Promise<CustomerOrderDTO[]> {
  const profile = await getCurrentProfile();
  if (!profile) return [];

  const supabase = await createClient();
  const [{ data, error }, owned] = await Promise.all([
    supabase
      .from("orders")
      .select(orderColumns)
      .eq("profile_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(100),
    getActiveEntitlementBookIds(profile.id),
  ]);
  if (error) throw await failure("listCustomerOrders", error);
  return ((data ?? []) as unknown as OrderRow[]).flatMap((row) => toDTO(row, owned) ?? []);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run lib/commerce/orders.test.ts lib/data/orders.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/commerce/orders.ts lib/commerce/orders.test.ts lib/data/orders.ts lib/data/orders.test.ts lib/data/supabase-test-client.ts
git commit -m "feat(commerce): add order creation and customer order reads"
```

---

### Task 7: Get free and Buy on the book page

**Files:**
- Modify: `lib/i18n/dictionaries/en.json`, `lib/i18n/dictionaries/vi.json`
- Modify: `components/auth/submit-button.tsx`
- Modify: `components/catalog/book-action-control.tsx`, `components/catalog/book-action-control.test.tsx`
- Modify: `app/[locale]/(public)/books/[slug]/actions.ts`
- Create: `app/[locale]/(public)/books/[slug]/actions.test.ts`
- Modify: `app/[locale]/(public)/books/[slug]/page.tsx`

**Interfaces:**
- Consumes: `acquireFreeEbookAction` (existing); `createEbookOrder` (Task 6); commerce errors (Task 4); `EmailNotVerifiedError`; `parseBookActionError`, `BookActionErrorCode`, `getCommerceRoutes` (Task 3).
- Produces:
  - `getFreeEbookAction(locale: string, bookId: string, slug: string): Promise<void>`. On success it redirects to `/{locale}/read/{bookId}`. On error it redirects to the book page with `?action-error=<code>`.
  - `buyEbookAction(locale: string, bookId: string, slug: string): Promise<void>`. It redirects to checkout, to the reader (already owned), or to the book page with an error code.
  - `BookActionControl` gains the required props `getFreeAction: () => Promise<void>` and `buyAction: () => Promise<void>`.
  - `SubmitButton` gains the optional props `className` (default `"min-h-11 w-full"`), `size`, and `variant`.
  - All S3 dictionary keys: `catalog.actions.pending`, `catalog.actionErrors.*`, `checkout.*`, `orders.*`. Later tasks use them.

- [ ] **Step 1: Add the dictionary copy**

In `lib/i18n/dictionaries/en.json`, add `"pending": "Working…"` to `catalog.actions`, add this object inside `catalog` after `actions`:

```json
    "actionErrors": {
      "email-not-verified": "Confirm your email before getting this book.",
      "no-free-offer": "This book is no longer free.",
      "payments-unavailable": "Buying ebooks is not available yet.",
      "not-purchasable": "This book cannot be bought right now.",
      "unexpected": "Something went wrong. Please try again."
    },
```

and add these top-level objects after `catalog`:

```json
  "checkout": {
    "eyebrow": "Checkout",
    "title": "Review your order",
    "description": "You are buying an ebook for your Infinity Books account.",
    "total": "Total",
    "account": "Account",
    "pay": "Pay",
    "paying": "Starting payment…",
    "previousFailed": "Your last payment did not go through. You can try again.",
    "alreadyOwned": "You already own this book.",
    "readNow": "Read now",
    "simulate": {
      "eyebrow": "Payment simulator",
      "title": "Simulate the payment",
      "description": "This page exists only in test environments. Choose what the payment provider reports.",
      "succeed": "Succeed",
      "fail": "Fail",
      "cancel": "Cancel",
      "duplicate": "Send duplicate",
      "sending": "Sending…"
    },
    "status": {
      "eyebrow": "Order status",
      "processingTitle": "Processing your payment",
      "processingBody": "This page updates on its own for a short while.",
      "checkAgain": "Check again",
      "successTitle": "Payment complete",
      "successBody": "Your ebook is ready in your library.",
      "failedTitle": "Payment did not go through",
      "failedBody": "The payment was not completed. You can try again.",
      "tryAgain": "Try again",
      "cancelledTitle": "Order cancelled",
      "cancelledBody": "This order was cancelled.",
      "backToBook": "Back to the book",
      "library": "Go to your library"
    }
  },
  "orders": {
    "navLabel": "Orders",
    "eyebrow": "Your account",
    "title": "Orders",
    "description": "Ebooks you got or bought.",
    "emptyTitle": "No orders yet",
    "emptyBody": "Books you get or buy will appear here.",
    "browse": "Browse books",
    "listLabel": "Your orders",
    "free": "Free",
    "placedOn": "Placed on {date}",
    "total": "Total",
    "status": "Status",
    "detailEyebrow": "Order",
    "continueCheckout": "Continue to payment",
    "read": "Read now",
    "statuses": {
      "completed": "Completed",
      "awaitingPayment": "Awaiting payment",
      "paymentFailed": "Payment failed",
      "cancelled": "Cancelled"
    }
  },
```

In `lib/i18n/dictionaries/vi.json`, add the same keys in the same places:

```json
      "pending": "Đang xử lý…"
```

```json
    "actionErrors": {
      "email-not-verified": "Hãy xác nhận email trước khi nhận sách này.",
      "no-free-offer": "Sách này hiện không còn miễn phí.",
      "payments-unavailable": "Chức năng mua ebook chưa sẵn sàng.",
      "not-purchasable": "Hiện chưa thể mua sách này.",
      "unexpected": "Đã có lỗi xảy ra. Vui lòng thử lại."
    },
```

```json
  "checkout": {
    "eyebrow": "Thanh toán",
    "title": "Xem lại đơn hàng",
    "description": "Bạn đang mua một ebook cho tài khoản Infinity Books của mình.",
    "total": "Tổng cộng",
    "account": "Tài khoản",
    "pay": "Thanh toán",
    "paying": "Đang bắt đầu thanh toán…",
    "previousFailed": "Lần thanh toán trước chưa thành công. Bạn có thể thử lại.",
    "alreadyOwned": "Bạn đã sở hữu sách này.",
    "readNow": "Đọc ngay",
    "simulate": {
      "eyebrow": "Trình giả lập thanh toán",
      "title": "Giả lập kết quả thanh toán",
      "description": "Trang này chỉ có trong môi trường thử nghiệm. Chọn kết quả mà nhà cung cấp thanh toán gửi về.",
      "succeed": "Thành công",
      "fail": "Thất bại",
      "cancel": "Hủy",
      "duplicate": "Gửi trùng lặp",
      "sending": "Đang gửi…"
    },
    "status": {
      "eyebrow": "Trạng thái đơn hàng",
      "processingTitle": "Đang xử lý thanh toán",
      "processingBody": "Trang này sẽ tự cập nhật trong giây lát.",
      "checkAgain": "Kiểm tra lại",
      "successTitle": "Thanh toán thành công",
      "successBody": "Ebook của bạn đã có trong thư viện.",
      "failedTitle": "Thanh toán chưa thành công",
      "failedBody": "Giao dịch chưa hoàn tất. Bạn có thể thử lại.",
      "tryAgain": "Thử lại",
      "cancelledTitle": "Đơn hàng đã hủy",
      "cancelledBody": "Đơn hàng này đã bị hủy.",
      "backToBook": "Quay lại trang sách",
      "library": "Đến thư viện"
    }
  },
  "orders": {
    "navLabel": "Đơn hàng",
    "eyebrow": "Tài khoản của bạn",
    "title": "Đơn hàng",
    "description": "Các ebook bạn đã nhận hoặc đã mua.",
    "emptyTitle": "Chưa có đơn hàng",
    "emptyBody": "Sách bạn nhận hoặc mua sẽ xuất hiện ở đây.",
    "browse": "Xem sách",
    "listLabel": "Đơn hàng của bạn",
    "free": "Miễn phí",
    "placedOn": "Đặt ngày {date}",
    "total": "Tổng cộng",
    "status": "Trạng thái",
    "detailEyebrow": "Đơn hàng",
    "continueCheckout": "Tiếp tục thanh toán",
    "read": "Đọc ngay",
    "statuses": {
      "completed": "Hoàn tất",
      "awaitingPayment": "Chờ thanh toán",
      "paymentFailed": "Thanh toán thất bại",
      "cancelled": "Đã hủy"
    }
  },
```

Run: `npx vitest run lib/i18n/dictionary.test.ts`
Expected: PASS (same keys in both locales, none empty).

- [ ] **Step 2: Write the failing tests**

In `components/catalog/book-action-control.test.tsx`, add `vi` to the `vitest` import. Change `props` to include the actions:

```ts
const props = {
  bookId: BOOK_ID,
  bookPath: "/en/books/a-book",
  locale: "en" as const,
  copy: en.catalog.actions,
  getFreeAction: vi.fn(async () => undefined),
  buyAction: vi.fn(async () => undefined),
};
```

Replace the test "disables Get and Buy for a signed-in reader until S3" with:

```ts
  it("gives a signed-in reader an enabled Get free or Buy submit button", () => {
    const { rerender } = render(<BookActionControl {...props} action="get_free" signedIn />);
    const getFree = screen.getByRole("button", { name: "Get free" });
    expect(getFree).toBeEnabled();
    expect(getFree).toHaveAttribute("type", "submit");
    expect(getFree.closest("form")).not.toBeNull();

    rerender(<BookActionControl {...props} action="buy" signedIn />);
    expect(screen.getByRole("button", { name: "Buy ebook" })).toBeEnabled();
  });
```

Create `app/[locale]/(public)/books/[slug]/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buyEbookAction, getFreeEbookAction } from "@/app/[locale]/(public)/books/[slug]/actions";
import { acquireFreeOffer, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createEbookOrder } from "@/lib/commerce/orders";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/commerce/orders", () => ({ createEbookOrder: vi.fn() }));
vi.mock("@/lib/access/grant", () => {
  class EmailNotVerifiedError extends Error {}
  class NoFreeOfferError extends Error {}
  return { acquireFreeOffer: vi.fn(), EmailNotVerifiedError, NoFreeOfferError };
});

const BOOK_ID = "30000000-0000-4000-8000-000000000001";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("getFreeEbookAction", () => {
  it("sends the reader to the reader after a free acquisition", async () => {
    vi.mocked(acquireFreeOffer).mockResolvedValue({ entitlementId: "e1" });
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book")).rejects.toThrow(`NEXT_REDIRECT /en/read/${BOOK_ID}`);
    expect(requireUser).toHaveBeenCalledWith("en", "/en/books/a-book");
  });

  it.each([
    [new EmailNotVerifiedError(), "email-not-verified"],
    [new NoFreeOfferError(), "no-free-offer"],
    [new Error("boom"), "unexpected"],
  ])("returns to the book with an error code (%s)", async (error, code) => {
    vi.mocked(acquireFreeOffer).mockRejectedValue(error);
    await expect(getFreeEbookAction("en", BOOK_ID, "a-book")).rejects.toThrow(`NEXT_REDIRECT /en/books/a-book?action-error=${code}`);
  });

  it("redirects home for an invalid locale or book ID without acquiring", async () => {
    await expect(getFreeEbookAction("fr", BOOK_ID, "a-book")).rejects.toThrow("NEXT_REDIRECT /vi");
    await expect(getFreeEbookAction("en", "not-a-uuid", "a-book")).rejects.toThrow("NEXT_REDIRECT /vi");
    expect(acquireFreeOffer).not.toHaveBeenCalled();
  });
});

describe("buyEbookAction", () => {
  it("sends the reader to checkout for the new order", async () => {
    vi.mocked(createEbookOrder).mockResolvedValue({ orderId: ORDER_ID });
    await expect(buyEbookAction("vi", BOOK_ID, "mot-cuon-sach")).rejects.toThrow(`NEXT_REDIRECT /vi/checkout/${ORDER_ID}`);
    expect(createEbookOrder).toHaveBeenCalledWith("vi", BOOK_ID);
  });

  it("sends an owner to the reader", async () => {
    vi.mocked(createEbookOrder).mockRejectedValue(new AlreadyOwnedError());
    await expect(buyEbookAction("en", BOOK_ID, "a-book")).rejects.toThrow(`NEXT_REDIRECT /en/read/${BOOK_ID}`);
  });

  it.each([
    [new EmailNotVerifiedError(), "email-not-verified"],
    [new PaymentsDisabledError(), "payments-unavailable"],
    [new NotPurchasableError(), "not-purchasable"],
    [new Error("boom"), "unexpected"],
  ])("returns to the book with an error code (%s)", async (error, code) => {
    vi.mocked(createEbookOrder).mockRejectedValue(error);
    await expect(buyEbookAction("en", BOOK_ID, "a-book")).rejects.toThrow(`NEXT_REDIRECT /en/books/a-book?action-error=${code}`);
  });

  it("logs an unexpected failure", async () => {
    vi.mocked(createEbookOrder).mockRejectedValue(new Error("boom"));
    await expect(buyEbookAction("en", BOOK_ID, "a-book")).rejects.toThrow("NEXT_REDIRECT");
    expect(console.error).toHaveBeenCalledWith("Buy ebook failed.", expect.objectContaining({ bookId: BOOK_ID }));
  });

  it("uses the catalog page when the slug is not a slug", async () => {
    vi.mocked(createEbookOrder).mockRejectedValue(new NotPurchasableError());
    await expect(buyEbookAction("en", BOOK_ID, "../evil")).rejects.toThrow("NEXT_REDIRECT /en/books");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run components/catalog/book-action-control.test.tsx "app/[locale]/(public)/books/[slug]/actions.test.ts"`
Expected: FAIL. The signed-in button is disabled, and `getFreeEbookAction` and `buyEbookAction` are not exported.

- [ ] **Step 4: Extend SubmitButton**

Replace `components/auth/submit-button.tsx` with:

```tsx
"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

type ButtonProps = ComponentProps<typeof Button>;

export function SubmitButton({
  children,
  pendingLabel,
  className = "min-h-11 w-full",
  size,
  variant,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
}) {
  const { pending } = useFormStatus();

  return (
    <Button className={className} disabled={pending} size={size} type="submit" variant={variant}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
```

- [ ] **Step 5: Wire the forms into the control**

In `components/catalog/book-action-control.tsx`:

1. Add `import { SubmitButton } from "@/components/auth/submit-button";`.
2. Add `getFreeAction` and `buyAction` to the destructured props, and add to the props type:

```ts
  // Bound Server Actions from the book page. The control only renders them; the actions and
  // create_ebook_order/acquire_free_ebook re-check everything.
  getFreeAction: () => Promise<void>;
  buyAction: () => Promise<void>;
```

3. Replace the signed-in branch:

```tsx
      // S3 replaces this disabled button with the Get and Buy Server Actions.
      return (
        <Button disabled size="lg">
          {label}
        </Button>
      );
```

with

```tsx
      return (
        <form action={action === "get_free" ? getFreeAction : buyAction}>
          <SubmitButton className="" pendingLabel={copy.pending} size="lg">
            {label}
          </SubmitButton>
        </form>
      );
```

- [ ] **Step 6: Add the form actions**

In `app/[locale]/(public)/books/[slug]/actions.ts`, replace the imports with:

```ts
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { acquireFreeOffer, EmailNotVerifiedError, NoFreeOfferError } from "@/lib/access/grant";
import { requireUser } from "@/lib/auth/session";
import type { BookActionErrorCode } from "@/lib/catalog/action-error";
import { AlreadyOwnedError, NotPurchasableError, PaymentsDisabledError } from "@/lib/commerce/errors";
import { createEbookOrder } from "@/lib/commerce/orders";
import { defaultLocale, isLocale, type Locale, withLocale } from "@/lib/i18n/config";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";
```

Keep `acquireFreeEbookAction` and its types unchanged. Append:

```ts
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Bound arguments come back from the browser, so the slug is checked before it becomes a path.
function bookPath(locale: Locale, slug: string): string {
  return slugPattern.test(slug) ? getCatalogRoutes(locale).book(slug) : getLocaleRoutes(locale).books;
}

function bookErrorPath(locale: Locale, slug: string, code: BookActionErrorCode): string {
  return slugPattern.test(slug) ? getCommerceRoutes(locale).bookActionError(slug, code) : getLocaleRoutes(locale).books;
}

function buyErrorCode(error: unknown): BookActionErrorCode {
  if (error instanceof EmailNotVerifiedError) return "email-not-verified";
  if (error instanceof PaymentsDisabledError) return "payments-unavailable";
  if (error instanceof NotPurchasableError) return "not-purchasable";
  return "unexpected";
}

// The signed-in Get free form (S3 spec 5.1). It always ends in a redirect: the reader on success, or
// the book page with a stable error code.
export async function getFreeEbookAction(locale: string, bookId: string, slug: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bookId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bookPath(locale, slug));

  const result = await acquireFreeEbookAction(locale, bookId);
  if (!result.ok) {
    redirect(bookErrorPath(locale, slug, result.error === "invalid-locale" ? "unexpected" : result.error));
  }
  redirect(getCatalogRoutes(locale).read(bookId));
}

// The signed-in Buy form (S3 spec 5.2). redirect() stays outside the try block, because it throws a
// control-flow value Next.js must see.
export async function buyEbookAction(locale: string, bookId: string, slug: string): Promise<void> {
  if (!isLocale(locale) || !uuidPattern.test(bookId)) redirect(withLocale(defaultLocale, "/"));
  await requireUser(locale, bookPath(locale, slug));

  let destination: string;
  try {
    const { orderId } = await createEbookOrder(locale, bookId);
    destination = getCommerceRoutes(locale).checkout(orderId);
  } catch (error) {
    if (error instanceof AlreadyOwnedError) {
      destination = getCatalogRoutes(locale).read(bookId);
    } else {
      const code = buyErrorCode(error);
      if (code === "unexpected") {
        console.error("Buy ebook failed.", { bookId, requestId: getRequestId(await headers()), error: String(error) });
      }
      destination = bookErrorPath(locale, slug, code);
    }
  }
  redirect(destination);
}
```

`withLocale("vi", "/")` returns `/vi`, which is the path the tests expect.

- [ ] **Step 7: Wire the book page**

In `app/[locale]/(public)/books/[slug]/page.tsx`:

1. Add imports:

```ts
import { parseBookActionError } from "@/lib/catalog/action-error";

import { buyEbookAction, getFreeEbookAction } from "./actions";
```

2. Change `Props` to:

```ts
type Props = {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ "action-error"?: string | string[] }>;
};
```

3. Change the component signature to `export default async function BookPage({ params, searchParams }: Props)`. After `const other = otherLocale(locale);` add:

```ts
  const actionError = parseBookActionError((await searchParams)["action-error"]);
```

4. Add these props to `<BookActionControl ... />`:

```tsx
                buyAction={buyEbookAction.bind(null, locale, book.bookId, book.slug)}
                getFreeAction={getFreeEbookAction.bind(null, locale, book.bookId, book.slug)}
```

5. Right after the closing `</div>` of the price-and-action block (`border-y border-hairline py-6`), add:

```tsx
            {actionError ? (
              <p className="mt-4 text-sm text-error" role="alert">
                {copy.actionErrors[actionError]}
              </p>
            ) : null}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run components/catalog "app/[locale]/(public)/books/[slug]/actions.test.ts" lib/i18n`
Expected: PASS.

- [ ] **Step 9: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/i18n/dictionaries components/auth/submit-button.tsx components/catalog/book-action-control.tsx components/catalog/book-action-control.test.tsx "app/[locale]/(public)/books/[slug]"
git commit -m "feat(storefront): wire Get free and Buy actions"
```

---

### Task 8: Checkout page and Pay

**Files:**
- Create: `app/[locale]/(account)/checkout/[orderId]/actions.ts`, `app/[locale]/(account)/checkout/[orderId]/actions.test.ts`
- Create: `app/[locale]/(account)/checkout/[orderId]/page.tsx`

**Interfaces:**
- Consumes: `getCustomerOrder` (Task 6), `arePaymentsEnabled` and `getPaymentProvider` (Task 4), `getCommerceRoutes` (Task 3), `getBookCards`, `CoverImage`, `SubmitButton` (Task 7), dictionary `checkout.*`.
- Produces: `payOrderAction(locale: string, orderId: string): Promise<void>`. It redirects to the provider session URL. It redirects to status when the order is not pending, back to checkout when the book is already owned, and to the orders list when payments are off or the order is missing.

- [ ] **Step 1: Write the failing action test**

Create `app/[locale]/(account)/checkout/[orderId]/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { payOrderAction } from "@/app/[locale]/(account)/checkout/[orderId]/actions";
import { requireUser } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));

const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bookId: "30000000-0000-4000-8000-000000000001",
  title: "A Book",
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 129000,
  currency: "VND",
  createdAt: "2026-09-15T00:00:00Z",
  hasActiveEntitlement: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({
    appEnv: "test",
    paymentProvider: "simulator",
    simulatorSecret: "test-simulator-secret-0123456789abcdef",
  } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
});

describe("payOrderAction", () => {
  it("requires a signed-in reader and returns them to this checkout", async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT sign-in"));
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT sign-in");
    expect(requireUser).toHaveBeenCalledWith("en", `/en/checkout/${ORDER_ID}`);
    expect(getCustomerOrder).not.toHaveBeenCalled();
  });

  it("sends a pending order to the provider session", async () => {
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/simulate`);
  });

  it("refuses when payments are disabled", async () => {
    vi.mocked(getServerEnv).mockReturnValue({ appEnv: "production", paymentProvider: "disabled", simulatorSecret: null } as ReturnType<typeof getServerEnv>);
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(getCustomerOrder).not.toHaveBeenCalled();
  });

  it("treats a missing or foreign order as missing", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
  });

  it("sends a finished order to its status page", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, status: "completed", paymentStatus: "succeeded" });
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
  });

  it("never starts a payment for a book the reader already owns", async () => {
    vi.mocked(getCustomerOrder).mockResolvedValue({ ...order, hasActiveEntitlement: true });
    await expect(payOrderAction("en", ORDER_ID)).rejects.toThrow(new RegExp(`NEXT_REDIRECT /en/checkout/${ORDER_ID}$`));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run "app/[locale]/(account)/checkout/[orderId]/actions.test.ts"`
Expected: FAIL because the module is missing.

- [ ] **Step 3: Write the action**

Create `app/[locale]/(account)/checkout/[orderId]/actions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { arePaymentsEnabled, getPaymentProvider } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

// Every runtime export below is an async function: a non-function export from a "use server" module
// builds cleanly and then crashes the client at request time.

// Pay (S3 spec 5.2 step 3). It re-checks ownership, pending state, and existing access, then hands
// the reader to the provider. Returning from the provider never changes the order; only a verified
// payment event does.
export async function payOrderAction(locale: string, orderId: string): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  const ordersPath = getLocaleRoutes(locale).orders;
  await requireUser(locale, commerce.checkout(orderId));

  const env = getServerEnv();
  if (!arePaymentsEnabled(env)) redirect(ordersPath);

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(ordersPath);
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));
  if (order.hasActiveEntitlement) redirect(commerce.checkout(order.id));

  const { redirectUrl } = await getPaymentProvider(env).createSession({ orderId: order.id, locale });
  redirect(redirectUrl);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run "app/[locale]/(account)/checkout/[orderId]/actions.test.ts"`
Expected: PASS.

- [ ] **Step 5: Write the checkout page**

Create `app/[locale]/(account)/checkout/[orderId]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SubmitButton } from "@/components/auth/submit-button";
import { CoverImage } from "@/components/catalog/cover-image";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getBookCards } from "@/lib/data/catalog";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getCommerceRoutes } from "@/lib/i18n/routes";

import { payOrderAction } from "./actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ locale: string; orderId: string }> };

// Checkout for one pending ebook order (S3 spec 5.2 step 2). There are no shipping fields. The total
// is the order's server-side snapshot.
export default async function CheckoutPage({ params }: Props) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  const user = await requireUser(locale, commerce.checkout(orderId));
  if (!arePaymentsEnabled(getServerEnv())) notFound();

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();
  if (order.status !== "pending") redirect(commerce.checkoutStatus(order.id));

  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const copy = dictionary.checkout;
  const card = cards.find((candidate) => candidate.bookId === order.bookId);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[48rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-10 text-[0.9375rem] text-ink-soft">{copy.description}</p>

        <section aria-label={order.title} className="grid grid-cols-[5rem_1fr] gap-6 border-y border-hairline py-6 sm:grid-cols-[7rem_1fr]">
          <CoverImage
            card={card ?? { bookId: order.bookId, title: order.title, author: { name: "", slug: null }, cover: null }}
            decorative
            size="sm"
            sizes="7rem"
          />
          <div className="min-w-0 space-y-2">
            <p className="font-serif text-2xl leading-tight">{order.title}</p>
            {card ? <p className="text-sm text-ink-soft">{card.author.name}</p> : null}
            <p className="text-sm text-sage-text">{dictionary.catalog.book.format}</p>
          </div>
        </section>

        <dl className="mt-6 space-y-3 text-[0.9375rem]">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <dt className="text-ink-soft">{copy.account}</dt>
            <dd className="min-w-0 break-all">{user.email}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline pt-3">
            <dt className="font-medium">{copy.total}</dt>
            <dd className="text-xl font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</dd>
          </div>
        </dl>

        <div className="mt-8 space-y-4">
          {order.hasActiveEntitlement ? (
            <>
              <p role="status">{copy.alreadyOwned}</p>
              <Button render={<Link href={getCatalogRoutes(locale).read(order.bookId)} />} size="lg">
                {copy.readNow}
              </Button>
            </>
          ) : (
            <>
              {order.paymentStatus === "failed" ? (
                <p className="text-sm text-error" role="alert">
                  {copy.previousFailed}
                </p>
              ) : null}
              <form action={payOrderAction.bind(null, locale, order.id)}>
                <SubmitButton className="w-full sm:w-auto" pendingLabel={copy.paying} size="lg">
                  {copy.pay}
                </SubmitButton>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 6: Run the checks and commit**

Run: `npm run check`
Expected: PASS. The build lists `ƒ /[locale]/checkout/[orderId]`.

```bash
git add "app/[locale]/(account)/checkout/[orderId]/actions.ts" "app/[locale]/(account)/checkout/[orderId]/actions.test.ts" "app/[locale]/(account)/checkout/[orderId]/page.tsx"
git commit -m "feat(checkout): add checkout page and Pay action"
```

---

### Task 9: Simulate page and order status page

**Files:**
- Create: `app/[locale]/(account)/checkout/[orderId]/simulate/actions.ts`, `.../simulate/actions.test.ts`
- Create: `app/[locale]/(account)/checkout/[orderId]/simulate/page.tsx`
- Create: `components/commerce/status-auto-refresh.tsx`, `components/commerce/status-auto-refresh.test.tsx`
- Create: `app/[locale]/(account)/checkout/[orderId]/status/page.tsx`

**Interfaces:**
- Consumes: `handleSimulatorWebhook` (Task 5); `isSimulatorCheckoutEnabled`, `isSimulatedOutcome`, `buildSimulatedEvents`, `buildSimulatedEventRequest` (Task 4); `getCustomerOrder` (Task 6); `checkoutStatusView` (Task 3); dictionary `checkout.simulate.*` and `checkout.status.*`.
- Produces:
  - `simulatePaymentAction(locale: string, orderId: string, outcome: string): Promise<void>`. It delivers the events in-process, then redirects to the status page.
  - `StatusAutoRefresh({ intervalMs, maxDurationMs }: { intervalMs: number; maxDurationMs: number })`, which calls `router.refresh()` every `intervalMs` until `maxDurationMs` has passed.

- [ ] **Step 1: Write the failing tests**

Create `app/[locale]/(account)/checkout/[orderId]/simulate/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { simulatePaymentAction } from "@/app/[locale]/(account)/checkout/[orderId]/simulate/actions";
import { requireUser } from "@/lib/auth/session";
import { signSimulatedEvent, SIMULATOR_SIGNATURE_HEADER } from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";
import { type CustomerOrderDTO, getCustomerOrder } from "@/lib/data/orders";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers({ "x-request-id": "req-12345678" })) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/config/server-env", () => ({ getServerEnv: vi.fn() }));
vi.mock("@/lib/data/orders", () => ({ getCustomerOrder: vi.fn() }));
vi.mock("@/lib/commerce/simulator-webhook", () => ({ handleSimulatorWebhook: vi.fn() }));

const SECRET = "test-simulator-secret-0123456789abcdef";
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const order: CustomerOrderDTO = {
  id: ORDER_ID,
  bookId: "30000000-0000-4000-8000-000000000001",
  title: "A Book",
  status: "pending",
  paymentStatus: "pending",
  totalMinor: 129000,
  currency: "VND",
  createdAt: "2026-09-15T00:00:00Z",
  hasActiveEntitlement: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireUser).mockResolvedValue({} as Awaited<ReturnType<typeof requireUser>>);
  vi.mocked(getServerEnv).mockReturnValue({ appEnv: "test", paymentProvider: "simulator", simulatorSecret: SECRET } as ReturnType<typeof getServerEnv>);
  vi.mocked(getCustomerOrder).mockResolvedValue(order);
  vi.mocked(handleSimulatorWebhook).mockResolvedValue(new Response("{}", { status: 200 }));
});

describe("simulatePaymentAction", () => {
  it("delivers one signed event priced from the order, then shows the status", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "failed")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);

    expect(handleSimulatorWebhook).toHaveBeenCalledTimes(1);
    const request = vi.mocked(handleSimulatorWebhook).mock.calls[0][0];
    const body = await request.text();
    expect(request.headers.get(SIMULATOR_SIGNATURE_HEADER)).toBe(signSimulatedEvent(body, SECRET));
    expect(request.headers.get("x-request-id")).toBe("req-12345678");
    expect(JSON.parse(body)).toMatchObject({ orderId: ORDER_ID, status: "failed", amountMinor: 129000, currency: "VND" });
  });

  it("delivers the same event twice for Send duplicate", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "duplicate")).rejects.toThrow("NEXT_REDIRECT");
    const bodies = await Promise.all(vi.mocked(handleSimulatorWebhook).mock.calls.map(([request]) => request.text()));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
  });

  it.each([
    ["production", { appEnv: "production", paymentProvider: "disabled", simulatorSecret: null }],
    ["payments disabled", { appEnv: "test", paymentProvider: "disabled", simulatorSecret: null }],
  ])("sends nothing when the simulator is off (%s)", async (_label, value) => {
    vi.mocked(getServerEnv).mockReturnValue(value as ReturnType<typeof getServerEnv>);
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("sends nothing for an unknown outcome or a foreign order", async () => {
    await expect(simulatePaymentAction("en", ORDER_ID, "refunded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    vi.mocked(getCustomerOrder).mockResolvedValue(null);
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow("NEXT_REDIRECT /en/account/orders");
    expect(handleSimulatorWebhook).not.toHaveBeenCalled();
  });

  it("logs a failed delivery with the request ID and still shows the status", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(handleSimulatorWebhook).mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(simulatePaymentAction("en", ORDER_ID, "succeeded")).rejects.toThrow(`NEXT_REDIRECT /en/checkout/${ORDER_ID}/status`);
    expect(error).toHaveBeenCalledWith("Simulated payment delivery failed.", expect.objectContaining({ requestId: "req-12345678", status: 500 }));
  });
});
```

Create `components/commerce/status-auto-refresh.test.tsx`:

```tsx
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StatusAutoRefresh } from "@/components/commerce/status-auto-refresh";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StatusAutoRefresh", () => {
  it("refreshes on an interval and stops after the maximum duration", () => {
    render(<StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />);

    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(28000);
    expect(refresh).toHaveBeenCalledTimes(14);

    vi.advanceTimersByTime(10000);
    expect(refresh).toHaveBeenCalledTimes(14);
  });

  it("stops when unmounted", () => {
    const { unmount } = render(<StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />);
    unmount();
    vi.advanceTimersByTime(10000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/[locale]/(account)/checkout/[orderId]/simulate/actions.test.ts" components/commerce`
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Write the simulate action**

Create `app/[locale]/(account)/checkout/[orderId]/simulate/actions.ts`:

```ts
"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import {
  buildSimulatedEventRequest,
  buildSimulatedEvents,
  isSimulatedOutcome,
  isSimulatorCheckoutEnabled,
} from "@/lib/commerce/simulator";
import { handleSimulatorWebhook } from "@/lib/commerce/simulator-webhook";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { defaultLocale, isLocale, withLocale } from "@/lib/i18n/config";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function (see the "use server" note in the checkout actions).

// One simulator button (S3 spec 5.2 step 4). It builds the signed events a provider would send and
// delivers them in-process through the webhook handler (spec 4.7). The status page then reads the
// outcome from the database; this action never sets order state itself.
export async function simulatePaymentAction(locale: string, orderId: string, outcome: string): Promise<void> {
  if (!isLocale(locale)) redirect(withLocale(defaultLocale, "/"));
  const commerce = getCommerceRoutes(locale);
  const ordersPath = getLocaleRoutes(locale).orders;
  await requireUser(locale, commerce.checkoutSimulate(orderId));

  const env = getServerEnv();
  if (!isSimulatorCheckoutEnabled(env) || !env.simulatorSecret || !isSimulatedOutcome(outcome)) redirect(ordersPath);

  const order = await getCustomerOrder(orderId);
  if (!order) redirect(ordersPath);

  const requestId = getRequestId(await headers());
  const events = buildSimulatedEvents(order, outcome, `sim_evt_${crypto.randomUUID()}`, new Date());
  for (const event of events) {
    const response = await handleSimulatorWebhook(buildSimulatedEventRequest(event, env.simulatorSecret, requestId));
    if (!response.ok) {
      console.error("Simulated payment delivery failed.", { requestId, orderId: order.id, status: response.status });
      break;
    }
  }

  redirect(commerce.checkoutStatus(order.id));
}
```

- [ ] **Step 4: Write the auto-refresh component**

Create `components/commerce/status-auto-refresh.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the status page while a payment is processing, then stops (S3 spec 5.2). The page also
// shows a "Check again" link, so a reader is never stuck when refreshing ends.
export function StatusAutoRefresh({ intervalMs, maxDurationMs }: { intervalMs: number; maxDurationMs: number }) {
  const router = useRouter();

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt >= maxDurationMs) {
        window.clearInterval(timer);
        return;
      }
      router.refresh();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [router, intervalMs, maxDurationMs]);

  return null;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run "app/[locale]/(account)/checkout/[orderId]/simulate/actions.test.ts" components/commerce`
Expected: PASS.

- [ ] **Step 6: Write the simulate page**

Create `app/[locale]/(account)/checkout/[orderId]/simulate/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SubmitButton } from "@/components/auth/submit-button";
import { SiteHeader } from "@/components/site-header";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { isSimulatorCheckoutEnabled } from "@/lib/commerce/simulator";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCommerceRoutes } from "@/lib/i18n/routes";

import { simulatePaymentAction } from "./actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ locale: string; orderId: string }> };

// The stand-in for a hosted provider page. It is 404 outside local, test, and staging, and for any
// order the viewer does not own or that is no longer pending.
export default async function SimulatePaymentPage({ params }: Props) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  await requireUser(locale, getCommerceRoutes(locale).checkoutSimulate(orderId));
  if (!isSimulatorCheckoutEnabled(getServerEnv())) notFound();

  const order = await getCustomerOrder(orderId);
  if (!order || order.status !== "pending") notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.checkout.simulate;
  const buttons = [
    { outcome: "succeeded", label: copy.succeed, variant: "default" },
    { outcome: "failed", label: copy.fail, variant: "outline" },
    { outcome: "cancelled", label: copy.cancel, variant: "outline" },
    { outcome: "duplicate", label: copy.duplicate, variant: "outline" },
  ] as const;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{copy.title}</h1>
        <p className="mb-8 text-[0.9375rem] text-ink-soft">{copy.description}</p>
        <p className="border-y border-hairline py-4">
          <span className="font-serif text-xl">{order.title}</span>
          <span className="ml-3 font-medium">{formatPrice(order.totalMinor, order.currency, locale)}</span>
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {buttons.map((button) => (
            <form action={simulatePaymentAction.bind(null, locale, order.id, button.outcome)} key={button.outcome}>
              <SubmitButton pendingLabel={copy.sending} variant={button.variant}>
                {button.label}
              </SubmitButton>
            </form>
          ))}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 7: Write the status page**

Create `app/[locale]/(account)/checkout/[orderId]/status/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { StatusAutoRefresh } from "@/components/commerce/status-auto-refresh";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { checkoutStatusView } from "@/lib/commerce/checkout-view";
import { getBookCards } from "@/lib/data/catalog";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalogRoutes, getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ locale: string; orderId: string }> };

// Order status after a payment attempt (S3 spec 5.2 step 5). Everything shown comes from the database.
export default async function CheckoutStatusPage({ params }: Props) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.checkoutStatus(orderId));

  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const [dictionary, cards] = await Promise.all([getDictionary(locale), getBookCards(locale)]);
  const copy = dictionary.checkout.status;
  const catalog = getCatalogRoutes(locale);
  const routes = getLocaleRoutes(locale);
  const card = cards.find((candidate) => candidate.bookId === order.bookId);
  const view = checkoutStatusView(order);
  const content = {
    success: { title: copy.successTitle, body: copy.successBody },
    failed: { title: copy.failedTitle, body: copy.failedBody },
    processing: { title: copy.processingTitle, body: copy.processingBody },
    cancelled: { title: copy.cancelledTitle, body: copy.cancelledBody },
  }[view];

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader locale={locale} />
      <main className="mx-auto max-w-[40rem] px-4 py-12 sm:px-8 lg:py-16" id="main-content">
        <p className="mb-2 text-xs font-medium tracking-[0.1em] text-sage-text uppercase">{copy.eyebrow}</p>
        <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{content.title}</h1>
        <p className="text-[0.9375rem] text-ink-soft" role={view === "processing" ? "status" : undefined}>
          {content.body}
        </p>
        <p className="mt-6 border-y border-hairline py-4 font-serif text-xl">{order.title}</p>

        <div className="mt-8 flex flex-wrap gap-4">
          {view === "success" && order.hasActiveEntitlement ? (
            <Button render={<Link href={catalog.read(order.bookId)} />} size="lg">
              {dictionary.checkout.readNow}
            </Button>
          ) : null}
          {view === "success" ? (
            <Button render={<Link href={routes.library} />} size="lg" variant="outline">
              {copy.library}
            </Button>
          ) : null}
          {view === "failed" ? (
            <Button render={<Link href={commerce.checkout(order.id)} />} size="lg">
              {copy.tryAgain}
            </Button>
          ) : null}
          {view === "processing" ? (
            <>
              <StatusAutoRefresh intervalMs={2000} maxDurationMs={30000} />
              <Button render={<Link href={commerce.checkoutStatus(order.id)} />} size="lg" variant="outline">
                {copy.checkAgain}
              </Button>
            </>
          ) : null}
          {view === "cancelled" ? (
            <Button render={<Link href={card ? catalog.book(card.slug) : routes.books} />} size="lg" variant="outline">
              {copy.backToBook}
            </Button>
          ) : null}
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add "app/[locale]/(account)/checkout/[orderId]/simulate" "app/[locale]/(account)/checkout/[orderId]/status" components/commerce
git commit -m "feat(checkout): add simulator and order status pages"
```

---

### Task 10: Account orders

**Files:**
- Create: `components/account/account-nav-items.ts`, `components/account/account-nav-items.test.ts`
- Create: `app/[locale]/(account)/account/orders/page.tsx`
- Create: `app/[locale]/(account)/account/orders/[orderId]/page.tsx`
- Modify: `app/[locale]/(account)/account/page.tsx`, `app/[locale]/(account)/library/page.tsx`

**Interfaces:**
- Consumes: `listCustomerOrders`, `getCustomerOrder` (Task 6); `customerOrderStatus` (Task 3); `formatDate`, `fillTemplate`; `formatPrice`; `arePaymentsEnabled`; dictionary `orders.*`.
- Produces: `accountNavItems(locale: Locale, dictionary: Pick<Dictionary, "library" | "navigation" | "orders">, current: "library" | "orders" | "account"): { href: string; label: string; current: boolean }[]`

- [ ] **Step 1: Write the failing test**

Create `components/account/account-nav-items.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { accountNavItems } from "@/components/account/account-nav-items";
import en from "@/lib/i18n/dictionaries/en.json";

describe("accountNavItems", () => {
  it("lists library, orders, and account with the current page marked", () => {
    expect(accountNavItems("en", en, "orders")).toEqual([
      { href: "/en/library", label: en.library.shelfTitle, current: false },
      { href: "/en/account/orders", label: "Orders", current: true },
      { href: "/en/account", label: en.navigation.account, current: false },
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/account/account-nav-items.test.ts`
Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the nav items and use them**

Create `components/account/account-nav-items.ts`:

```ts
import type { Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionary";
import { getLocaleRoutes } from "@/lib/i18n/routes";

export type AccountSection = "library" | "orders" | "account";

// One list for every personal-area page, so adding a page updates every sidebar.
export function accountNavItems(
  locale: Locale,
  dictionary: Pick<Dictionary, "library" | "navigation" | "orders">,
  current: AccountSection,
) {
  const routes = getLocaleRoutes(locale);
  return [
    { href: routes.library, label: dictionary.library.shelfTitle, current: current === "library" },
    { href: routes.orders, label: dictionary.orders.navLabel, current: current === "orders" },
    { href: routes.account, label: dictionary.navigation.account, current: current === "account" },
  ];
}
```

In `app/[locale]/(account)/library/page.tsx`, add `import { accountNavItems } from "@/components/account/account-nav-items";` and replace the `items={[ ... ]}` array passed to `AccountNav` with `items={accountNavItems(locale, dictionary, "library")}`. In `app/[locale]/(account)/account/page.tsx`, do the same with `"account"`. Remove any `routes` variable or import left unused (run `npm run lint` to confirm).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/account`
Expected: PASS.

- [ ] **Step 5: Write the orders list page**

Create `app/[locale]/(account)/account/orders/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { customerOrderStatus } from "@/lib/commerce/checkout-view";
import { listCustomerOrders } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate, formatDate } from "@/lib/i18n/format";
import { getCommerceRoutes, getLocaleRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function OrdersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const routes = getLocaleRoutes(locale);
  await requireUser(locale, routes.orders);

  const [dictionary, orders] = await Promise.all([getDictionary(locale), listCustomerOrders()]);
  const copy = dictionary.orders;
  const commerce = getCommerceRoutes(locale);

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="account" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "orders")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[48rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.eyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em] sm:text-[2.5rem]">{copy.title}</h1>
          <p className="mb-10 text-[0.9375rem] text-ink-soft">{copy.description}</p>

          {orders.length === 0 ? (
            <div className="space-y-4 border-y border-sand py-8">
              <h2 className="font-serif text-2xl font-normal">{copy.emptyTitle}</h2>
              <p className="text-[0.9375rem] text-ink-soft">{copy.emptyBody}</p>
              <Button render={<Link href={routes.books} />} variant="outline">
                {copy.browse}
              </Button>
            </div>
          ) : (
            <ul aria-label={copy.listLabel} className="border-t border-ink">
              {orders.map((order) => (
                <li className="grid gap-2 border-b border-sand py-4 sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6" key={order.id}>
                  <div className="min-w-0">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink"
                      href={commerce.order(order.id)}
                    >
                      {order.title}
                    </Link>
                    <p className="text-sm text-sage-text">{fillTemplate(copy.placedOn, { date: formatDate(order.createdAt, locale) })}</p>
                  </div>
                  <div className="text-sm sm:text-right">
                    <p className="font-medium">{order.totalMinor === 0 ? copy.free : formatPrice(order.totalMinor, order.currency, locale)}</p>
                    <p className="text-sage-text">{copy.statuses[customerOrderStatus(order)]}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the order detail page**

Create `app/[locale]/(account)/account/orders/[orderId]/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountNav } from "@/components/account/account-nav";
import { accountNavItems } from "@/components/account/account-nav-items";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/session";
import { formatPrice } from "@/lib/catalog/price";
import { customerOrderStatus } from "@/lib/commerce/checkout-view";
import { arePaymentsEnabled } from "@/lib/commerce/payment-provider";
import { getServerEnv } from "@/lib/config/server-env";
import { getCustomerOrder } from "@/lib/data/orders";
import { isLocale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { fillTemplate, formatDate } from "@/lib/i18n/format";
import { getCatalogRoutes, getCommerceRoutes } from "@/lib/i18n/routes";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = { params: Promise<{ locale: string; orderId: string }> };

export default async function OrderPage({ params }: Props) {
  const { locale, orderId } = await params;
  if (!isLocale(locale)) notFound();
  const commerce = getCommerceRoutes(locale);
  await requireUser(locale, commerce.order(orderId));

  // Another reader's order is indistinguishable from a missing one.
  const order = await getCustomerOrder(orderId);
  if (!order) notFound();

  const dictionary = await getDictionary(locale);
  const copy = dictionary.orders;
  const canContinue = order.status === "pending" && arePaymentsEnabled(getServerEnv());
  const canRead = order.status === "completed" && order.hasActiveEntitlement;

  return (
    <div className="min-h-screen bg-ivory">
      <SiteHeader current="account" locale={locale} />
      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[12.5rem_1fr] lg:gap-16 lg:px-16 lg:py-12">
        <AccountNav items={accountNavItems(locale, dictionary, "orders")} label={dictionary.navigation.library} />
        <main className="min-w-0 max-w-[40rem]" id="main-content">
          <p className="mb-1.5 text-[0.8125rem] text-sage-text">{copy.detailEyebrow}</p>
          <h1 className="mb-3 font-serif text-4xl leading-[1.1] font-normal tracking-[-0.015em]">{order.title}</h1>
          <p className="text-sm text-sage-text">{dictionary.catalog.book.format}</p>
          <p className="mb-8 text-sm text-sage-text">{fillTemplate(copy.placedOn, { date: formatDate(order.createdAt, locale) })}</p>

          <dl className="space-y-3 border-y border-sand py-4 text-[0.9375rem]">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">{copy.total}</dt>
              <dd className="font-medium">{order.totalMinor === 0 ? copy.free : formatPrice(order.totalMinor, order.currency, locale)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">{copy.status}</dt>
              <dd>{copy.statuses[customerOrderStatus(order)]}</dd>
            </div>
          </dl>

          <div className="mt-8 flex flex-wrap gap-4">
            {canContinue ? (
              <Button render={<Link href={commerce.checkout(order.id)} />} size="lg">
                {copy.continueCheckout}
              </Button>
            ) : null}
            {canRead ? (
              <Button render={<Link href={getCatalogRoutes(locale).read(order.bookId)} />} size="lg">
                {copy.read}
              </Button>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add components/account "app/[locale]/(account)/account" "app/[locale]/(account)/library/page.tsx"
git commit -m "feat(account): add reader order pages"
```

---

### Task 11: Admin orders and Revoke access

**Files:**
- Create: `lib/data/admin-orders.ts`, `lib/data/admin-orders.test.ts`
- Modify: `lib/access/grant.ts`, `lib/access/grant.test.ts`
- Create: `app/admin/orders/page.tsx`
- Create: `app/admin/orders/[orderId]/page.tsx`, `app/admin/orders/[orderId]/actions.ts`, `app/admin/orders/[orderId]/actions.test.ts`
- Create: `components/admin/order-revoke-form.tsx`
- Modify: `components/admin/admin-nav.tsx`

**Interfaces:**
- Consumes: `revoke_order_entitlement` (Task 2); `normalizeEmailQuery` from `lib/data/users.ts`; `MissingRevokeReasonError`; `formatDate` and `formatPrice`; `fakeSupabaseClient`.
- Produces:
  - `revokeOrderEntitlement(orderId: string, reason: string): Promise<{ entitlementId: string }>` and `OrderEntitlementNotFoundError`, both in `lib/access/grant.ts`
  - `searchAdminOrders(query: string | undefined): Promise<AdminOrderListItemDTO[]>`
  - `getAdminOrder(orderId: string): Promise<AdminOrderDTO>` (calls `notFound()` for a bad or missing ID)
  - `revokeOrderAccessAction(orderId: string, previous: RevokeOrderAccessState, formData: FormData): Promise<RevokeOrderAccessState>`, where `RevokeOrderAccessState = { status: "idle" } | { status: "done" } | { status: "error"; message: string }`

- [ ] **Step 1: Write the failing tests**

In `lib/access/grant.test.ts`, add `OrderEntitlementNotFoundError` and `revokeOrderEntitlement` to the import from `@/lib/access/grant`, and add:

```ts
describe("revokeOrderEntitlement", () => {
  const orderId = "70000000-0000-0000-0000-000000000001";

  it("gates on requireAdmin before creating a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("calls revoke_order_entitlement with the session client", async () => {
    const client = rpcClient({ data: entitlementId, error: null });
    vi.mocked(createClient).mockResolvedValue(client);
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).resolves.toEqual({ entitlementId });
    expect(client.rpc).toHaveBeenCalledWith("revoke_order_entitlement", { p_order_id: orderId, p_reason: "Chargeback" });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", MissingRevokeReasonError],
    ["P0002", OrderEntitlementNotFoundError],
  ] as const)("maps %s to a typed error", async (code, ErrorClass) => {
    vi.mocked(createClient).mockResolvedValue(rpcClient({ data: null, error: { code, message: "x" } }));
    await expect(revokeOrderEntitlement(orderId, "Chargeback")).rejects.toThrow(ErrorClass);
  });
});
```

Create `lib/data/admin-orders.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireAdmin } from "@/lib/auth/admin";
import { getAdminOrder, searchAdminOrders } from "@/lib/data/admin-orders";
import { fakeSupabaseClient } from "@/lib/data/supabase-test-client";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

type SessionClient = Awaited<ReturnType<typeof createClient>>;
const ORDER_ID = "70000000-0000-4000-8000-000000000001";
const PROFILE_ID = "10000000-0000-4000-8000-000000000001";

const orderRow = {
  id: ORDER_ID,
  profile_id: PROFILE_ID,
  status: "completed",
  payment_status: "succeeded",
  total_minor: 129000,
  currency: "VND",
  created_at: "2026-09-15T00:00:00Z",
  items: [{ book_id: "b1", title_snapshot: "A Book", unit_price_minor: 129000 }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("searchAdminOrders", () => {
  it("blocks before creating a client", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(searchAdminOrders("an@example.test")).rejects.toThrow("NEXT_FORBIDDEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns no rows when no customer email matches", async () => {
    const fake = fakeSupabaseClient({ tables: { customer_identities: { data: [], error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(searchAdminOrders("nobody@example")).resolves.toEqual([]);
    expect(fake.from).not.toHaveBeenCalledWith("orders");
  });

  it("maps orders with customer emails", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        orders: { data: [orderRow], error: null },
        customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(searchAdminOrders(undefined)).resolves.toEqual([
      {
        id: ORDER_ID,
        profileId: PROFILE_ID,
        email: "an@example.test",
        title: "A Book",
        totalMinor: 129000,
        currency: "VND",
        status: "completed",
        paymentStatus: "succeeded",
        createdAt: "2026-09-15T00:00:00Z",
      },
    ]);
  });
});

describe("getAdminOrder", () => {
  it("returns 404 for a non-UUID without a query", async () => {
    await expect(getAdminOrder("order-1")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing order", async () => {
    const fake = fakeSupabaseClient({ tables: { orders: { data: null, error: null } } });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);
    await expect(getAdminOrder(ORDER_ID)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("assembles payments, events, and the order's entitlement", async () => {
    const fake = fakeSupabaseClient({
      tables: {
        orders: { data: orderRow, error: null },
        payments: {
          data: [{ id: "p1", provider: "simulator", external_payment_id: "sim_pay", status: "succeeded", amount_minor: 129000, currency: "VND", created_at: "2026-09-15T00:00:00Z" }],
          error: null,
        },
        payment_events: {
          data: [{ id: "ev1", provider: "simulator", provider_event_id: "sim_evt_1", received_at: "2026-09-15T00:01:00Z", processed_at: "2026-09-15T00:01:00Z" }],
          error: null,
        },
        entitlements: {
          data: { id: "e1", source_type: "simulated_payment", status: "active", granted_at: "2026-09-15T00:01:00Z", revoked_at: null },
          error: null,
        },
        customer_identities: { data: [{ profile_id: PROFILE_ID, normalized_email: "an@example.test" }], error: null },
      },
    });
    vi.mocked(createClient).mockResolvedValue(fake.client as SessionClient);

    const order = await getAdminOrder(ORDER_ID);
    expect(order).toMatchObject({
      id: ORDER_ID,
      email: "an@example.test",
      item: { bookId: "b1", title: "A Book", unitPriceMinor: 129000 },
      payments: [{ id: "p1", externalPaymentId: "sim_pay", amountMinor: 129000 }],
      events: [{ id: "ev1", providerEventId: "sim_evt_1" }],
      entitlement: { id: "e1", sourceType: "simulated_payment", status: "active" },
    });
  });
});
```

Create `app/admin/orders/[orderId]/actions.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { revokeOrderAccessAction } from "@/app/admin/orders/[orderId]/actions";
import { OrderEntitlementNotFoundError, revokeOrderEntitlement } from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/auth/admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/access/grant", () => {
  class OrderEntitlementNotFoundError extends Error {}
  return { revokeOrderEntitlement: vi.fn(), OrderEntitlementNotFoundError };
});

const ORDER_ID = "70000000-0000-4000-8000-000000000001";

function form(reason: string) {
  const data = new FormData();
  data.set("reason", reason);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({} as Awaited<ReturnType<typeof requireAdmin>>);
});

describe("revokeOrderAccessAction", () => {
  it("gates on requireAdmin", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(new Error("NEXT_FORBIDDEN"));
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).rejects.toThrow("NEXT_FORBIDDEN");
    expect(revokeOrderEntitlement).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("   "))).resolves.toEqual({
      status: "error",
      message: "Enter a reason before revoking access.",
    });
    expect(revokeOrderEntitlement).not.toHaveBeenCalled();
  });

  it("revokes with the trimmed reason", async () => {
    vi.mocked(revokeOrderEntitlement).mockResolvedValue({ entitlementId: "e1" });
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form(" Chargeback "))).resolves.toEqual({ status: "done" });
    expect(revokeOrderEntitlement).toHaveBeenCalledWith(ORDER_ID, "Chargeback");
  });

  it("explains when the order granted nothing", async () => {
    vi.mocked(revokeOrderEntitlement).mockRejectedValue(new OrderEntitlementNotFoundError());
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).resolves.toEqual({
      status: "error",
      message: "This order has no access to revoke.",
    });
  });

  it("hides unexpected errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(revokeOrderEntitlement).mockRejectedValue(new Error("secret detail"));
    await expect(revokeOrderAccessAction(ORDER_ID, { status: "idle" }, form("Chargeback"))).resolves.toEqual({
      status: "error",
      message: "Something went wrong. Try again.",
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run lib/access/grant.test.ts lib/data/admin-orders.test.ts app/admin/orders`
Expected: FAIL because the functions and modules are missing.

- [ ] **Step 3: Add the revoke wrapper**

In `lib/access/grant.ts`, add after `RevocableEntitlementNotFoundError`:

```ts
export class OrderEntitlementNotFoundError extends Error {
  constructor() {
    super("That order granted no access.");
    this.name = "OrderEntitlementNotFoundError";
  }
}
```

and add after `revokeComplimentaryEntitlement`:

```ts
// Revokes the access one order granted (S3 spec 4.4). The RPC only finds the entitlement whose
// source_order_id is this order, so grants and other orders stay untouched, and it writes the audit
// row in the same transaction.
export async function revokeOrderEntitlement(orderId: string, reason: string): Promise<{ entitlementId: string }> {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("revoke_order_entitlement", { p_order_id: orderId, p_reason: reason });

  if (error) {
    if (error.code === "22023") throw new MissingRevokeReasonError();
    if (error.code === "P0002") throw new OrderEntitlementNotFoundError();
    throw new Error(`revokeOrderEntitlement: revoke_order_entitlement failed: ${error.message}`);
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("revokeOrderEntitlement: revoke_order_entitlement returned no entitlement id");
  }

  return { entitlementId: data };
}
```

- [ ] **Step 4: Write the admin data layer**

Create `lib/data/admin-orders.ts`:

```ts
import "server-only";

import { notFound } from "next/navigation";

import { requireAdmin } from "@/lib/auth/admin";
import type { OrderStatus, PaymentStatus } from "@/lib/commerce/order-state";
import { normalizeEmailQuery } from "@/lib/data/users";
import { createClient } from "@/lib/supabase/server";

export type AdminOrderListItemDTO = {
  id: string;
  profileId: string;
  email: string | null;
  title: string;
  totalMinor: number;
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  createdAt: string;
};

export type AdminOrderDTO = Omit<AdminOrderListItemDTO, "title"> & {
  item: { bookId: string; title: string; unitPriceMinor: number } | null;
  payments: {
    id: string;
    provider: string;
    externalPaymentId: string | null;
    status: PaymentStatus;
    amountMinor: number;
    currency: string;
    createdAt: string;
  }[];
  events: { id: string; provider: string; providerEventId: string; receivedAt: string; processedAt: string | null }[];
  entitlement: {
    id: string;
    sourceType: "free_order" | "simulated_payment" | "admin_grant";
    status: "active" | "revoked";
    grantedAt: string;
    revokedAt: string | null;
  } | null;
};

type OrderRow = {
  id: string;
  profile_id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  total_minor: number;
  currency: string;
  created_at: string;
  items: { book_id?: string; title_snapshot: string; unit_price_minor?: number }[];
};

const LIMIT = 50;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type SessionClient = Awaited<ReturnType<typeof createClient>>;

async function emailsFor(supabase: SessionClient, profileIds: string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("customer_identities")
    .select("profile_id, normalized_email")
    .in("profile_id", profileIds);
  if (error) throw new Error("Unable to load order customers.");
  return new Map(
    ((data ?? []) as { profile_id: string | null; normalized_email: string }[]).flatMap((row) =>
      row.profile_id ? [[row.profile_id, row.normalized_email] as const] : [],
    ),
  );
}

// Reads go through the session client under the admin read policies (orders, order_items, payments,
// payment_events, entitlements, customer_identities).
export async function searchAdminOrders(rawQuery: string | undefined): Promise<AdminOrderListItemDTO[]> {
  await requireAdmin();
  const query = rawQuery?.trim() ?? "";
  const supabase = await createClient();

  let profileIds: string[] | null = null;
  if (!uuidPattern.test(query) && query.length >= 3) {
    const { data, error } = await supabase
      .from("customer_identities")
      .select("profile_id")
      .ilike("normalized_email", `%${normalizeEmailQuery(query)}%`)
      .limit(LIMIT);
    if (error) throw new Error("Unable to search orders.");
    profileIds = ((data ?? []) as { profile_id: string | null }[]).flatMap((row) => (row.profile_id ? [row.profile_id] : []));
    if (profileIds.length === 0) return [];
  }

  const base = supabase
    .from("orders")
    .select("id, profile_id, status, payment_status, total_minor, currency, created_at, items:order_items ( title_snapshot )");
  const filtered = uuidPattern.test(query) ? base.eq("id", query) : profileIds ? base.in("profile_id", profileIds) : base;
  const { data, error } = await filtered.order("created_at", { ascending: false }).limit(LIMIT);
  if (error) throw new Error("Unable to search orders.");

  const rows = (data ?? []) as unknown as OrderRow[];
  const emails = await emailsFor(supabase, [...new Set(rows.map((row) => row.profile_id))]);
  return rows.map((row) => ({
    id: row.id,
    profileId: row.profile_id,
    email: emails.get(row.profile_id) ?? null,
    title: row.items[0]?.title_snapshot ?? "",
    totalMinor: Number(row.total_minor),
    currency: row.currency,
    status: row.status,
    paymentStatus: row.payment_status,
    createdAt: row.created_at,
  }));
}

type PaymentRow = { id: string; provider: string; external_payment_id: string | null; status: PaymentStatus; amount_minor: number; currency: string; created_at: string };
type EventRow = { id: string; provider: string; provider_event_id: string; received_at: string; processed_at: string | null };
type EntitlementRow = { id: string; source_type: "free_order" | "simulated_payment" | "admin_grant"; status: "active" | "revoked"; granted_at: string; revoked_at: string | null };

export async function getAdminOrder(orderId: string): Promise<AdminOrderDTO> {
  await requireAdmin();
  if (!uuidPattern.test(orderId)) notFound();

  const supabase = await createClient();
  const [order, payments, entitlement] = await Promise.all([
    supabase
      .from("orders")
      .select("id, profile_id, status, payment_status, total_minor, currency, created_at, items:order_items ( book_id, title_snapshot, unit_price_minor )")
      .eq("id", orderId)
      .maybeSingle(),
    supabase
      .from("payments")
      .select("id, provider, external_payment_id, status, amount_minor, currency, created_at")
      .eq("order_id", orderId)
      .order("created_at"),
    supabase
      .from("entitlements")
      .select("id, source_type, status, granted_at, revoked_at")
      .eq("source_order_id", orderId)
      .order("granted_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  for (const result of [order, payments, entitlement]) {
    if (result.error) throw new Error("Unable to load order.");
  }
  if (!order.data) notFound();

  const orderRow = order.data as unknown as OrderRow;
  const paymentRows = (payments.data ?? []) as unknown as PaymentRow[];
  const paymentIds = paymentRows.map((payment) => payment.id);

  const [events, emails] = await Promise.all([
    paymentIds.length > 0
      ? supabase
          .from("payment_events")
          .select("id, provider, provider_event_id, received_at, processed_at")
          .in("payment_id", paymentIds)
          .order("received_at")
      : Promise.resolve({ data: [], error: null }),
    emailsFor(supabase, [orderRow.profile_id]),
  ]);
  if (events.error) throw new Error("Unable to load order.");

  const item = orderRow.items[0];
  const entitlementRow = entitlement.data as unknown as EntitlementRow | null;

  return {
    id: orderRow.id,
    profileId: orderRow.profile_id,
    email: emails.get(orderRow.profile_id) ?? null,
    totalMinor: Number(orderRow.total_minor),
    currency: orderRow.currency,
    status: orderRow.status,
    paymentStatus: orderRow.payment_status,
    createdAt: orderRow.created_at,
    item: item?.book_id
      ? { bookId: item.book_id, title: item.title_snapshot, unitPriceMinor: Number(item.unit_price_minor ?? 0) }
      : null,
    payments: paymentRows.map((payment) => ({
      id: payment.id,
      provider: payment.provider,
      externalPaymentId: payment.external_payment_id,
      status: payment.status,
      amountMinor: Number(payment.amount_minor),
      currency: payment.currency,
      createdAt: payment.created_at,
    })),
    events: ((events.data ?? []) as unknown as EventRow[]).map((event) => ({
      id: event.id,
      provider: event.provider,
      providerEventId: event.provider_event_id,
      receivedAt: event.received_at,
      processedAt: event.processed_at,
    })),
    entitlement: entitlementRow
      ? {
          id: entitlementRow.id,
          sourceType: entitlementRow.source_type,
          status: entitlementRow.status,
          grantedAt: entitlementRow.granted_at,
          revokedAt: entitlementRow.revoked_at,
        }
      : null,
  };
}
```

`fakeSupabaseClient` returns one result per table name, so the email lookup and the email search both read the `customer_identities` entry in the tests. That is expected.

- [ ] **Step 5: Write the revoke action and form**

Create `app/admin/orders/[orderId]/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { OrderEntitlementNotFoundError, revokeOrderEntitlement } from "@/lib/access/grant";
import { requireAdmin } from "@/lib/auth/admin";
import { getRequestId } from "@/lib/observability/request-id";

// Every runtime export below is an async function; only type exports are safe beside them.

export type RevokeOrderAccessState = { status: "idle" } | { status: "done" } | { status: "error"; message: string };

export async function revokeOrderAccessAction(
  orderId: string,
  _previous: RevokeOrderAccessState,
  formData: FormData,
): Promise<RevokeOrderAccessState> {
  await requireAdmin({ next: `/admin/orders/${orderId}` });

  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { status: "error", message: "Enter a reason before revoking access." };

  try {
    await revokeOrderEntitlement(orderId, reason);
  } catch (error) {
    if (error instanceof OrderEntitlementNotFoundError) {
      return { status: "error", message: "This order has no access to revoke." };
    }
    console.error("Revoke order access failed.", { orderId, requestId: getRequestId(await headers()), error: String(error) });
    return { status: "error", message: "Something went wrong. Try again." };
  }

  revalidatePath(`/admin/orders/${orderId}`);
  return { status: "done" };
}
```

Create `components/admin/order-revoke-form.tsx`:

```tsx
"use client";

import { useActionState } from "react";

import { revokeOrderAccessAction, type RevokeOrderAccessState } from "@/app/admin/orders/[orderId]/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const initialState: RevokeOrderAccessState = { status: "idle" };

export function OrderRevokeForm({ orderId }: { orderId: string }) {
  const [state, formAction, pending] = useActionState(revokeOrderAccessAction.bind(null, orderId), initialState);

  return (
    <form action={formAction} aria-busy={pending} className="max-w-[32rem] space-y-4">
      <div className="space-y-2">
        <Label htmlFor="revoke-reason">Reason</Label>
        <Textarea
          aria-describedby={state.status === "error" ? "revoke-message" : undefined}
          className="min-h-24"
          id="revoke-reason"
          name="reason"
          required
        />
      </div>
      <Button className="min-h-11" disabled={pending} type="submit" variant="destructive">
        {pending ? "Revoking…" : "Revoke access"}
      </Button>
      {state.status === "error" ? (
        <p className="text-[0.8125rem] text-error" id="revoke-message" role="alert">
          {state.message}
        </p>
      ) : null}
      {state.status === "done" ? (
        <p className="text-[0.8125rem] text-success" role="status">
          Access revoked.
        </p>
      ) : null}
    </form>
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run lib/access/grant.test.ts lib/data/admin-orders.test.ts app/admin/orders`
Expected: PASS.

- [ ] **Step 7: Write the admin pages and nav link**

Create `app/admin/orders/page.tsx`:

```tsx
import Link from "next/link";

import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { searchAdminOrders } from "@/lib/data/admin-orders";
import { formatDate } from "@/lib/i18n/format";

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  await requireAdmin({ next: "/admin/orders" });
  const { q: rawQuery } = await searchParams;
  const q = Array.isArray(rawQuery) ? rawQuery[0] : rawQuery;
  const orders = await searchAdminOrders(q);

  return (
    <div className="min-w-0 max-w-[64rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Commerce" title="Orders">
        Find an order by customer email or order ID. Without a search, the 50 newest orders are shown.
      </AdminPageHeader>
      <form className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end" method="get">
        <div className="min-w-0 flex-1 space-y-2">
          <Label htmlFor="order-search">Email or order ID</Label>
          <Input className="min-h-11" defaultValue={q ?? ""} id="order-search" name="q" type="search" />
        </div>
        <Button className="min-h-11" type="submit" variant="outline">
          Search
        </Button>
      </form>
      {orders.length === 0 ? (
        <p className="text-sage-text">No orders match this search.</p>
      ) : (
        <div aria-label="Orders" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-forest" role="region" tabIndex={0}>
          <table className="w-full min-w-[48rem] text-left text-sm">
            <caption className="sr-only">Orders</caption>
            <thead>
              <tr className="border-b border-sand text-sage-text">
                <th className="py-2 pr-3 font-medium" scope="col">Book</th>
                <th className="py-2 pr-3 font-medium" scope="col">Customer</th>
                <th className="py-2 pr-3 font-medium" scope="col">Placed</th>
                <th className="py-2 pr-3 font-medium" scope="col">Total</th>
                <th className="py-2 pr-3 font-medium" scope="col">Order</th>
                <th className="py-2 font-medium" scope="col">Payment</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr className="border-b border-sand" key={order.id}>
                  <th className="py-2 pr-3 font-normal" scope="row">
                    <Link
                      className="inline-flex min-h-11 items-center font-medium text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest"
                      href={`/admin/orders/${order.id}`}
                    >
                      {order.title || order.id}
                    </Link>
                  </th>
                  <td className="py-2 pr-3">{order.email ?? "—"}</td>
                  <td className="py-2 pr-3">{formatDate(order.createdAt, "en", { withTime: true })}</td>
                  <td className="py-2 pr-3">{formatPrice(order.totalMinor, order.currency, "en")}</td>
                  <td className="py-2 pr-3">{order.status}</td>
                  <td className="py-2">{order.paymentStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

Create `app/admin/orders/[orderId]/page.tsx`:

```tsx
import Link from "next/link";

import { AdminPageHeader, AdminSection } from "@/components/admin/admin-page-header";
import { OrderRevokeForm } from "@/components/admin/order-revoke-form";
import { requireAdmin } from "@/lib/auth/admin";
import { formatPrice } from "@/lib/catalog/price";
import { getAdminOrder } from "@/lib/data/admin-orders";
import { formatDate } from "@/lib/i18n/format";

const textLink =
  "inline-flex min-h-11 items-center text-forest underline decoration-sand underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-forest";

export default async function AdminOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  await requireAdmin({ next: `/admin/orders/${orderId}` });
  const order = await getAdminOrder(orderId);
  const when = (iso: string) => formatDate(iso, "en", { withTime: true });

  return (
    <div className="min-w-0 max-w-[56rem] [overflow-wrap:anywhere]">
      <AdminPageHeader eyebrow="Order" title={order.item?.title || order.id}>
        <p>
          {order.id} &middot; {order.status} &middot; payment {order.paymentStatus} &middot;{" "}
          {formatPrice(order.totalMinor, order.currency, "en")} &middot; placed {when(order.createdAt)}
        </p>
      </AdminPageHeader>
      <div className="space-y-10">
        <AdminSection title="Customer">
          <p>
            {order.email ?? "No email"} &middot;{" "}
            <Link className={textLink} href={`/admin/users/${order.profileId}`}>
              View user
            </Link>
          </p>
        </AdminSection>

        <AdminSection title="Item">
          {order.item ? (
            <p>
              <Link className={textLink} href={`/admin/books/${order.item.bookId}`}>
                {order.item.title || order.item.bookId}
              </Link>{" "}
              &middot; {formatPrice(order.item.unitPriceMinor, order.currency, "en")}
            </p>
          ) : (
            <p className="text-sage-text">No item.</p>
          )}
        </AdminSection>

        <AdminSection title="Payments">
          {order.payments.length === 0 ? (
            <p className="text-sage-text">No payments.</p>
          ) : (
            <ul className="border-t border-sand text-sm">
              {order.payments.map((payment) => (
                <li className="border-b border-sand py-3" key={payment.id}>
                  {payment.provider} &middot; {payment.status} &middot; {formatPrice(payment.amountMinor, payment.currency, "en")} &middot;{" "}
                  {payment.externalPaymentId ?? "no external ID"} &middot; created {when(payment.createdAt)}
                </li>
              ))}
            </ul>
          )}
        </AdminSection>

        <AdminSection title="Events">
          {order.events.length === 0 ? (
            <p className="text-sage-text">No payment events.</p>
          ) : (
            <ol className="border-t border-sand text-sm">
              {order.events.map((event) => (
                <li className="border-b border-sand py-3" key={event.id}>
                  {event.providerEventId} &middot; received {when(event.receivedAt)}
                  {event.processedAt ? ` · processed ${when(event.processedAt)}` : " · not processed"}
                </li>
              ))}
            </ol>
          )}
        </AdminSection>

        <AdminSection title="Access">
          {!order.entitlement ? (
            <p className="text-sage-text">This order granted no access.</p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm">
                {order.entitlement.sourceType} &middot; {order.entitlement.status} &middot; granted {when(order.entitlement.grantedAt)}
              </p>
              {order.entitlement.status === "active" ? (
                <OrderRevokeForm orderId={order.id} />
              ) : (
                <p>Access from this order was revoked on {when(order.entitlement.revokedAt ?? order.entitlement.grantedAt)}.</p>
              )}
            </div>
          )}
        </AdminSection>
      </div>
    </div>
  );
}
```

In `components/admin/admin-nav.tsx`, add `{ href: "/admin/orders", label: "Orders" },` after the Users link.

- [ ] **Step 8: Run the checks and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/access/grant.ts lib/access/grant.test.ts lib/data/admin-orders.ts lib/data/admin-orders.test.ts app/admin/orders components/admin/order-revoke-form.tsx components/admin/admin-nav.tsx
git commit -m "feat(admin): add orders and order access revocation"
```

---

### Task 12: Checkout E2E, runbooks, and the S3 gate

**Files:**
- Create: `e2e/support/commerce.ts`, `e2e/checkout.spec.ts`
- Modify: `e2e/public-discovery.spec.ts`
- Create: `docs/runbooks/checkout.md`
- Modify: `docs/runbooks/storefront.md`, `docs/runbooks/deployment.md`, `docs/runbooks/testing-environments.md`

**Interfaces:**
- Consumes: `seedCatalogBook` (`e2e/support/catalog.ts`), `createServiceRoleClient` (loopback only), `readLatestLink`, and every S3 page.
- Produces:
  - `enablePayments(): Promise<void>`
  - `createReader(prefix: string, options?: { admin?: boolean }): Promise<{ email: string; profileId: string }>`
  - `signInAs(page: Page, email: string, next: string): Promise<void>`
  - `profileIdForEmail(email: string): Promise<string>`
  - `activeEntitlementCount(profileId: string, bookId: string): Promise<number>`
  - `orderCountForBook(profileId: string, bookId: string): Promise<number>`

- [ ] **Step 1: Write the E2E support helpers**

Create `e2e/support/commerce.ts`:

```ts
import { type Page, expect } from "@playwright/test";

import { createServiceRoleClient } from "./supabase";

// S3 fixtures. Service role only, and createServiceRoleClient refuses any non-loopback Supabase URL,
// so none of this can touch the shared cloud project.

function check<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The database half of the payments gate (S3 spec 4.2). The app half is PAYMENT_PROVIDER=simulator
// from playwright.config.ts.
export async function enablePayments(): Promise<void> {
  check(await createServiceRoleClient().from("commerce_settings").update({ payments_enabled: true }).eq("id", true));
}

export async function createReader(prefix: string, options: { admin?: boolean } = {}): Promise<{ email: string; profileId: string }> {
  const service = createServiceRoleClient();
  const email = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  const profile = check(await service.from("profiles").select("id").eq("auth_user_id", data.user.id).single());
  if (options.admin) {
    check(await service.from("user_roles").insert({ profile_id: profile.id, role: "admin" }));
  }
  return { email, profileId: profile.id as string };
}

// A magic-link session without the email round trip. The UI sign-in flow is covered by the main buy
// journey and by magic-link.spec.ts.
export async function signInAs(page: Page, email: string, next: string): Promise<void> {
  const { data, error } = await createServiceRoleClient().auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const locale = next.startsWith("/vi") ? "vi" : "en";
  await page.goto(`/auth/callback?${new URLSearchParams({ token_hash: data.properties.hashed_token, type: "email", next, locale })}`);
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(next)}$`));
}

export async function profileIdForEmail(email: string): Promise<string> {
  const row = check(
    await createServiceRoleClient().from("customer_identities").select("profile_id").eq("normalized_email", email.toLowerCase()).single(),
  );
  return row.profile_id as string;
}

export async function activeEntitlementCount(profileId: string, bookId: string): Promise<number> {
  const { count, error } = await createServiceRoleClient()
    .from("entitlements")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileId)
    .eq("book_id", bookId)
    .eq("status", "active");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function orderCountForBook(profileId: string, bookId: string): Promise<number> {
  const { count, error } = await createServiceRoleClient()
    .from("order_items")
    .select("order_id, orders!inner(profile_id)", { count: "exact", head: true })
    .eq("book_id", bookId)
    .eq("orders.profile_id", profileId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
```

- [ ] **Step 2: Write the E2E journeys**

Create `e2e/checkout.spec.ts`:

```ts
import { type Page, expect, test } from "@playwright/test";

import { seedCatalogBook } from "./support/catalog";
import {
  activeEntitlementCount,
  createReader,
  enablePayments,
  orderCountForBook,
  profileIdForEmail,
  signInAs,
} from "./support/commerce";
import { readLatestLink } from "./support/mailpit";

// S3 acceptance. Removing the Buy action, the signed simulator delivery, the status page, owner-only
// order reads, or order revocation must fail here.
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const checkoutUrl = /\/en\/checkout\/([0-9a-f-]{36})$/;

test.beforeAll(async () => {
  await enablePayments();
});

async function buyAndPay(page: Page, outcome: "Succeed" | "Fail"): Promise<string> {
  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  await page.getByRole("button", { name: outcome, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/status$`));
  return orderId;
}

test("a reader buys a paid ebook on the simulator and opens it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const title = `Paid Harbour ${suffix}`;
  const slug = `paid-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 129000 });

  await page.goto(`/en/books/${slug}`);
  await page.getByRole("link", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/sign-in\\?next=%2Fen%2Fbooks%2F${slug}$`));

  const email = `buyer-${suffix}@example.test`;
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send secure sign-in link" }).click();
  await expect(page.getByText("Check your email and follow the secure link to continue.")).toBeVisible();
  await page.goto(await readLatestLink(email));
  await expect(page).toHaveURL(new RegExp(`/en/books/${slug}$`));

  await page.getByRole("button", { name: "Buy ebook" }).click();
  await expect(page).toHaveURL(checkoutUrl);
  const orderId = checkoutUrl.exec(page.url())![1];
  await expect(page.getByRole("heading", { level: 1, name: "Review your order" })).toBeVisible();
  await expect(page.getByText("Ebook (EPUB, read on the web)")).toBeVisible();
  await expect(page.getByText(/129,000/)).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/simulate$`));
  // The redirect to the simulator changed nothing; only the signed event will.
  const profileId = await profileIdForEmail(email);
  expect(await activeEntitlementCount(profileId, bookId)).toBe(0);

  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}/status$`));
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  await page.getByRole("link", { name: "Read now" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/${bookId}$`));
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeAttached();
  expect(await activeEntitlementCount(profileId, bookId)).toBe(1);

  // Another reader cannot see this order.
  const other = await createReader("checkout-other");
  const context = await browser.newContext();
  const otherPage = await context.newPage();
  await signInAs(otherPage, other.email, "/en/account");
  expect((await otherPage.goto(`/en/checkout/${orderId}`))?.status()).toBe(404);
  expect((await otherPage.goto(`/en/checkout/${orderId}/status`))?.status()).toBe(404);
  expect((await otherPage.goto(`/en/account/orders/${orderId}`))?.status()).toBe(404);
  await context.close();
});

test("a failed payment can be retried on the same order", async ({ page }) => {
  test.setTimeout(90_000);
  const suffix = unique();
  const title = `Retry Harbour ${suffix}`;
  const slug = `retry-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 90000 });
  const reader = await createReader("checkout-retry");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  const orderId = await buyAndPay(page, "Fail");
  await expect(page.getByRole("heading", { level: 1, name: "Payment did not go through" })).toBeVisible();

  await page.getByRole("link", { name: "Try again" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/checkout/${orderId}$`));
  await expect(page.getByText("Your last payment did not go through. You can try again.")).toBeVisible();
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page.getByRole("button", { name: "Succeed", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);
  expect(await orderCountForBook(reader.profileId, bookId)).toBe(1);

  await page.goto("/en/account/orders");
  const orders = page.getByRole("list", { name: "Your orders" });
  await expect(orders.getByRole("link", { name: title })).toBeVisible();
  await expect(orders.getByText("Completed")).toBeVisible();
});

test("a reader gets a free ebook and goes straight to the reader", async ({ page }) => {
  const suffix = unique();
  const title = `Free Harbour ${suffix}`;
  const slug = `free-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } } });
  const reader = await createReader("checkout-free");
  await signInAs(page, reader.email, `/en/books/${slug}`);

  await page.getByRole("button", { name: "Get free" }).click();
  await expect(page).toHaveURL(new RegExp(`/en/read/${bookId}$`));
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(1);

  await page.goto(`/en/books/${slug}`);
  await expect(page.getByRole("link", { name: "Read now" })).toBeVisible();
});

test("an admin revokes the access an order granted", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const suffix = unique();
  const title = `Revoked Harbour ${suffix}`;
  const slug = `revoked-harbour-${suffix}`;
  const { bookId } = await seedCatalogBook({ suffix, localizations: { en: { slug, title } }, priceMinor: 50000 });
  const reader = await createReader("checkout-revoke");
  const admin = await createReader("checkout-admin", { admin: true });

  const readerContext = await browser.newContext();
  const readerPage = await readerContext.newPage();
  await signInAs(readerPage, reader.email, `/en/books/${slug}`);
  const orderId = await buyAndPay(readerPage, "Succeed");
  await expect(readerPage.getByRole("heading", { level: 1, name: "Payment complete" })).toBeVisible();

  await signInAs(page, admin.email, "/admin/orders");
  await page.getByLabel("Email or order ID").fill(reader.email);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("link", { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}$`));

  await page.getByLabel("Reason").fill("Chargeback rehearsal");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByText(/Access from this order was revoked on/)).toBeVisible();
  expect(await activeEntitlementCount(reader.profileId, bookId)).toBe(0);

  await readerPage.goto("/en/library");
  await expect(readerPage.getByText(title)).toHaveCount(0);
  await readerContext.close();
});
```

In `e2e/public-discovery.spec.ts`, replace

```ts
  // S3 enables this button.
  await expect(page.getByRole("button", { name: "Get free" })).toBeDisabled();
```

with

```ts
  await expect(page.getByRole("button", { name: "Get free" })).toBeEnabled();
```

- [ ] **Step 3: Run the E2E suite locally**

Start a local stack and export its values as `docs/runbooks/testing-environments.md` describes. Then run:

```bash
npx playwright test e2e/checkout.spec.ts e2e/public-discovery.spec.ts
```

Expected: PASS, 4 tests in `checkout.spec.ts`. If the default ports are taken or a dev server on :3000 points at the cloud project, run the stack from a scratch `--workdir` and the app on a free port, as the runbook describes.

- [ ] **Step 4: Write the checkout runbook**

Create `docs/runbooks/checkout.md`:

````markdown
# Runbook: get and buy

Readers get free ebooks and buy paid ebooks under `/{locale}`. Payments run on a simulator. There is
no real payment provider yet, and production cannot take a paid order.

## Flows

| Step | URL | What happens |
| --- | --- | --- |
| Get free | Book page → **Get free** | `acquire_free_ebook` grants access. The reader opens at `/{locale}/read/<bookId>`. |
| Buy | Book page → **Buy ebook** | `create_ebook_order` creates or reuses a pending order. |
| Checkout | `/{locale}/checkout/<orderId>` | Shows the ebook, the total, the account email, and **Pay**. |
| Simulate | `/{locale}/checkout/<orderId>/simulate` | **Succeed**, **Fail**, **Cancel**, or **Send duplicate**. Local, test, and staging only. |
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

Only `apply_payment_event` changes an order after it is created. It ignores a duplicate event ID and any
event for an order that is already completed or cancelled. A browser redirect never changes an order.

If the price changes while an order is pending, the next **Buy** click cancels that order and creates a
new one at the current price.

## Two payment gates

A paid order needs both of these:

1. The app: `PAYMENT_PROVIDER=simulator`. Production must use `disabled`, and the app refuses to start with
   `simulator` in production.
2. The database: `commerce_settings.payments_enabled = true`. The default is `false`.

The cloud Supabase project is shared with production. **Keep `payments_enabled = false` there.** With it
off, `create_ebook_order` fails with `EB011`, and readers see "Buying ebooks is not available yet."

On a local stack, turn it on with:

```bash
psql "$(supabase status -o env | sed -n 's/^DB_URL=//p' | tr -d '"')" \
  -c "update public.commerce_settings set payments_enabled = true;"
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

Keep the request ID from any error. Server logs include it.
````

- [ ] **Step 5: Update the other runbooks**

In `docs/runbooks/storefront.md`:

- Replace the sentence "Until S3 ships, the Get and Buy buttons stay disabled for signed-in readers." with "Get and Buy are live since S3. See `docs/runbooks/checkout.md`."
- After the "A paid book says Coming soon." entry, add: "Paid checkout also needs `commerce_settings.payments_enabled`. See `docs/runbooks/checkout.md`."

In `docs/runbooks/deployment.md`, add this section before `## Cheatsheet`:

````markdown
## S3 get and buy

- Production giữ `PAYMENT_PROVIDER=disabled`. Không đặt `PAYMENT_SIMULATOR_SECRET` trong production.
- Migration `20260915120000_ebook_orders.sql` tạo `commerce_settings` với `payments_enabled = false`.
  Không bật cờ này trên project cloud, vì project này dùng chung với production.
- Sau `supabase db push`, kiểm tra:

```sql
select payments_enabled from public.commerce_settings;
```

  Kết quả phải là `false`.
- Sách trả phí hiển thị "Coming soon". Sách miễn phí dùng **Get free** bình thường.
- Xem `docs/runbooks/checkout.md` để thu hồi quyền truy cập từ một đơn hàng.
````

In `docs/runbooks/testing-environments.md`, under "Configuration that must be right before anything works", add:

```markdown
- `commerce_settings.payments_enabled` must stay `false` on the cloud project. It is the database half of
  the payments gate, and the cloud database is production's database.
- Local and CI runs with `PAYMENT_PROVIDER=simulator` also need `PAYMENT_SIMULATOR_SECRET` (at least 32
  characters). `playwright.config.ts` supplies a test default; `.env.local` needs its own value.
```

- [ ] **Step 6: Run the S3 gate on a clean local stack**

Run (add `--workdir <scratch>` to the `supabase` commands, and use a free app port, when the defaults are taken):

```bash
npm run db:reset
npm run db:test
supabase gen types --local --lang typescript > lib/supabase/database.types.ts
git diff --exit-code lib/supabase/database.types.ts
npm run check:full
```

Expected:
- `db:test` passes every file, including `018_ebook_orders.sql` (32) and `019_revoke_order_entitlement.sql` (16).
- The types diff is empty.
- `check:full` passes lint, types, unit tests, the build, and the whole Playwright suite.

- [ ] **Step 7: Commit**

```bash
git add e2e/support/commerce.ts e2e/checkout.spec.ts e2e/public-discovery.spec.ts docs/runbooks/checkout.md docs/runbooks/storefront.md docs/runbooks/deployment.md docs/runbooks/testing-environments.md
git commit -m "test(e2e): cover get and buy journeys and document checkout"
```

## S3 Completion Gate

Every item needs evidence in the pull request description:

- [ ] Free and simulated paid acquisition each create exactly one active entitlement, including duplicate and out-of-order events (pgTAP 018 rows 13–19, E2E retry test).
- [ ] A browser redirect never marks an order paid (E2E: zero entitlements after **Pay** and before **Succeed**).
- [ ] Production configuration cannot create a paid order (Vitest `createEbookOrder` app gate, pgTAP 018 row 32 database gate).
- [ ] An unsigned or wrongly signed simulator event changes nothing (Vitest `simulator-webhook.test.ts`).
- [ ] Playwright: book → sign in → buy → simulate success → Read now → reader page opens.
- [ ] Revocation touches only the order's own entitlement (pgTAP 019, E2E admin test).
- [ ] `npm run db:reset`, `npm run db:test`, and `npm run check:full` pass on a clean local stack.

