begin;
select plan(11);

-- S18: 'sepay' is a provider the database books orders under, settles, gifts, and revokes exactly
-- as it does 'manual'. Every order here comes from create_ebook_order, because the agreement
-- between commerce_settings, orders.payment_provider, and payments.provider is what is under test
-- and only the real RPC produces it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1800000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's18-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1800000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's18-recipient@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- The buyer doubles as the admin for the revoke case.
insert into public.user_roles (profile_id, role)
select p.id, 'admin' from public.profiles p where p.auth_user_id = 'a1800000-0000-0000-0000-000000000001';

create temporary table t_orders (label text primary key, order_id uuid not null);
grant select, insert on t_orders to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('a1830000-0000-0000-0000-000000000001', 's18-author', 'S18 Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
select ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 's18-book-' || n, 'vi',
       'a1830000-0000-0000-0000-000000000001', 'published'
from generate_series(1, 2) as n;

insert into public.book_localizations (book_id, locale, slug, title)
select ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 'vi', 's18-sach-' || n, 'Sách S18 ' || n
from generate_series(1, 2) as n;

insert into public.editions (id, book_id, language_code)
select ('a1840000-0000-0000-0000-00000000000' || n)::uuid, ('a1820000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 2) as n;

insert into public.skus (id, edition_id, sku_code)
select ('a1850000-0000-0000-0000-00000000000' || n)::uuid, ('a1840000-0000-0000-0000-00000000000' || n)::uuid, 's18-sku-' || n
from generate_series(1, 2) as n;

insert into public.offers (sku_id, market_code, currency, price_minor)
select ('a1850000-0000-0000-0000-00000000000' || n)::uuid, 'VN', 'VND', 89000
from generate_series(1, 2) as n;

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
select ('a1860000-0000-0000-0000-00000000000' || n)::uuid, ('a1840000-0000-0000-0000-00000000000' || n)::uuid,
       's18/' || n || '.epub', 1, 'published'
from generate_series(1, 2) as n;

insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
select ('a1870000-0000-0000-0000-00000000000' || n)::uuid, ('a1860000-0000-0000-0000-00000000000' || n)::uuid, 1,
       's18/' || n || '/manifest.json', 'published'
from generate_series(1, 2) as n;

update public.books b set active_publication_id = ('a1870000-0000-0000-0000-00000000000' || right(b.canonical_key, 1))::uuid
where b.canonical_key in ('s18-book-1', 's18-book-2');

-- The settings row accepts the provider (1)
select lives_ok(
  $$ update public.commerce_settings set payments_enabled = true, payment_provider = 'sepay' $$,
  'commerce_settings accepts sepay');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000001', true);
insert into t_orders values ('own', public.create_ebook_order('a1820000-0000-0000-0000-000000000001'));
insert into t_orders values ('gift', public.create_ebook_order('a1820000-0000-0000-0000-000000000002'));
select public.configure_gift(
  (select order_id from t_orders where label = 'gift'), 's18-recipient@example.test', null,
  encode(extensions.digest(convert_to('s18-gift-token', 'UTF8'), 'sha256'), 'hex'),
  '/vi/gifts/claim/s18-gift-token');
reset role;

-- The order and its payments row are both booked under sepay (2, 3)
select is(
  (select o.payment_provider from public.orders o where o.id = (select order_id from t_orders where label = 'own')),
  'sepay', 'the order is booked under sepay');
select is(
  (select pay.provider from public.payments pay where pay.order_id = (select order_id from t_orders where label = 'own')),
  'sepay', 'the payments row is booked under sepay');

-- A provider the order was not booked under is still refused (4)
select throws_ok(
  $$ select public.apply_payment_event('manual', 's18-evt-wrong',
       (select order_id from t_orders where label = 'own'), 'ext-wrong', 'succeeded', 89000, 'VND', now()) $$,
  'EB016', null, 'a manual event against a sepay order is refused');

-- The call and the assertions are separate statements: a query that both invokes the RPC and
-- reads the rows it writes can plan the read against a snapshot that predates them (see 029).
create temporary table t_paid as
select * from public.apply_payment_event('sepay', 'TXN-S18-1',
  (select order_id from t_orders where label = 'own'), 'NPSETVI001', 'succeeded', 89000, 'VND', now());

-- It completes the order and grants a sepay_payment entitlement (5, 6)
select is((select order_status::text from t_paid), 'completed', 'a sepay event completes the order');
select is(
  (select e.source_type::text from public.entitlements e where e.id in (select unnest(entitlement_ids) from t_paid)),
  'sepay_payment', 'the entitlement records sepay_payment as its source');

-- A repeated delivery changes nothing (7)
select public.apply_payment_event('sepay', 'TXN-S18-1',
  (select order_id from t_orders where label = 'own'), 'NPSETVI001', 'succeeded', 89000, 'VND', now());
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'own')),
  1::bigint, 'a repeated sepay event grants nothing more');

-- A wrong amount is refused (8)
select throws_ok(
  $$ select public.apply_payment_event('sepay', 'TXN-S18-amount',
       (select order_id from t_orders where label = 'gift'), 'NPSETVI002', 'succeeded', 79000, 'VND', now()) $$,
  'EB004', null, 'a sepay event for another amount is refused');

-- A gift order paid through sepay grants the buyer nothing, and the recipient's claim is a
-- sepay_payment entitlement (9, 10). This is the claim_gift mapping.
select public.apply_payment_event('sepay', 'TXN-S18-2',
  (select order_id from t_orders where label = 'gift'), 'NPSETVI002', 'succeeded', 89000, 'VND', now());
select is(
  (select count(*) from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'gift')),
  0::bigint, 'the buyer of a gift order holds nothing');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000002', true);
select public.claim_gift('s18-gift-token');
reset role;

select is(
  (select e.source_type::text from public.entitlements e
   where e.source_order_id = (select order_id from t_orders where label = 'gift')),
  'sepay_payment', 'a claimed sepay gift is a sepay_payment entitlement');

-- An admin can revoke what a sepay order granted (11). S7 left manual_payment out of this list.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1800000-0000-0000-0000-000000000001', true);
select is(
  cardinality(public.revoke_order_entitlement((select order_id from t_orders where label = 'own'), 'Refunded')),
  1, 'revoke_order_entitlement finds a sepay_payment entitlement');
reset role;

select * from finish();
rollback;
