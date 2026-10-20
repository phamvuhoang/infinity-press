begin;
select plan(6);

-- S8: apply_payment_event moves a coupon reservation with the order (spec 5.3).
--
-- Fixtures: reader A, one book and sku, one 20% coupon, and THREE pending simulator orders at
-- subtotal_minor 129000, discount_minor 25800, total_minor 103200, each with a payments row at
-- 103200 and a reserved coupon_redemptions row. The rows are inserted directly because this file
-- tests apply_payment_event, not the apply RPC.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's8-payevent-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001') as reader_a;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('e3000000-0000-0000-0000-000000000001', 's8-payevent-author', 'S8 Pay Event Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e2000000-0000-0000-0000-000000000001', 's8-payevent-book', 'vi', 'e3000000-0000-0000-0000-000000000001', 'published');

insert into public.book_localizations (book_id, locale, slug, title)
values ('e2000000-0000-0000-0000-000000000001', 'vi', 's8-sach-payevent', 'Sách payevent');

insert into public.editions (id, book_id, language_code)
values ('e4000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'vi');

insert into public.skus (id, edition_id, sku_code)
values ('e5000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 's8-payevent-sku');

insert into public.coupons (id, code, kind, percent_off, active, max_redemptions_per_profile)
values ('e6000000-0000-0000-0000-000000000001', 'PAYEVENT20', 'percent', 20, true, 5);

-- Three pending simulator orders, all carrying the same 20%-off snapshot.
create temporary table t_orders (label text primary key, order_id uuid not null default gen_random_uuid());
insert into t_orders (label) values ('order-1'), ('order-2'), ('order-3');

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, discount_minor, coupon_id, coupon_code, payment_provider)
select o.order_id, t.reader_a, 'pending', 'pending', 'VN', 'VND', 103200, 129000, 25800,
       'e6000000-0000-0000-0000-000000000001', 'PAYEVENT20', 'simulator'
from t_orders o, t_ids t;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select o.order_id, 'e5000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'S8 Pay Event Book', 129000, 1
from t_orders o;

insert into public.payments (order_id, provider, status, amount_minor, currency)
select o.order_id, 'simulator', 'pending', 103200, 'VND'
from t_orders o;

insert into public.coupon_redemptions (coupon_id, order_id, profile_id, discount_minor, status)
select 'e6000000-0000-0000-0000-000000000001', o.order_id, t.reader_a, 25800, 'reserved'
from t_orders o, t_ids t;

select lives_ok(
  $$select public.apply_payment_event('simulator', 's8-ev-1', (select order_id from t_orders where label = 'order-1'), 'ext-1', 'succeeded', 103200, 'VND', now())$$,
  'a successful event on a discounted order is applied');
select is(
  (select r.status from public.coupon_redemptions r where r.order_id = (select order_id from t_orders where label = 'order-1')),
  'redeemed',
  'completion redeems the reservation');
select isnt(
  (select r.redeemed_at from public.coupon_redemptions r where r.order_id = (select order_id from t_orders where label = 'order-1')),
  null,
  'redemption is stamped');

select lives_ok(
  $$select public.apply_payment_event('simulator', 's8-ev-2', (select order_id from t_orders where label = 'order-2'), 'ext-2', 'cancelled', 103200, 'VND', now())$$,
  'a cancellation is applied');
select is(
  (select count(*) from public.coupon_redemptions r where r.order_id = (select order_id from t_orders where label = 'order-2')),
  0::bigint,
  'cancellation releases the reservation');

-- A failed payment leaves the order pending, so the code stays reserved for the retry.
select public.apply_payment_event('simulator', 's8-ev-3', (select order_id from t_orders where label = 'order-3'), 'ext-3', 'failed', 103200, 'VND', now());
select is(
  (select r.status from public.coupon_redemptions r where r.order_id = (select order_id from t_orders where label = 'order-3')),
  'reserved',
  'a failed payment keeps the reservation, so the reader can pay again');

select * from finish();
rollback;
