# S9 Bundles and Gifts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reader buy a curated multi-book bundle for one fixed price or buy a single book/bundle as a gift that the recipient claims from an emailed token.

**Architecture:** First remove the one-order/one-book assumption from payment application, entitlement revocation, order DTOs, and checkout rendering. Build bundles as first-class localized catalog entities whose offers create ordinary multi-line orders, then build gifts as an order-level ownership transfer: payment completes the order without granting the purchaser, a protected outbox delivers a claim token, and one locking RPC grants every order item to the claimant. Database functions remain the authority for prices, ownership, status transitions, token claims, and coupon scope; Server Components and Server Actions only validate input, call those functions, and render their results.

**Tech Stack:** Next.js 16.3 App Router, React 19 Server Components and Server Actions, Supabase/Postgres/Auth/RLS/Storage, TypeScript 6, Zod 4, Vitest 5, pgTAP, Playwright 1.63, Tailwind CSS 4.

**Spec:** `docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md`

## Global Constraints

- Read the relevant guide in `node_modules/next/dist/docs/` before changing Next.js code. For this plan the required guides are `01-app/02-guides/server-actions.md`, `01-app/03-api-reference/03-file-conventions/dynamic-routes.md`, `01-app/03-api-reference/04-functions/generate-metadata.md`, and `01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md`.
- Every protected page and every Server Action calls `requireUser()` or `requireAdmin()` itself. A layout is never the only authorization control.
- Customer routes live under `/{locale}` with locales `vi` and `en`. `/admin` has no locale prefix.
- Never expose `SUPABASE_SERVICE_ROLE_KEY` to browser code. Create a service-role client only after `requireAdmin()` passes, except for the already secret-authenticated operations worker.
- EPUB source files and processed resources remain private. Bundle covers reuse only the public `covers` bucket.
- Applied migrations are never edited. Every database change is a new migration after S8's `20260923160000` migration, with a matching pgTAP file numbered after `039_s8_coupon_claim_locks.sql`.
- Update `lib/supabase/database.types.ts` after every schema/RPC batch. Generate it from the local stack; do not hand-maintain a divergent shape.
- Database functions with elevated access use `security definer`, `set search_path = ''`, fully qualified names, explicit `REVOKE`/`GRANT`, and derive the caller from `auth.uid()`.
- Prices are integer minor units and ISO 4217 currencies. Bundle price is never prorated for partial ownership.
- Raw gift tokens never appear in `gifts`, application logs, audit metadata, URLs returned by Server Actions, or browser state other than the claim URL itself. Only SHA-256 is stored on the gift row.
- Reader-facing copy exists in both `lib/i18n/dictionaries/vi.json` and `lib/i18n/dictionaries/en.json`. Admin copy is English-only.
- Preserve request IDs in server errors and operational logs. Never log recipient email, gift message, raw token, or claim URL.
- Every bundle admin mutation writes exactly one `audit_logs` row. Gift resend/reissue writes exactly one audit row; replayed payment and replayed claim write no duplicate audit rows.
- Run database and Playwright tests only against a local Supabase stack. Follow `docs/runbooks/testing-environments.md`, including the scratch-workdir warning and exporting Supabase/Mailpit variables before Playwright.
- Use Node.js 22. Run `npm run check` after each application task; after migrations run a local reset, `supabase test db`, and type generation. Run `npm run check:full` at the end because gift claim introduces a protected route and sign-in return path.

## Clarifications required by the existing system

1. **The gift token has one protected operational copy while the gift is claimable.** Spec §7.2 says the token goes directly into the outbox payload, while §4 says it exists only in the email and URL. Asynchronous retry and admin resend are impossible if no retrievable token exists. Implement the spec's outbox statement literally: `notification_outbox.payload` may hold the claim path while the gift is unclaimed, is unreadable through the Data API except to admins/service role, is never logged, and is cleared by `claim_gift`. The durable domain row stores only `claim_token_hash`.
2. **Orders need a bundle discriminator.** Add nullable `orders.bundle_id`. Without it, `coupon_bundles` cannot distinguish a bundle order from unrelated book lines after the offer is snapshotted. Single-book orders keep it null; `create_bundle_order` sets it.
3. **Revocation becomes multi-item too.** A claimed bundle gift is handled by `revoke_order_entitlement`, as the spec requires. Therefore that RPC must return `uuid[]` and revoke every active order-backed entitlement, not an arbitrary first row.
4. **Zero-total coupon completion follows the same multi-item/gift rule as payment.** `apply_coupon_to_order` currently grants one book itself. Its 100% branch must grant every missing book for a normal bundle and grant none to a purchaser when the order has a gift; the latter marks the gift `sent` and releases its outbox row.
5. **Reissue updates the one gift row.** `gifts.order_id` is unique, so reissue cannot create a second gift for the order. It atomically replaces recipient email and token hash, resets the protected outbox payload/delivery state, invalidates the old token, and records the old/new address only in the audit metadata as masked values. A claimed gift is refused.

## File structure

| Area | Files and responsibility |
| --- | --- |
| Multi-line core | `supabase/migrations/20260924100000_s9_multi_item_orders.sql`, `supabase/tests/040_s9_multi_item_orders.sql`, `lib/access/grant.ts`, `lib/access/grant.test.ts`: array-returning payment/revocation RPCs and callers. |
| Bundle database | `20260924110000_s9_bundle_schema.sql`, `041_s9_bundle_schema.sql`: bundle tables, offer XOR, media owner, `orders.bundle_id`, public/admin RLS. |
| Bundle rules/admin | `20260924120000_s9_bundle_admin_rpcs.sql`, `042_s9_bundle_admin_rpcs.sql`, `lib/catalog/bundle-readiness.ts`, `lib/catalog/schemas.ts`: readiness, audited mutations, publish gate, redirect flattening. |
| Bundle application | `lib/data/bundles.ts`, `lib/data/bundles.test.ts`, `lib/data/bundle-covers.ts`, admin routes/components: admin DTOs, cover upload, member ordering, offer/editor UI. |
| Bundle commerce/public | `20260924130000_s9_bundle_orders.sql`, `043_s9_bundle_orders.sql`, `lib/commerce/orders.ts`, `lib/catalog/book-action.ts`, `lib/data/public-bundles.ts`, localized public page/actions, SEO and sitemap. |
| Bundle coupons/order views | `20260924140000_s9_bundle_coupons.sql`, `044_s9_bundle_coupons.sql`, coupon admin files, `lib/data/orders.ts`, checkout/account pages: bundle scoping, 100% multi-line completion, multi-item display. |
| Gift schema/tokens | `20260924150000_s9_gift_schema.sql`, `045_s9_gift_schema.sql`, `lib/commerce/gift-token.ts`, `lib/commerce/gift-form.ts`: gifts, protected outbox payload, token and form rules. |
| Gift lifecycle | `20260924160000_s9_gift_lifecycle.sql`, `046_s9_gift_lifecycle.sql`: configure, payment completion, zero-total completion, locking claim RPC, replay and concurrency. |
| Gift email/UI | `lib/email/gift.ts`, `lib/email/outbox.ts`, checkout gift component/action, localized claim page: delivery and recipient journey. |
| Gift admin | `20260924170000_s9_gift_admin_rpcs.sql`, `047_s9_gift_admin_rpcs.sql`, `lib/data/gifts.ts`, `/admin/gifts`: search, resend, reissue. |
| Verification | `e2e/bundles-and-gifts.spec.ts`, support helpers, dictionaries, `docs/runbooks/bundles-and-gifts.md`: two golden paths and operations guide. |

