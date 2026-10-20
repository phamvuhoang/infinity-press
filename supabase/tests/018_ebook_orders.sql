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

update public.commerce_settings set payments_enabled = true, payment_provider = 'simulator';

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
