begin;
select plan(55);

-- S9: the bundle schema, the offer target invariant, and bundle visibility
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 6.1).
--
-- A non-admin reader and an admin, the house pattern from 034_s8_coupon_schema.sql: without the
-- reader every visibility assertion below would pass even if the public read policies said
-- `using (true)`, and without the admin the draft-bundle assertions would not distinguish
-- "hidden from everyone" from "hidden from readers only".
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-bundle-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'b1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-bundle-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'b1000000-0000-0000-0000-000000000001') as reader,
  (select id from public.profiles where auth_user_id = 'b1000000-0000-0000-0000-000000000002') as admin_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name, status)
values ('b3000000-0000-0000-0000-000000000001', 's9-bundle-author', 'S9 Bundle Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('b2000000-0000-0000-0000-000000000001', 's9-bundle-book-1', 'vi', 'b3000000-0000-0000-0000-000000000001', 'published'),
  ('b2000000-0000-0000-0000-000000000002', 's9-bundle-book-2', 'vi', 'b3000000-0000-0000-0000-000000000001', 'published');

insert into public.editions (id, book_id, language_code)
values ('b4000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('b5000000-0000-0000-0000-000000000001', 'b4000000-0000-0000-0000-000000000001', 'S9-BUNDLE-SKU-1');
insert into public.offers (id, sku_id, market_code, currency, price_minor)
values ('b6000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001', 'VN', 'VND', 129000);

-- One published bundle, one draft bundle that survives the whole file, and a third draft bundle
-- that exists only to be deleted by the cascade assertions below.
insert into public.bundles (id, status) values
  ('b7000000-0000-0000-0000-000000000001', 'published'),
  ('b7000000-0000-0000-0000-000000000002', 'draft'),
  ('b7000000-0000-0000-0000-000000000003', 'draft');

insert into public.bundle_localizations (bundle_id, locale, slug, title) values
  ('b7000000-0000-0000-0000-000000000001', 'vi', 'goi-sach-s9', 'Gói sách S9'),
  ('b7000000-0000-0000-0000-000000000002', 'vi', 'goi-sach-s9-nhap', 'Gói sách nháp'),
  ('b7000000-0000-0000-0000-000000000003', 'en', 's9-throwaway-bundle', 'Throwaway bundle');

insert into public.bundle_books (bundle_id, book_id, position) values
  ('b7000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 1),
  ('b7000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 2),
  ('b7000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000001', 1),
  ('b7000000-0000-0000-0000-000000000003', 'b2000000-0000-0000-0000-000000000001', 1);

insert into public.offers (id, bundle_id, market_code, currency, price_minor)
values ('b6000000-0000-0000-0000-000000000002', 'b7000000-0000-0000-0000-000000000001', 'VN', 'VND', 199000);

-- Shape ---------------------------------------------------------------------------------------
select has_table('public', 'bundles', 'bundles exists');
select has_table('public', 'bundle_localizations', 'bundle_localizations exists');
select has_table('public', 'bundle_books', 'bundle_books exists');
select has_table('public', 'coupon_bundles', 'coupon_bundles exists');
select has_column('public', 'offers', 'bundle_id', 'offers carries a bundle target');
select has_column('public', 'orders', 'bundle_id', 'orders record the bundle they were placed for');
select has_column('public', 'order_items', 'position', 'order_items carry a position');
select col_is_pk('public', 'bundle_books', array['bundle_id', 'book_id'],
  'bundle_books is keyed by (bundle_id, book_id)');
select col_not_null('public', 'order_items', 'position', 'order_items.position is not null');
select col_is_null('public', 'offers', 'sku_id',
  'offers.sku_id is nullable now that a bundle can be the target instead');
select throws_ok(
  $$insert into public.bundles (status) values ('retired')$$,
  '22P02', null, 'bundles.status is the content_status enum, not free text');

-- The offer target invariant --------------------------------------------------------------------
select throws_ok(
  $$insert into public.offers (market_code, currency, price_minor) values ('VN', 'VND', 1000)$$,
  '23514', null, 'an offer with neither a sku nor a bundle is refused');
select throws_ok(
  $$insert into public.offers (sku_id, bundle_id, market_code, currency, price_minor)
    values ('b5000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000001', 'VN', 'VND', 1000)$$,
  '23514', null, 'an offer with both a sku and a bundle is refused');
select throws_ok(
  $$insert into public.offers (bundle_id, market_code, currency, price_minor)
    values ('b7000000-0000-0000-0000-000000000001', 'VN', 'VND', 250000)$$,
  '23505', null, 'a bundle may not carry two offers in one market and currency');
select lives_ok(
  $$insert into public.offers (bundle_id, market_code, currency, price_minor)
    values ('b7000000-0000-0000-0000-000000000001', 'US', 'USD', 1900)$$,
  'the same bundle may be priced in a second market');

-- Localizations -----------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000001', 'fr', 'coffret-s9', 'Coffret')$$,
  '23503', null, 'a locale outside the registry is refused');
select throws_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000001', 'en', 'Not Kebab', 'S9 Bundle')$$,
  '23514', null, 'a slug that is not kebab-case is refused');
select throws_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000001', 'en', 's9-bundle', '   ')$$,
  '23514', null, 'a blank title is refused');
select throws_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000002', 'vi', 'goi-sach-s9', 'Trung slug')$$,
  '23505', null, 'two bundles cannot share a slug in one locale');