---

### Task 1: Make the payment and revocation core multi-line

**Files:**
- Create: `supabase/migrations/20260924100000_s9_multi_item_orders.sql`
- Create: `supabase/tests/040_s9_multi_item_orders.sql`
- Modify: `supabase/tests/018_ebook_orders.sql`
- Modify: `supabase/tests/019_revoke_order_entitlement.sql`
- Modify: `supabase/tests/029_manual_payment_decisions.sql`
- Modify: `supabase/tests/037_s8_coupon_payment_event.sql`
- Modify: `lib/access/grant.ts`
- Modify: `lib/access/grant.test.ts`
- Modify: `app/admin/orders/[orderId]/actions.test.ts`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `apply_payment_event(...) returns table (entitlement_ids uuid[], order_status public.order_status, payment_status public.payment_status)`.
- `confirm_manual_payment(...)` returns the same three columns and delegates to `apply_payment_event`.
- `revoke_order_entitlement(p_order_id uuid, p_reason text) returns uuid[]`.
- `AppliedPaymentEventOutcome = { entitlementIds: string[]; orderStatus: string; paymentStatus: string }`.
- `revokeOrderEntitlement(...) => Promise<{ entitlementIds: string[] }>`.

- [ ] **Step 1: Add failing pgTAP cases for multiple order items**

  In `040_s9_multi_item_orders.sql`, create a paid order with three different books and assert:

  ```sql
  select results_eq(
    $$ select cardinality(entitlement_ids), order_status::text, payment_status::text
       from public.apply_payment_event('simulator', 's9-multi-success', :'order_id',
         's9-payment', 'succeeded', 300000, 'VND', now()) $$,
    $$ values (3, 'completed', 'succeeded') $$,
    'success returns every current active entitlement for the order books'
  );
  select is((select count(*)::int from public.entitlements where source_order_id = :'order_id'), 3,
    'one entitlement is created per order item');
  select is((select count(*)::int from public.library_items where profile_id = :'buyer_id'
             and book_id = any(:'book_ids'::uuid[])), 3, 'every order book reaches the library');
  ```

  Seed one pre-owned member before a second order succeeds and assert the returned array still has all three current entitlement IDs while only two rows use this order as `source_order_id`. Replay and late events must return the same sorted-by-book array without inserts. Add a three-entitlement revocation case asserting all active rows are revoked, all matching library rows are deleted, and one audit row contains `entitlement_ids`.

- [ ] **Step 2: Run the new database test and verify the old scalar functions fail it**

  Run: `supabase test db supabase/tests/040_s9_multi_item_orders.sql --workdir .superpowers/scratch/sbworkdir`
  Expected: FAIL because `entitlement_ids` and array-returning revocation do not exist.

- [ ] **Step 3: Replace the dependent functions in one forward migration**

  Drop `confirm_manual_payment` before dropping `apply_payment_event`, then recreate both. In every success/replay/out-of-order return path, resolve the array with the same deterministic query:

  ```sql
  select coalesce(array_agg(e.id order by oi.book_id), array[]::uuid[])
  into v_entitlement_ids
  from public.order_items oi
  join public.entitlements e
    on e.profile_id = v_profile_id
   and e.book_id = oi.book_id
   and e.status = 'active'
  where oi.order_id = p_order_id;
  ```

  In the succeeded branch iterate distinct order books, insert entitlement with the existing provider-derived source and `on conflict ... do nothing`, resolve the current active entitlement, and insert the matching `library_items` row. Keep the S8 coupon-redemption update outside the loop. Replace `revoke_order_entitlement` with one set-based update over all active entitlements whose `source_order_id` matches and whose source is order-backed; delete their library rows and write one audit row with the returned UUID array.

- [ ] **Step 4: Update TypeScript callers and tests**

  Change the scalar casts and result mapping in `lib/access/grant.ts`:

  ```ts
  const row = (Array.isArray(data) ? data[0] : data) as
    | { entitlement_ids: string[] | null; order_status: string; payment_status: string }
    | undefined;
  return {
    entitlementIds: row?.entitlement_ids ?? [],
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
  };
  ```

  Update unit fixtures and the admin action mock to use arrays. Do not change webhook response JSON; it intentionally exposes only order/payment status.

- [ ] **Step 5: Update legacy pgTAP expectations and regenerate types**

  Replace `entitlement_id` projections in 018/029/037 with `entitlement_ids`; retain every existing replay, provider, amount, coupon-redemption, and manual-confirmation assertion. Generate types from the reset local stack and verify the two RPC return shapes are `string[]`.

- [ ] **Step 6: Verify and commit**

  Run: local reset, `supabase test db`, `npx vitest run lib/access/grant.test.ts app/admin/orders/[orderId]/actions.test.ts`, then `npm run check`.

  ```bash
  git add supabase/migrations/20260924100000_s9_multi_item_orders.sql supabase/tests/040_s9_multi_item_orders.sql supabase/tests/018_ebook_orders.sql supabase/tests/019_revoke_order_entitlement.sql supabase/tests/029_manual_payment_decisions.sql supabase/tests/037_s8_coupon_payment_event.sql lib/access/grant.ts lib/access/grant.test.ts app/admin/orders/[orderId]/actions.test.ts lib/supabase/database.types.ts
  git commit -m "refactor(commerce): support multi-item order entitlements"
  ```

