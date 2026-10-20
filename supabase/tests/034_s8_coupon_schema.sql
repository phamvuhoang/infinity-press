begin;
select plan(20);

-- S8: the coupon schema and the order snapshot columns (spec 5.2).

-- A second reader who owns nothing here, and an admin, matching the house pattern in
-- 029_manual_payment_decisions.sql: without a second reader, coupon_redemptions_owner_select
-- would pass every assertion in this file even if it were `using (true)`, since the only reader in
-- the suite would be the owner of the one row under test.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's8-schema-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's8-schema-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's8-schema-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'a1000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = 'a1000000-0000-0000-0000-000000000002') as reader_b,
  (select id from public.profiles where auth_user_id = 'a1000000-0000-0000-0000-000000000003') as admin_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name) values ('a3000000-0000-0000-0000-000000000001', 's8-schema-author', 'S8 Schema Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values ('a2000000-0000-0000-0000-000000000001', 's8-schema-book', 'vi', 'a3000000-0000-0000-0000-000000000001');

-- Shape.
select has_table('public', 'coupons', 'coupons exists');
select has_table('public', 'coupon_books', 'coupon_books exists');
select has_table('public', 'coupon_redemptions', 'coupon_redemptions exists');
select col_not_null('public', 'orders', 'subtotal_minor', 'orders.subtotal_minor is not null');

-- The kind/value consistency constraint, both ways round.
select lives_ok(
  $$insert into public.coupons (id, code, kind, percent_off) values ('a4000000-0000-0000-0000-000000000001', 'TESTER-100', 'percent', 100)$$,
  'a percent coupon needs only percent_off');
select throws_ok(
  $$insert into public.coupons (code, kind, percent_off, amount_off_minor, currency) values ('MIXED-1', 'percent', 20, 1000, 'VND')$$,
  '23514', null, 'a percent coupon may not also carry an amount');
select throws_ok(
  $$insert into public.coupons (code, kind, amount_off_minor) values ('NOCUR-1', 'fixed', 1000)$$,
  '23514', null, 'a fixed coupon without a currency is refused');
select throws_ok(
  $$insert into public.coupons (code, kind, percent_off) values ('lower-1', 'percent', 20)$$,
  '23514', null, 'a lower-case code is refused: codes are stored upper-case');

-- The order snapshot constraint.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor)
select 'a6000000-0000-0000-0000-000000000001', t_ids.reader_a, 'pending', 'pending', 'VN', 'VND', 129000, 129000 from t_ids;

select throws_ok(
  $$update public.orders set discount_minor = 29000 where id = 'a6000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a discount that does not move the total is refused');
select lives_ok(
  $$update public.orders set discount_minor = 29000, total_minor = 100000 where id = 'a6000000-0000-0000-0000-000000000001'$$,
  'subtotal - discount = total is accepted');
select throws_ok(
  $$update public.orders set discount_minor = 200000, total_minor = -71000 where id = 'a6000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a discount larger than the subtotal is refused');
select throws_ok(
  $$update public.orders set coupon_id = 'a4000000-0000-0000-0000-000000000001' where id = 'a6000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a coupon id without a code snapshot is refused');
select throws_ok(
  $$update public.orders set coupon_code = 'TESTER-100' where id = 'a6000000-0000-0000-0000-000000000001'$$,
  '23514', null, 'a coupon code without a coupon id is refused - the pairing check both ways round');

-- A fresh row, isolated from the discount/total arithmetic above: discount_minor defaults to 0
-- and total_minor matches subtotal_minor exactly, so the only constraint a negative subtotal can
-- trip on its own terms is orders_subtotal_minor_check. (A negative subtotal also fails
-- orders_discount_minor_check, since discount_minor >= 0 can never be <= a negative subtotal - that
-- is a structural consequence of the two checks together, not a gap in this assertion: it still
-- pins down that subtotal_minor's own >= 0 bound is enforced, not merely implied by the others.)
select throws_ok(
  $$insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor)
    select 'a6000000-0000-0000-0000-000000000002', t_ids.reader_a, 'pending', 'pending', 'VN', 'VND', -1, -1 from t_ids$$,
  '23514', null, 'a negative subtotal is refused on its own');

-- One coupon per order is a unique constraint, not a convention.
insert into public.coupon_redemptions (coupon_id, order_id, profile_id, discount_minor, status)
select 'a4000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', t_ids.reader_a, 29000, 'reserved' from t_ids;
select throws_ok(
  $$insert into public.coupon_redemptions (coupon_id, order_id, profile_id, discount_minor, status)
    select 'a4000000-0000-0000-0000-000000000001', 'a6000000-0000-0000-0000-000000000001', t_ids.reader_a, 1, 'reserved' from t_ids$$,
  '23505', null, 'an order cannot carry two redemptions');

-- Nobody reads coupons through the Data API. Not a reader, and not an admin either: the admin
-- screens go through admin_list_coupons (20260923140000).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select 1 from public.coupons$$,
  '42501', null, 'a signed-in reader cannot read coupons at all');
select throws_ok(
  $$select 1 from public.coupon_books$$,
  '42501', null, 'a signed-in reader cannot read coupon_books at all');

-- coupon_redemptions is the opposite shape: owner and admin can each select, RLS returns zero rows
-- (not an error) for anyone else. The owning reader's session is already active from the block
-- above.
select is(
  (select count(*) from public.coupon_redemptions where order_id = 'a6000000-0000-0000-0000-000000000001'),
  1::bigint,
  'the owning reader reads their own coupon redemption');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*) from public.coupon_redemptions where order_id = 'a6000000-0000-0000-0000-000000000001'),
  0::bigint,
  'a different signed-in reader sees no rows - RLS filters rather than raising');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
select is(
  (select count(*) from public.coupon_redemptions where order_id = 'a6000000-0000-0000-0000-000000000001'),
  1::bigint,
  'an admin reads any coupon redemption');
reset role;

select * from finish();
rollback;