select throws_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000001', 'vi', 'goi-sach-s9-khac', 'Trung locale')$$,
  '23505', null, 'a bundle has at most one localization per locale');

-- Membership ---------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.bundle_books (bundle_id, book_id, position)
    values ('b7000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 0)$$,
  '23514', null, 'a zero position is refused');
select throws_ok(
  $$insert into public.bundle_books (bundle_id, book_id, position)
    values ('b7000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 3)$$,
  '23505', null, 'a book appears at most once in a bundle');
select throws_ok(
  $$insert into public.bundle_books (bundle_id, book_id, position)
    values ('b7000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 1)$$,
  '23505', null, 'two members of one bundle cannot share a position');
select lives_ok(
  $$insert into public.bundle_books (bundle_id, book_id, position)
    values ('b7000000-0000-0000-0000-000000000002', 'b2000000-0000-0000-0000-000000000002', 2)$$,
  'the same position may be reused in a different bundle');

-- Orders -----------------------------------------------------------------------------------------
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, bundle_id)
select 'b8000000-0000-0000-0000-000000000001', t_ids.reader, 'pending', 'pending', 'VN', 'VND', 199000,
       'b7000000-0000-0000-0000-000000000001'
from t_ids;

insert into public.order_items (id, order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values ('b9000000-0000-0000-0000-000000000001', 'b8000000-0000-0000-0000-000000000001',
        'b5000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'S9 Bundle Book 1', 199000);

select is(
  (select position from public.order_items where id = 'b9000000-0000-0000-0000-000000000001'),
  1,
  'an order item written without a position defaults to 1, the value existing single-item orders backfill to');
select throws_ok(
  $$insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
    values ('b8000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001',
            'b2000000-0000-0000-0000-000000000002', 'S9 Bundle Book 2', 0, 1)$$,
  '23505', null, 'two items of one order cannot share a position');
select throws_ok(
  $$insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
    values ('b8000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001',
            'b2000000-0000-0000-0000-000000000002', 'S9 Bundle Book 2', 0, 0)$$,
  '23514', null, 'a zero order-item position is refused');
select lives_ok(
  $$insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
    values ('b8000000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001',
            'b2000000-0000-0000-0000-000000000002', 'S9 Bundle Book 2', 0, 2)$$,
  'a second item of the same order takes the next position');

-- An order is the record of what was sold, so the bundle behind it cannot be deleted out from
-- under it. Localizations and members cascade; an order restricts.
select throws_ok(
  $$delete from public.bundles where id = 'b7000000-0000-0000-0000-000000000001'$$,
  '23503', null, 'a bundle with an order cannot be deleted');
select lives_ok(
  $$delete from public.bundles where id = 'b7000000-0000-0000-0000-000000000003'$$,
  'an unordered bundle can be deleted');
select is(
  (select count(*) from public.bundle_books where bundle_id = 'b7000000-0000-0000-0000-000000000003'),
  0::bigint,
  'deleting a bundle cascades to its members');
select is(
  (select count(*) from public.bundle_localizations where bundle_id = 'b7000000-0000-0000-0000-000000000003'),
  0::bigint,
  'deleting a bundle cascades to its localizations');

-- Coupon scope --------------------------------------------------------------------------------
insert into public.coupons (id, code, kind, percent_off)
values ('ba000000-0000-0000-0000-000000000001', 'S9BUNDLE-20', 'percent', 20);
insert into public.coupon_bundles (coupon_id, bundle_id)
values ('ba000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000001');
select throws_ok(
  $$insert into public.coupon_bundles (coupon_id, bundle_id)
    values ('ba000000-0000-0000-0000-000000000001', 'b7000000-0000-0000-0000-000000000001')$$,
  '23505', null, 'a coupon is scoped to a given bundle at most once');

-- Covers ----------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
    values ('bundle', 'b7000000-0000-0000-0000-000000000001', 'cover',
            'bundles/b7000000-0000-0000-0000-000000000001/ffffffff-ffff-ffff-ffff-ffffffffffff.webp', 'S9 bundle cover')$$,
  'a bundle may own a cover');
select throws_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
    values ('collection', 'b7000000-0000-0000-0000-000000000001', 'cover', 'collections/x.webp', 'x')$$,
  '23514', null, 'an owner type outside book|author|bundle is still refused');
select throws_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
    values ('bundle', 'b7000000-0000-0000-0000-000000000001', 'cover',
            'bundles/b7000000-0000-0000-0000-000000000001/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.webp', 'second')$$,
  '23505', null, 'a bundle has at most one cover');