---

### Task 2: Add the bundle schema and offer invariant

**Files:**
- Create: `supabase/migrations/20260924110000_s9_bundle_schema.sql`
- Create: `supabase/tests/041_s9_bundle_schema.sql`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Tables: `bundles`, `bundle_localizations`, `bundle_books`, `coupon_bundles`.
- Columns: `offers.bundle_id uuid`, `orders.bundle_id uuid`, `order_items.position integer`.
- Media owners: `owner_type in ('book','author','bundle')`; bundle covers use `kind='cover'` and `bundles/{bundleId}/{uuid}.{ext}`.

- [ ] **Step 1: Write the failing schema/RLS pgTAP suite**

  Assert exact columns, primary/foreign/unique constraints, `offers` rejects both targets null and both targets non-null, one bundle cover per bundle, position uniqueness within a bundle, and reader visibility only for published bundles/localizations/members. Include cross-user/non-admin write denials and service-role storage behavior.

- [ ] **Step 2: Run the suite and confirm the relations are missing**

  Run: `supabase test db supabase/tests/041_s9_bundle_schema.sql --workdir .superpowers/scratch/sbworkdir`.

- [ ] **Step 3: Add the migration**

  Use `public.content_status` for `bundles.status`. Define localization constraints for locales `vi|en`, nonblank title, kebab slug, unique `(locale, slug)` and `(bundle_id, locale)`. Define `bundle_books` with primary key `(bundle_id, book_id)`, `position > 0`, and unique `(bundle_id, position)`.

  Convert offers without breaking existing rows:

  ```sql
  alter table public.offers alter column sku_id drop not null;
  alter table public.offers add column bundle_id uuid references public.bundles(id) on delete cascade;
  alter table public.offers add constraint offers_exactly_one_product check (
    (sku_id is not null)::int + (bundle_id is not null)::int = 1
  );
  create unique index offers_bundle_market_currency_key
    on public.offers(bundle_id, market_code, currency) where bundle_id is not null;
  ```

  Add `orders.bundle_id references bundles(id)` with `on delete restrict`. Add `order_items.position integer not null default 1 check (position > 0)` and unique `(order_id, position)`; existing single-item orders backfill as position 1, while bundle creation copies `bundle_books.position`. Add `coupon_bundles(coupon_id,bundle_id)` now so later RPC work has a stable schema. Amend `media_assets` owner check and add a partial one-cover index for bundles. Grant only the same safe media columns already exposed; never expose `storage_key`.

- [ ] **Step 4: Add public read policies**

  Anonymous/authenticated users may read a bundle, localization, and membership only when the bundle status is `published`; member reads do not themselves reveal non-published books because public DTO queries join `books.status='published'`. Admins can select all rows. No browser role directly inserts/updates/deletes bundles, members, bundle offers, or bundle covers.

- [ ] **Step 5: Reset, test, generate types, and commit**

  ```bash
  git add supabase/migrations/20260924110000_s9_bundle_schema.sql supabase/tests/041_s9_bundle_schema.sql lib/supabase/database.types.ts
  git commit -m "feat(catalog): add first-class bundle schema"
  ```

---

### Task 3: Implement bundle readiness and audited admin RPCs

**Files:**
- Create: `lib/catalog/bundle-readiness.ts`
- Create: `lib/catalog/bundle-readiness.test.ts`
- Create: `supabase/migrations/20260924120000_s9_bundle_admin_rpcs.sql`
- Create: `supabase/tests/042_s9_bundle_admin_rpcs.sql`
- Modify: `lib/catalog/schemas.ts`
- Modify: `lib/catalog/schemas.test.ts`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `BundleReadinessIssueCode = 'too_few_published_members' | 'missing_localization' | 'missing_cover' | 'missing_offer' | 'unpublished_member'`.
- `checkBundleReadiness(snapshot): BundleReadinessIssueCode[]`; `unpublished_member` is a warning after publication but blocks initial/re-publication because fewer than two published members is evaluated separately.
- RPCs: `admin_create_bundle`, `admin_save_bundle_localization`, `admin_set_bundle_members`, `admin_set_bundle_offer`, `admin_set_bundle_cover`, `publish_bundle`, `unpublish_bundle`.

- [ ] **Step 1: Write failing Vitest readiness/schema cases**

  Cover: fewer than two published members; complete localization requires title/slug/description; cover; active in-window offer; an unpublished member warning; readiness passes with two published members even when a third is unpublished. Add Zod cases for bundle details/localization/member IDs+ordering/offer and cover alt text.

- [ ] **Step 2: Implement the pure readiness contract**

  Keep blocking publication separate from warnings:

  ```ts
  export type BundleReadiness = { blocking: BundleReadinessIssueCode[]; warnings: BundleReadinessIssueCode[] };
  const filled = (value: string | null) => value !== null && value.trim().length > 0;
  const completeLocalization = (value: { title: string; slug: string; description: string | null }) =>
    filled(value.title) && filled(value.slug) && filled(value.description);
  export function checkBundleReadiness(snapshot: BundleReadinessSnapshot): BundleReadiness {
    const blocking: BundleReadinessIssueCode[] = [];
    if (snapshot.members.filter((member) => member.published).length < 2) blocking.push("too_few_published_members");
    if (!snapshot.localizations.some(completeLocalization)) blocking.push("missing_localization");
    if (!snapshot.hasCover) blocking.push("missing_cover");
    if (!snapshot.hasActiveOffer) blocking.push("missing_offer");
    return { blocking, warnings: snapshot.members.some((member) => !member.published) ? ["unpublished_member"] : [] };
  }
  ```

- [ ] **Step 3: Write failing pgTAP cases for each mutation**

  Prove admin-only execution, input constraints, member deduplication and exact order, offer upsert, cover ownership key, one audit row per call, readiness refusal, publish success, unpublish success, and localization rename. Rename `a -> b -> c` and assert redirects contain `a -> c` and `b -> c`, never a chain.

- [ ] **Step 4: Implement the admin RPCs**

  Every RPC begins with `public.is_admin()`, locks the bundle where relevant, performs one logical mutation, and writes one audit row. `admin_set_bundle_members` deletes/reinserts from `unnest(p_book_ids) with ordinality`; require distinct IDs and existing books. `publish_bundle` computes the same blocking codes/order as TypeScript and raises a new documented code `EB026` with `bundle is not ready: <csv>`. `admin_save_bundle_localization` calls `record_slug_redirect('/<locale>/bundles/<old>', '/<locale>/bundles/<new>')` only when the bundle is published.

- [ ] **Step 5: Verify parity, generate types, and commit**

  Run the focused Vitest files and pgTAP file, then the whole database suite and `npm run check`.

  ```bash
  git add lib/catalog/bundle-readiness.ts lib/catalog/bundle-readiness.test.ts lib/catalog/schemas.ts lib/catalog/schemas.test.ts supabase/migrations/20260924120000_s9_bundle_admin_rpcs.sql supabase/tests/042_s9_bundle_admin_rpcs.sql lib/supabase/database.types.ts
  git commit -m "feat(admin): add audited bundle publishing rules"
  ```

---

### Task 4: Build the bundle admin data layer, cover flow, and editor

**Files:**
- Create: `lib/data/bundles.ts`, `lib/data/bundles.test.ts`
- Create: `lib/data/bundle-covers.ts`, `lib/data/bundle-covers.test.ts`
- Create: `app/admin/bundles/page.tsx`, `app/admin/bundles/page.test.tsx`
- Create: `app/admin/bundles/new/page.tsx`
- Create: `app/admin/bundles/[bundleId]/page.tsx`, `app/admin/bundles/[bundleId]/page.test.tsx`
- Create: `app/admin/bundles/actions.ts`, `app/admin/bundles/actions.test.ts`
- Create: `app/admin/bundles/[bundleId]/actions.ts`, `app/admin/bundles/[bundleId]/actions.test.ts`
- Create: `app/admin/bundles/[bundleId]/cover-actions.ts`, `cover-actions.test.ts`
- Create focused components under `components/admin/bundle-editor/`
- Modify: `components/admin/admin-nav.tsx`

**Interfaces:**
- `AdminBundleDTO` contains status, both localizations, ordered member options with publication state, offer, cover, `readiness.blocking`, and `readiness.warnings`.
- `createBundle`, `saveBundleLocalization`, `setBundleMembers`, `setBundleOffer`, `publishBundle`, `unpublishBundle` each call `requireAdmin()` before `createClient()`.
- Cover upload keys are minted as `bundles/{bundleId}/{crypto.randomUUID()}.{ext}`; finalization calls `admin_set_bundle_cover`.

- [ ] **Step 1: Write failing data-layer tests**

  Mock `requireAdmin` and Supabase separately. Assert authorization precedes every client creation, DTO member order follows `position`, active-window offer is computed with one `now`, cover storage key is never selected through an authenticated browser-role query, and `EB026` maps to `BundleNotReadyError` with issue codes.

- [ ] **Step 2: Implement focused server-only modules**

  Do not expand `lib/data/books.ts`. Keep bundle querying/mutations in `lib/data/bundles.ts` and the service-role signed upload in `lib/data/bundle-covers.ts`, following `lib/data/covers.ts` exactly.

- [ ] **Step 3: Write failing page/action tests**

  Assert every page/action calls `requireAdmin({ next: exactPath })`; create redirects to `/admin/bundles/<id>`; validation errors remain field-specific; member reorder submits the complete ordered UUID list; publish displays blocking issues and warnings; an unpublished member warning remains visible on a published bundle.

- [ ] **Step 4: Implement the list and five editor sections**

  Use focused components: `details-form.tsx`, `localization-form.tsx`, `cover-upload-form.tsx`, `members-form.tsx`, `offer-form.tsx`, and `publish-panel.tsx`. The Members form uses explicit Move up/Move down controls plus Add/Remove so keyboard users can fully reorder; do not make drag-and-drop the only control. Add Bundles to `AdminNav`.

- [ ] **Step 5: Verify and commit**

  Run all new bundle Vitest/page tests and `npm run check`.

  ```bash
  git add lib/data/bundles.ts lib/data/bundles.test.ts lib/data/bundle-covers.ts lib/data/bundle-covers.test.ts app/admin/bundles components/admin/bundle-editor components/admin/admin-nav.tsx
  git commit -m "feat(admin): add bundle management screens"
  ```

---

### Task 5: Create bundle orders and the public bundle page

**Files:**
- Create: `supabase/migrations/20260924130000_s9_bundle_orders.sql`
- Create: `supabase/tests/043_s9_bundle_orders.sql`
- Create: `lib/data/public-bundles.ts`, `lib/data/public-bundles.test.ts`
- Create: `app/[locale]/(public)/bundles/[slug]/page.tsx`, `page.test.tsx`
- Create: `app/[locale]/(public)/bundles/[slug]/actions.ts`, `actions.test.ts`
- Modify: `lib/commerce/orders.ts`, `lib/commerce/orders.test.ts`
- Modify: `lib/catalog/book-action.ts`, `lib/catalog/book-action.test.ts`
- Modify: `lib/i18n/routes.ts`, `lib/i18n/routes.test.ts`
- Modify: `lib/seo/json-ld.ts`, `lib/seo/json-ld.test.ts`
- Modify: `app/sitemap.ts`, `app/sitemap.test.ts`
- Modify: both dictionaries and `lib/supabase/database.types.ts`

**Interfaces:**
- `create_bundle_order(p_bundle_id uuid) returns uuid`.
- `createBundleOrder(locale, bundleId): Promise<{ orderId: string }>`.
- `BundleActionInput = { kind:'bundle'; publishedMemberCount:number; ownedMemberCount:number; offer:{priceMinor:number;active:boolean}|null; paymentsEnabled:boolean }`.
- `resolveBookAction(BookActionInput | BundleActionInput)` returns existing book actions plus `owned_bundle` for all members owned.
- `PublicBundleDTO` contains localized/alternate slugs, cover, live offer, ordered published member cards, and owned count; unpublished members never enter the public DTO.

- [ ] **Step 1: Add failing order pgTAP cases**

  Assert server-resolved live offer, order/title/price snapshot, one line per member, exactly one line carrying the total and all others zero, `orders.bundle_id`, pending-order idempotency, stale-price replacement, partial ownership allowed, full ownership `EB013`, draft/unready bundle `EB027`, and payment-disabled `EB011`.

- [ ] **Step 2: Implement `create_bundle_order`**

  Take the same verified-email and commerce gates as `create_ebook_order`. Acquire an advisory lock keyed by profile+bundle. Select and lock the bundle's live positive offer, require published bundle, load members in position order, and reject only when every member has an active entitlement. Snapshot a deterministic bundle title (prefer `vi`, then `en`), create one order/payment, and insert lines in `bundle_books.position` order with that position copied to `order_items.position`; only position 1 carries the bundle price.