-- Visibility: anonymous ---------------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.bundles),
  1::bigint,
  'anon sees the published bundle and not the draft one');
select is(
  (select count(*) from public.bundle_localizations),
  1::bigint,
  'anon reads only the published bundle localization');
select is(
  (select count(*) from public.bundle_books),
  2::bigint,
  'anon reads only the published bundle membership');
select throws_ok(
  $$insert into public.bundles (status) values ('published')$$,
  '42501', null, 'anon holds no insert privilege on bundles');
reset role;

-- Visibility: a signed-in non-admin reader ----------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*) from public.bundles),
  1::bigint,
  'a reader sees the published bundle only');
select is(
  (select count(*) from public.bundle_books),
  2::bigint,
  'a reader reads only the published bundle membership');
select throws_ok(
  $$insert into public.bundles (status) values ('published')$$,
  '42501', null, 'a reader holds no insert privilege on bundles');
select throws_ok(
  $$insert into public.bundle_books (bundle_id, book_id, position)
    values ('b7000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000002', 9)$$,
  '42501', null, 'a reader holds no insert privilege on bundle members');
select throws_ok(
  $$select 1 from public.coupon_bundles$$,
  '42501', null, 'a reader cannot read coupon_bundles at all');
reset role;

-- Visibility: an admin -----------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*) from public.bundles),
  2::bigint,
  'an admin reads draft bundles too');
select is(
  (select count(*) from public.bundle_localizations),
  2::bigint,
  'an admin reads draft bundle localizations');
select is(
  (select count(*) from public.bundle_books where bundle_id = 'b7000000-0000-0000-0000-000000000002'),
  2::bigint,
  'an admin reads draft bundle membership');

-- An admin edits bundles through the definer RPCs of the later S9 migrations, never through the
-- Data API: authenticated holds no write privilege on any of these tables.
select throws_ok(
  $$insert into public.bundles (status) values ('draft')$$,
  '42501', null, 'an admin holds no insert privilege on bundles either');
select throws_ok(
  $$update public.bundles set status = 'archived' where id = 'b7000000-0000-0000-0000-000000000001'$$,
  '42501', null, 'an admin holds no update privilege on bundles');
select throws_ok(
  $$insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
    values ('bundle', 'b7000000-0000-0000-0000-000000000001', 'cover', 'bundles/x/y.webp', 'x')$$,
  '42501', null, 'an admin cannot write a bundle cover through the Data API');

-- offers keeps its admin update grant for sku offers, but a bundle offer is priced only by the
-- bundle admin RPCs: the policy filters the row out, so the update matches nothing and the price
-- stands. Reading the row back afterwards is what proves it, since a filtered UPDATE is silent.
update public.offers set price_minor = 1 where id = 'b6000000-0000-0000-0000-000000000002';
select is(
  (select price_minor from public.offers where id = 'b6000000-0000-0000-0000-000000000002'),
  199000::bigint,
  'an admin cannot reprice a bundle offer through the Data API');
update public.offers set price_minor = 130000 where id = 'b6000000-0000-0000-0000-000000000001';
select is(
  (select price_minor from public.offers where id = 'b6000000-0000-0000-0000-000000000001'),
  130000::bigint,
  'an admin can still reprice a sku offer through the Data API');
reset role;

-- service_role owns the bundle write path, behind the admin gate in the application -----------------
set local role service_role;
select lives_ok(
  $$insert into public.bundles (id, status) values ('b7000000-0000-0000-0000-000000000004', 'draft')$$,
  'service_role may create a bundle');
select lives_ok(
  $$insert into public.bundle_localizations (bundle_id, locale, slug, title)
    values ('b7000000-0000-0000-0000-000000000004', 'en', 's9-service-bundle', 'Service bundle')$$,
  'service_role may localize a bundle');
reset role;

select * from finish();
rollback;