- [ ] **Step 3: Test and implement the application order wrapper/action resolver**

  Add the bundle discriminant without changing current book outputs. For a published bundle: zero visible members => unavailable; all visible members owned => `owned_bundle`; live paid offer plus payments on => buy; live paid offer plus payments off => coming soon; otherwise unavailable. Partial ownership always stays buy/coming-soon and exposes the count separately.

- [ ] **Step 4: Test and implement the public DTO and route**

  The Server Component validates locale, loads a published bundle, resolves current-profile ownership, and renders cover, title, subtitle, description, members in position order linking to book pages, fixed price, owned count/full-price notice, and one action. The buy Server Action calls `requireUser(locale, bundlePath)`, calls `createBundleOrder`, then redirects to localized checkout.

- [ ] **Step 5: Add metadata, JSON-LD, routes, and sitemap**

  Add `getCatalogRoutes(locale).bundle(slug)`. `generateMetadata` uses `buildPageMetadata` and alternate slug only when present. Add `bundleSchema` with `Product`, nested `Offer`, and `isRelatedTo` Book entries for visible members. Add every published localized bundle URL to `app/sitemap.ts`; test deduplication and absence of drafts/unlocalized variants.

- [ ] **Step 6: Verify and commit**

  Run focused Vitest, local pgTAP, type generation, and `npm run check`.

  ```bash
  git add supabase/migrations/20260924130000_s9_bundle_orders.sql supabase/tests/043_s9_bundle_orders.sql lib/data/public-bundles.ts lib/data/public-bundles.test.ts lib/commerce/orders.ts lib/commerce/orders.test.ts lib/catalog/book-action.ts lib/catalog/book-action.test.ts lib/i18n/routes.ts lib/i18n/routes.test.ts lib/seo/json-ld.ts lib/seo/json-ld.test.ts app/[locale]/\(public\)/bundles app/sitemap.ts app/sitemap.test.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json lib/supabase/database.types.ts
  git commit -m "feat(storefront): add bundle purchase pages"
  ```

---

### Task 6: Extend coupon scope and every customer order view to multi-line orders

**Files:**
- Create: `supabase/migrations/20260924140000_s9_bundle_coupons.sql`
- Create: `supabase/tests/044_s9_bundle_coupons.sql`
- Modify: `lib/data/coupons.ts`, `lib/data/coupons.test.ts`
- Modify: `lib/catalog/schemas.ts`, `lib/catalog/schemas.test.ts`
- Modify: `components/admin/coupon-form.tsx`
- Modify: `app/admin/coupons/[couponId]/page.tsx`
- Modify: `app/admin/coupons/actions.ts`, `actions.test.ts`
- Modify: `lib/commerce/coupon-order.ts`, `coupon-order.test.ts`
- Modify: `lib/data/orders.ts`, `lib/data/orders.test.ts`
- Modify: `app/[locale]/(account)/checkout/[orderId]/page.tsx`, `page.test.tsx`
- Modify: `app/[locale]/(account)/checkout/[orderId]/status/page.tsx`, `page.test.tsx`
- Modify: `app/[locale]/(account)/account/orders/page.tsx`
- Modify: `app/[locale]/(account)/account/orders/[orderId]/page.tsx`, `page.test.tsx`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- Coupon admin DTO/input gains `bundleIds: string[]` alongside `bookIds`.
- `apply_coupon_to_order` returns `entitlement_ids uuid[]`.
- `CustomerOrderDTO.items: { bookId:string; title:string; hasActiveEntitlement:boolean }[]`, `bundleId:string|null`, and `hasAllActiveEntitlements:boolean` replace the singular book fields.

- [ ] **Step 1: Write failing coupon scope pgTAP cases**

  Cover the complete matrix: no book/bundle rows applies globally; book-only scope refuses a bundle; bundle-only scope refuses a single book and applies to the named bundle; mixed scope applies to the named subject on either side. Add 100%-off bundle assertions for one entitlement/library row per missing book, no duplicates for pre-owned books, one redemption flip, and array return.

- [ ] **Step 2: Replace the coupon RPCs and admin RPC signatures**

  Scope against `orders.bundle_id`: if non-null, only global or matching `coupon_bundles` applies; if null, preserve book scope rules. In the zero-total branch use the same set-based/loop grant pattern as Task 1. Drop/recreate dependent admin functions before changing return/signature types, and preserve S8 attempt quota, uniform rejection, advisory/order locks, transfer-claim guard, and audit semantics.

- [ ] **Step 3: Update coupon admin data/forms/tests**

  Load bundle options from the protected admin data layer. Render separate Books and Bundles scope controls with copy explaining that no selections means global. Submit both UUID arrays; never infer bundle scope from member book IDs.

- [ ] **Step 4: Write failing multi-item order DTO/page tests**

  Assert stable item order, bundle checkout renders all member titles/covers, partial ownership does not hide Pay, all-owned replaces Pay with a library link, and list/detail/status pages name the bundle snapshot plus item count without truncating their underlying DTO to the first item.

- [ ] **Step 5: Implement the DTO and page changes**

  Order `items:order_items` by the persisted `order_items.position` added in Task 2. Keep single-book rendering visually unchanged. Bundle checkout shows a compact ordered list and uses `hasAllActiveEntitlements`, never `items[0]`, for the ownership branch.

- [ ] **Step 6: Verify and commit**

  Run pgTAP, all coupon/order/checkout tests, regenerate types, and run `npm run check`.

  ```bash
  git add supabase/migrations/20260924140000_s9_bundle_coupons.sql supabase/tests/044_s9_bundle_coupons.sql lib/data/coupons.ts lib/data/coupons.test.ts lib/catalog/schemas.ts lib/catalog/schemas.test.ts components/admin/coupon-form.tsx app/admin/coupons lib/commerce/coupon-order.ts lib/commerce/coupon-order.test.ts lib/data/orders.ts lib/data/orders.test.ts app/[locale]/\(account\) lib/supabase/database.types.ts
  git commit -m "feat(commerce): support bundle coupons and multi-item checkout"
  ```

---

### Task 7: Add gift token/form primitives and the protected gift outbox schema

**Files:**
- Create: `lib/commerce/gift-token.ts`, `lib/commerce/gift-token.test.ts`
- Create: `lib/commerce/gift-form.ts`, `lib/commerce/gift-form.test.ts`
- Create: `supabase/migrations/20260924150000_s9_gift_schema.sql`
- Create: `supabase/tests/045_s9_gift_schema.sql`
- Modify: `lib/email/outbox.ts`, `lib/email/outbox.test.ts`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `generateGiftToken(): string` returns 32 random bytes as base64url.
- `hashGiftToken(token: string): Promise<string>` returns lower-case SHA-256 hex.
- `giftCheckoutSchema` returns `{ recipientEmail:string; message:string|null }`, lower-casing and trimming email, with message max 500.
- `notification_outbox` supports exactly one of `entitlement_id` or `gift_id`, with `payload jsonb`; template keys are `book_ready|gift_claim`.

- [ ] **Step 1: Write deterministic unit tests**

  Inject random bytes into the generator for testability; assert URL-safe output, 43-character token for 32 bytes, stable lower-case SHA-256, different tokens hash differently, normalized email, optional empty message => null, invalid email refusal, and 501-character refusal.

- [ ] **Step 2: Implement the pure modules**

  Use Web Crypto only:

  ```ts
  import { Buffer } from "node:buffer";

  type FillRandom = (bytes: Uint8Array) => Uint8Array;
  export function generateGiftToken(fillRandom: FillRandom = (bytes) => crypto.getRandomValues(bytes)): string {
    const bytes = fillRandom(new Uint8Array(32));
    return Buffer.from(bytes).toString("base64url");
  }
  export async function hashGiftToken(token: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  ```

- [ ] **Step 3: Write failing gift schema/RLS/outbox pgTAP cases**

  Assert all spec columns/checks, normalized lower-case email check, unique order/hash, claimed/revoked timestamp consistency, purchaser can read their row but cannot see `claim_token_hash` (expose a safe view/RPC rather than granting table select), reader B sees nothing, admins see all through an admin RPC, nobody writes through Data API, and the outbox XOR/unique-gift constraints.

- [ ] **Step 4: Implement schema and outbox evolution**

  Add `gifts` exactly as specified. Evolve `notification_outbox`: make `entitlement_id` and `profile_id` nullable, add nullable unique `gift_id`, add nullable `payload`, widen template check, and add `check ((entitlement_id is not null)::int + (gift_id is not null)::int = 1)`. Update `claim_notification_outbox` so book rows still require an active entitlement while gift rows require `gifts.status='sent'`; return `gift_id` and `payload` as well as existing fields. Update the TypeScript claimed-row handling to narrow `book_ready` rows to non-null `entitlement_id/profile_id`; until Task 9 adds gift delivery, a claimed `gift_claim` row is failed with safe code `unsupported_template`. Existing book-ready behavior must remain byte-for-byte compatible in its tests.

- [ ] **Step 5: Verify and commit**

  Run focused unit tests, pgTAP including `021_s5_observability_outbox.sql`, regenerate types, and `npm run check`.

  ```bash
  git add lib/commerce/gift-token.ts lib/commerce/gift-token.test.ts lib/commerce/gift-form.ts lib/commerce/gift-form.test.ts supabase/migrations/20260924150000_s9_gift_schema.sql supabase/tests/045_s9_gift_schema.sql lib/email/outbox.ts lib/email/outbox.test.ts lib/supabase/database.types.ts
  git commit -m "feat(gifts): add secure token and outbox schema"
  ```

---

### Task 8: Implement gift configuration, payment completion, and atomic claims

**Files:**
- Create: `supabase/migrations/20260924160000_s9_gift_lifecycle.sql`
- Create: `supabase/tests/046_s9_gift_lifecycle.sql`
- Create: `lib/commerce/gifts.ts`, `lib/commerce/gifts.test.ts`
- Modify: `lib/access/grant.ts`, `lib/access/grant.test.ts`
- Modify: `lib/commerce/coupon-order.ts`, `coupon-order.test.ts`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `configure_gift(p_order_id,p_recipient_email,p_message,p_token_hash,p_claim_path)`; only purchaser's pending order.
- `remove_gift(p_order_id)`; only purchaser's pending order, deletes the unactivated gift/outbox row.
- `get_my_order_gift(p_order_id)` returns only `recipient_email`, `message`, and `status` for the purchaser's own order.
- `claim_gift(p_token text) returns table(book_id uuid,title text,entitlement_id uuid,already_owned boolean)`.
- `configureGift(locale, orderId, input)` generates/hash token and passes only hash + localized relative claim path to the RPC; returns `void`.
- `getMyOrderGift(locale, orderId)` returns the safe checkout fields or null; it never selects `gifts` directly.
- New error codes documented from `EB028`: invalid gift order/state and invalid/claimed/revoked token.

- [ ] **Step 1: Write lifecycle pgTAP tests before SQL**

  Cover purchaser-only configure/remove/read, lower-case recipient, safe read omitting hash/path, replacement while pending invalidates old hash/path, no buyer entitlement after simulator/manual success, one `gift_claim` outbox row, 100% coupon same behavior, normal non-gift behavior unchanged, claim grants all missing books, same-reader replay returns same result, different-reader replay refused, unknown/revoked token refused, and claimed gift fields/timestamps.

- [ ] **Step 2: Add a real two-session concurrency test**

  Use `dblink_send_query` with two authenticated connections claiming the same token. Hold the first transaction after the row lock, start the second, then release the first. Assert exactly one claimant profile owns the newly sourced entitlements, `gifts.claimed_by_profile_id` names that winner, and the loser receives `EB029`. Do not replace this with two sequential calls; the exit criterion is specifically concurrent.

- [ ] **Step 3: Implement configure/remove and shared gift activation**

  `configure_gift` locks the purchaser's pending order, refuses an already reported transfer, upserts the pending gift, and upserts one non-claimable outbox row carrying `{ "claimPath": p_claim_path }`. Add an internal, non-granted `activate_order_gift(order_id)` helper that moves `pending -> sent` and makes the outbox row available. It returns boolean so payment/coupon functions branch without duplicating status logic.

- [ ] **Step 4: Replace payment/coupon success branches**

  In `apply_payment_event`, after order/payment state succeeds: if `activate_order_gift` returns true, skip the entitlement/library loop and return an empty `entitlement_ids`; otherwise execute the Task 1 loop. In `apply_coupon_to_order` zero-total branch do exactly the same before flipping the redemption once. Replay resolves purchaser entitlements only for non-gifts and returns empty for gifts.

- [ ] **Step 5: Implement `claim_gift`**

  Hash with `encode(extensions.digest(convert_to(p_token,'UTF8'),'sha256'),'hex')`, select the gift `for update`, and branch:

  - `sent`: derive the caller profile; for each distinct order item capture whether an active entitlement existed, insert missing entitlement with `source_type='free_order'` when the order total is zero and otherwise the source mapped from `orders.payment_provider`, always set `source_order_id`, insert the library row, then set `claimed`, claimant, and timestamp.
  - `claimed` by same profile: return the same ordered book/result set without writes.
  - anything else or another claimant: raise the uniform claim error.

  Finally clear `notification_outbox.payload` for the gift so the raw token is no longer retained after claim.

- [ ] **Step 6: Implement/test the server-only wrapper and verify**

  `configureGift` calls `requireUser(locale)` before creating the session client, never returns/logs the token, and maps lifecycle codes to named safe errors. `claimGift` also requires user and passes the raw URL token only to the RPC. Run the full pgTAP suite, focused unit tests, regenerate types, and `npm run check`.

- [ ] **Step 7: Commit**

  ```bash
  git add supabase/migrations/20260924160000_s9_gift_lifecycle.sql supabase/tests/046_s9_gift_lifecycle.sql lib/commerce/gifts.ts lib/commerce/gifts.test.ts lib/access/grant.ts lib/access/grant.test.ts lib/commerce/coupon-order.ts lib/commerce/coupon-order.test.ts lib/supabase/database.types.ts
  git commit -m "feat(gifts): add payment-safe atomic gift claims"
  ```

---

### Task 9: Deliver gift email and add checkout/claim experiences

**Files:**
- Create: `lib/email/gift.ts`, `lib/email/gift.test.ts`
- Modify: `lib/email/outbox.ts`, `lib/email/outbox.test.ts`
- Create: `components/commerce/gift-form.tsx`, `gift-form.test.tsx`
- Create: `app/[locale]/(account)/checkout/[orderId]/gift-actions.ts`, `gift-actions.test.ts`
- Modify: checkout page/test and dictionaries
- Create: `app/[locale]/(account)/gifts/claim/[token]/page.tsx`, `page.test.tsx`
- Modify: `lib/i18n/routes.ts`, `lib/i18n/routes.test.ts`
- Modify: `app/api/operations/run/route.test.ts`

**Interfaces:**
- `buildGiftClaimEmail({ locale, purchaserName, message, claimUrl, itemTitles })` returns safe text/html/subject.
- `getCommerceRoutes(locale).giftClaim(token)` and `.signInForGift(token)`.
- Claim page metadata is static `robots: { index:false, follow:false }` and route remains dynamic by reading token/session at request time.

- [ ] **Step 1: Write failing email/outbox tests**

  Assert HTML escaping of purchaser/message/titles, CR/LF stripping from subject, localized generic fallback, absolute claim URL construction from protected relative payload, recipient is `gifts.recipient_email`, idempotency key `gift-claim/<outboxId>`, book-ready rows unchanged, no token/email in logs, and payload clearing after a successful claim does not affect already completed delivery.

- [ ] **Step 2: Implement template dispatch in the existing worker**

  Split `resolveBookReadyDelivery` and `resolveGiftDelivery`; dispatch on `template_key`. A gift delivery loads the gift/order item titles using the service-role client, validates status `sent`, validates payload shape, and sends to the gift address. Keep sequential batch delivery, lease loss behavior, max lengths, and completion/failure RPCs unchanged.

- [ ] **Step 3: Write failing checkout action/component tests**

  Assert page/action `requireUser`, invalid field errors, gift save/remove, existing pending gift prefill without exposing token/hash, gift form disabled once transfer is reported, and gift configuration occurs before a coupon can complete a zero-total order. The UI must clearly state the purchaser will not receive access.

- [ ] **Step 4: Implement checkout gift form**

  Place it before Coupon and Pay. Use `useActionState` for recipient/message validation; save calls `configureGift`, remove calls `removeGift`, then `revalidatePath` the checkout. Extend the safe customer-order read with purchaser-visible gift email/message/status from a dedicated safe RPC/view, never from direct `gifts` table select.

- [ ] **Step 5: Write failing claim-page tests**

  Signed-out requests redirect to `/{locale}/sign-in?next=/<locale>/gifts/claim/<token>` with the token preserved only in `next`. Signed-in success lists “added” and “already owned” groups. Same-reader refresh is idempotent. Invalid/revoked/already-claimed-by-other uses one localized refusal message. Page and metadata never include recipient email.

- [ ] **Step 6: Implement the dynamic claim page**

  Validate locale, call `requireUser(locale, exactClaimPath)`, then `claimGift`. Render the RPC result only; do not re-query entitlements client-side. Provide a localized Library action and links to each readable book. Export noindex metadata and never add claim URLs to sitemap.

- [ ] **Step 7: Verify and commit**

  Run focused email, route, page, and checkout tests, then `npm run check`.

  ```bash
  git add lib/email/gift.ts lib/email/gift.test.ts lib/email/outbox.ts lib/email/outbox.test.ts components/commerce/gift-form.tsx components/commerce/gift-form.test.tsx app/[locale]/\(account\)/checkout/[orderId] app/[locale]/\(account\)/gifts lib/i18n/routes.ts lib/i18n/routes.test.ts lib/i18n/dictionaries/en.json lib/i18n/dictionaries/vi.json app/api/operations/run/route.test.ts
  git commit -m "feat(gifts): add delivery checkout and claim journey"
  ```

---

### Task 10: Add gift search, resend, and reissue for admins

**Files:**
- Create: `supabase/migrations/20260924170000_s9_gift_admin_rpcs.sql`
- Create: `supabase/tests/047_s9_gift_admin_rpcs.sql`
- Create: `lib/data/gifts.ts`, `lib/data/gifts.test.ts`
- Create: `app/admin/gifts/page.tsx`, `page.test.tsx`
- Create: `app/admin/gifts/actions.ts`, `actions.test.ts`
- Create: `components/admin/gift-actions.tsx`
- Modify: `components/admin/admin-nav.tsx`
- Modify: `lib/supabase/database.types.ts`

**Interfaces:**
- `admin_search_gifts(p_query text)` matches exact/partial order reference, purchaser normalized email, or recipient email and returns no hash/payload.
- `admin_resend_gift(p_gift_id uuid)` resets the existing outbox delivery lease/error/sent fields while keeping the same recipient/token payload.
- `admin_reissue_gift(p_gift_id,p_recipient_email,p_token_hash,p_claim_path,p_reason)` replaces address/token for an unclaimed gift and resets the one outbox row.

- [ ] **Step 1: Write failing admin RPC tests**

  Prove non-admin refusal, all three search keys, no token/hash/payload in returns, resend only for `sent`, unique outbox row retained, reissue invalidates old hash and resets attempts/leases, masked audit metadata, exact one audit row, and claimed gifts refuse both reissue and revoke. Include revoked/unknown token claim refusal after reissue.

- [ ] **Step 2: Implement the RPCs**

  Lock gift and outbox in gift-then-outbox order. `admin_resend_gift` retains payload and recipient. `admin_reissue_gift` requires nonblank reason, lower-cases email, updates gift to `sent`, clears claim/revoke fields, replaces hash and outbox claim path, and resets delivery state. Audit must use a mask such as `a***@example.com`; do not put full email or token/hash/path in metadata.

- [ ] **Step 3: Implement/test the protected data layer**

  Each exported function calls `requireAdmin()` before creating a client. The TypeScript reissue wrapper generates the new raw token/path and sends only hash/path to the RPC; it never returns the token. Map claimed/not-sent error codes to named operator messages.

- [ ] **Step 4: Implement/test `/admin/gifts`**

  Page calls `requireAdmin({ next:'/admin/gifts' })`, accepts a bounded `q`, and renders reference, purchaser, recipient, item titles/count, status, and timestamps. Resend and reissue are Server Actions that independently call `requireAdmin`; reissue requires new email and reason. Add Gifts to admin navigation.

- [ ] **Step 5: Verify and commit**

  Run pgTAP, focused unit/page tests, regenerate types, and `npm run check`.

  ```bash
  git add supabase/migrations/20260924170000_s9_gift_admin_rpcs.sql supabase/tests/047_s9_gift_admin_rpcs.sql lib/data/gifts.ts lib/data/gifts.test.ts app/admin/gifts components/admin/gift-actions.tsx components/admin/admin-nav.tsx lib/supabase/database.types.ts
  git commit -m "feat(admin): add gift support operations"
  ```

---

### Task 11: Prove both journeys end to end and document operations

**Files:**
- Create: `e2e/bundles-and-gifts.spec.ts`
- Modify: `e2e/support/catalog.ts`
- Modify: `e2e/support/commerce.ts`
- Modify: `e2e/support/mailpit.ts`
- Create: `docs/runbooks/bundles-and-gifts.md`
- Modify any count assertions/documented suite counts in `docs/runbooks/testing-environments.md`

**Interfaces:**
- E2E helpers create/publish a two-book bundle through local service-role fixtures, read operation-worker gift links from Mailpit/no-network outbox state without logging tokens, and count active entitlements/library rows for multiple book IDs.

- [ ] **Step 1: Write the failing bundle purchase journey**

  Create two published books and a bundle, sign in buyer, buy bundle, choose manual transfer, report it, sign in admin on the manual-payment server, confirm it, then assert the buyer library contains both books and each reader route opens. Also assert the bundle itself never appears as a library item.

- [ ] **Step 2: Write the failing gift claim journey**

  Buy one book as a gift, complete simulator payment, run the authenticated operations worker, obtain the claim URL delivered to the recipient, open it signed out, complete magic-link sign-in with `next` returning to the claim, claim, and open the reader. Assert purchaser has zero entitlement, recipient has exactly one, refreshing claim does not duplicate, and page is noindex.

- [ ] **Step 3: Add a bundle-gift regression path inside the same spec**

  Use a 100% coupon on a configured bundle gift, assert no payment interaction is needed, the recipient claim adds every missing book, and a pre-owned member is reported as already owned without duplication. This closes the highest-risk cross-feature branch even though the two exit-criterion golden paths are already covered.

- [ ] **Step 4: Write the runbook**

  Document: create bundle, add/reorder at least two members, upload cover, configure offer/localizations, resolve readiness, publish, verify localized public URLs, find a gift, resend to the same address, reissue to another address with required reason, why claimed gifts cannot be reissued, and how to use `revoke_order_entitlement` for a claimed gift/order. Include local-only verification commands and warnings against cloud fixtures/destructive resets.

- [ ] **Step 5: Run final verification**

  Against an owned local stack, in this order:

  1. Reset and generate `lib/supabase/database.types.ts`; confirm no diff after a second generation.
  2. Run `supabase test db` and confirm every pgTAP file, including 018/019/021/029/037 and 040–047, passes.
  3. Stop the stack if required by the current `scripts/ebook.ts` unit-test constraint, then run `npm run check` under Node 22.
  4. Restart/reset the owned stack, export `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `E2E_MAILPIT_URL`, and `E2E_DATABASE_URL`, then run `npm run check:full`.
  5. Run `git diff --check` and inspect `git status --short`; preserve unrelated `ibcmd.txt`.

- [ ] **Step 6: Commit**

  ```bash
  git add e2e/bundles-and-gifts.spec.ts e2e/support/catalog.ts e2e/support/commerce.ts e2e/support/mailpit.ts docs/runbooks/bundles-and-gifts.md docs/runbooks/testing-environments.md
  git commit -m "test(s9): cover bundle and gift journeys"
  ```

## Self-review checklist

- Spec coverage: core multi-line payment/replay/out-of-order, bundle schema/readiness/admin/public/SEO/order/library, gift purchase/delivery/claim/admin, coupon scopes, Vitest/pgTAP/Playwright/runbook, and all exit criteria each map to a task above.
- Security: every protected page/action has its own gate; service role remains behind admin/worker gates; raw tokens are confined to protected outbox payload and claim URLs; cross-user RLS and claim races have negative tests.
- Type consistency: all payment/coupon/revocation paths use `entitlement_ids`; customer orders use `items[]`; bundle coupon scope keys from `orders.bundle_id`; gift claims return `{ book_id, title, entitlement_id, already_owned }` consistently.
- Migration order: core `100000`, schema `110000`, admin `120000`, bundle order `130000`, coupon/order view `140000`, gift schema `150000`, lifecycle `160000`, admin gift `170000`; tests 040–047 match that order.
- No scope creep: no cart, partial-ownership proration, expiry, scheduling, printable cards, physical products, self-service revocation, automatic bundles, or claimed-gift reassignment.
