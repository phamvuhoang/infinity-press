begin;
select plan(34);

-- S9: coupon scope across bundle orders, and the multi-book zero-total grant (spec 8).
--
-- The scope matrix spec 8 states is four rules, and each one is asserted from BOTH sides here -
-- the subject it names and the subject it does not - because the failure that matters is never
-- "the coupon did not apply", it is "the coupon applied to something it was never scoped to":
--
--   no coupon_books and no coupon_bundles rows -> applies to everything
--   only coupon_books rows                     -> does NOT apply to a bundle order
--   coupon_bundles rows                        -> apply to those bundles, and to no single book
--   both                                       -> apply to the named book and the named bundle
--
-- Scope is resolved from orders.bundle_id, never from the order's member books: a coupon scoped to
-- one book of a bundle must not discount the whole bundle, which is the defect the third and
-- fourth blocks below exist to catch.
--
-- The zero-total block is the multi-book half: a 100%-off code on a three-book bundle must grant
-- every book the buyer is missing, leave the one they already own exactly as it was, flip ONE
-- redemption for the order rather than one per line, and return the whole set.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-coupon-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-coupon-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-coupon-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000003';

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000002') as reader_b,
  (select id from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000003') as admin_id;
grant select on t_ids to public;

-- Every application is captured rather than asserted on in flight: one order can take only one
-- coupon, so a second call against the same order would raise EB024 instead of returning the row a
-- second assertion wanted to read.
create temporary table t_result (
  label text primary key,
  subtotal_minor bigint,
  discount_minor bigint,
  total_minor bigint,
  order_status public.order_status,
  entitlement_ids uuid[],
  rejection text
);
grant select, insert on t_result to public;

-- Holds the ids admin_create_coupon generates inside itself.
create temporary table t_coupons (label text primary key, id uuid);
grant select, insert on t_coupons to public;

insert into public.authors (id, canonical_slug, display_name)
values ('e3000000-0000-0000-0000-000000000001', 's9-coupon-author', 'S9 Coupon Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('e2000000-0000-0000-0000-000000000001', 's9-coupon-book-1', 'vi', 'e3000000-0000-0000-0000-000000000001'),
  ('e2000000-0000-0000-0000-000000000002', 's9-coupon-book-2', 'vi', 'e3000000-0000-0000-0000-000000000001'),
  ('e2000000-0000-0000-0000-000000000003', 's9-coupon-book-3', 'vi', 'e3000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values
  ('e4000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 'vi'),
  ('e4000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'vi'),
  ('e4000000-0000-0000-0000-000000000003', 'e2000000-0000-0000-0000-000000000003', 'vi');
insert into public.skus (id, edition_id, sku_code) values
  ('e5000000-0000-0000-0000-000000000001', 'e4000000-0000-0000-0000-000000000001', 's9-coupon-sku-1'),
  ('e5000000-0000-0000-0000-000000000002', 'e4000000-0000-0000-0000-000000000002', 's9-coupon-sku-2'),
  ('e5000000-0000-0000-0000-000000000003', 'e4000000-0000-0000-0000-000000000003', 's9-coupon-sku-3');

-- Two bundles, so "applies to the bundle it names" and "refuses the bundle it does not" are
-- different rows rather than the same one read twice.
insert into public.bundles (id, status) values
  ('e8000000-0000-0000-0000-000000000001', 'published'),
  ('e8000000-0000-0000-0000-000000000002', 'published');
insert into public.bundle_localizations (bundle_id, locale, slug, title) values
  ('e8000000-0000-0000-0000-000000000001', 'vi', 's9-coupon-bundle-one', 'Bundle One'),
  ('e8000000-0000-0000-0000-000000000002', 'vi', 's9-coupon-bundle-two', 'Bundle Two');
insert into public.bundle_editions (bundle_id, edition_id, position)
select v.bundle_id::uuid, (select e.id from public.editions e where e.book_id = v.book_id::uuid order by e.id limit 1), v.position
from (values
  ('e8000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000001', 1),
  ('e8000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', 2),
  ('e8000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000003', 3),
  ('e8000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 1)) as v(bundle_id, book_id, position);

-- The four scope shapes, plus the 100%-off bundle code. All percent codes, so no currency branch
-- is involved and a rejection can only be about scope.
insert into public.coupons (id, code, kind, percent_off, active, max_redemptions_per_profile) values
  ('e6000000-0000-0000-0000-000000000001', 'GLOBALC', 'percent', 20, true, 5),
  ('e6000000-0000-0000-0000-000000000002', 'BOOKONLY', 'percent', 20, true, 5),
  ('e6000000-0000-0000-0000-000000000003', 'BUNDLEONLY', 'percent', 20, true, 5),
  ('e6000000-0000-0000-0000-000000000004', 'MIXEDSCOPE', 'percent', 20, true, 5),
  ('e6000000-0000-0000-0000-000000000005', 'FREEBUNDLE', 'percent', 100, true, 5);

-- BOOKONLY names book 1, which is a MEMBER of bundle one. That is the whole point: a code scoped
-- to one member must not discount the bundle that contains it.
insert into public.coupon_books (coupon_id, book_id) values
  ('e6000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000001'),
  ('e6000000-0000-0000-0000-000000000004', 'e2000000-0000-0000-0000-000000000001');
insert into public.coupon_bundles (coupon_id, bundle_id) values
  ('e6000000-0000-0000-0000-000000000003', 'e8000000-0000-0000-0000-000000000001'),
  ('e6000000-0000-0000-0000-000000000004', 'e8000000-0000-0000-0000-000000000001'),
  ('e6000000-0000-0000-0000-000000000005', 'e8000000-0000-0000-0000-000000000001');

-- Orders. `bundle` names the bundle an order was placed for, or null for a single-book order;
-- `book` is the single book of a single-book order.
create temporary table t_orders (id uuid, owner text, bundle_id uuid, book_id uuid, amount bigint);
insert into t_orders values
  ('e7000000-0000-0000-0000-000000000001', 'a', null, 'e2000000-0000-0000-0000-000000000001', 129000),
  ('e7000000-0000-0000-0000-000000000002', 'a', 'e8000000-0000-0000-0000-000000000001', null, 300000),
  ('e7000000-0000-0000-0000-000000000003', 'a', 'e8000000-0000-0000-0000-000000000001', null, 300000),
  ('e7000000-0000-0000-0000-000000000004', 'a', null, 'e2000000-0000-0000-0000-000000000001', 129000),
  ('e7000000-0000-0000-0000-000000000005', 'a', 'e8000000-0000-0000-0000-000000000001', null, 300000),
  ('e7000000-0000-0000-0000-000000000006', 'a', null, 'e2000000-0000-0000-0000-000000000001', 129000),
  ('e7000000-0000-0000-0000-000000000007', 'a', 'e8000000-0000-0000-0000-000000000002', null, 200000),
  ('e7000000-0000-0000-0000-000000000008', 'a', null, 'e2000000-0000-0000-0000-000000000001', 129000),
  ('e7000000-0000-0000-0000-000000000009', 'a', 'e8000000-0000-0000-0000-000000000001', null, 300000),
  ('e7000000-0000-0000-0000-0000000000a0', 'a', null, 'e2000000-0000-0000-0000-000000000002', 129000),
  ('e7000000-0000-0000-0000-0000000000a1', 'a', 'e8000000-0000-0000-0000-000000000002', null, 200000),
  ('e7000000-0000-0000-0000-0000000000b1', 'b', 'e8000000-0000-0000-0000-000000000001', null, 300000);

insert into public.orders (id, profile_id, bundle_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider, title_snapshot)
select o.id, case when o.owner = 'b' then t.reader_b else t.reader_a end, o.bundle_id,
       'pending', 'pending', 'VN', 'VND', o.amount, o.amount, 'simulator',
       case when o.bundle_id is null then null else 'Bundle One' end
from t_orders o, t_ids t;

-- The book/sku pairs, so the order lines below can be built by member number.
create temporary table t_books (n int primary key, book_id uuid, sku_id uuid);
insert into t_books values
  (1, 'e2000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001'),
  (2, 'e2000000-0000-0000-0000-000000000002', 'e5000000-0000-0000-0000-000000000002'),
  (3, 'e2000000-0000-0000-0000-000000000003', 'e5000000-0000-0000-0000-000000000003');

-- A single-book order carries one line at position 1 that holds the whole price.
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity, position)
select o.id, b.sku_id, b.book_id, 'S9 Coupon Book ' || b.n::text, o.amount, 1, 1
from t_orders o
join t_books b on b.book_id = o.book_id
where o.bundle_id is null;

-- Bundle one's orders carry three lines. The price sits on POSITION 2, not position 1: that is the
-- shape create_bundle_order produces whenever the position-1 member is unpublished, and nothing
-- downstream may assume the price line is position 1.
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity, position)
select o.id, b.sku_id, b.book_id, 'S9 Coupon Book ' || b.n::text,
       case when b.n = 2 then o.amount else 0 end, 1, b.n
from t_orders o, t_books b
where o.bundle_id = 'e8000000-0000-0000-0000-000000000001';

-- Bundle two holds one book, so its orders are single-line but still bundle orders.
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity, position)
select o.id, 'e5000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000002', 'S9 Coupon Book 2', o.amount, 1, 1
from t_orders o
where o.bundle_id = 'e8000000-0000-0000-0000-000000000002';

insert into public.payments (order_id, provider, status, amount_minor, currency)
select o.id, 'simulator', 'pending', o.amount, 'VND' from t_orders o;

-- Reader B already owns book 1 of bundle one, from an admin grant rather than an order: the
-- zero-total branch must resolve that existing entitlement by subject and add nothing beside it.
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select t.reader_b, 'e2000000-0000-0000-0000-000000000001', 'admin_grant', t.admin_id, 'reviewer copy', 'active' from t_ids t;
insert into public.library_items (profile_id, book_id, entitlement_id)
select t.reader_b, 'e2000000-0000-0000-0000-000000000001', e.id
from t_ids t
join public.entitlements e on e.profile_id = t.reader_b and e.book_id = 'e2000000-0000-0000-0000-000000000001';

-- ============================================================================================
-- The scope matrix, as reader A.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);

insert into t_result select 'global-book', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000001', 'GLOBALC');
insert into t_result select 'global-bundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000002', 'GLOBALC');
insert into t_result select 'bookonly-bundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000003', 'BOOKONLY');
insert into t_result select 'bookonly-book', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000004', 'BOOKONLY');
insert into t_result select 'bundleonly-bundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000005', 'BUNDLEONLY');
insert into t_result select 'bundleonly-book', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000006', 'BUNDLEONLY');
insert into t_result select 'bundleonly-other', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000007', 'BUNDLEONLY');
insert into t_result select 'mixed-book', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000008', 'MIXEDSCOPE');
insert into t_result select 'mixed-bundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-000000000009', 'MIXEDSCOPE');
insert into t_result select 'mixed-otherbook', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-0000000000a0', 'MIXEDSCOPE');
insert into t_result select 'mixed-otherbundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-0000000000a1', 'MIXEDSCOPE');

-- (1)-(2) An unscoped code applies to both kinds of order.
select is((select r.rejection from t_result r where r.label = 'global-book'), null,
  'a coupon with no scope rows applies to a single-book order');
select is((select r.rejection from t_result r where r.label = 'global-bundle'), null,
  'a coupon with no scope rows applies to a bundle order');

-- (3)-(6) coupon_books rows only. A bundle order is refused even though the named book is one of
-- its members, and the refusal is the same uniform 'invalid' every other refusal returns.
select is((select r.rejection from t_result r where r.label = 'bookonly-bundle'), 'invalid',
  'a coupon scoped to books only does not apply to a bundle order');
select is((select r.total_minor from t_result r where r.label = 'bookonly-bundle'), 300000::bigint,
  'the refused bundle order keeps its own total');
select is((select o.coupon_id from public.orders o where o.id = 'e7000000-0000-0000-0000-000000000003'), null,
  'and the refused bundle order takes no coupon');
select is((select r.rejection from t_result r where r.label = 'bookonly-book'), null,
  'the same book-scoped coupon still applies to a single-book order for that book');

-- (7)-(9) coupon_bundles rows only.
select is((select r.rejection from t_result r where r.label = 'bundleonly-bundle'), null,
  'a coupon scoped to a bundle applies to an order for that bundle');
select is((select r.rejection from t_result r where r.label = 'bundleonly-book'), 'invalid',
  'a coupon scoped to bundles only does not apply to a single-book order');
select is((select r.rejection from t_result r where r.label = 'bundleonly-other'), 'invalid',
  'a coupon scoped to one bundle does not apply to another bundle');

-- (10)-(13) Both kinds of scope row on one coupon.
select is((select r.rejection from t_result r where r.label = 'mixed-book'), null,
  'a mixed-scope coupon applies to the book it names');
select is((select r.rejection from t_result r where r.label = 'mixed-bundle'), null,
  'a mixed-scope coupon applies to the bundle it names');
select is((select r.rejection from t_result r where r.label = 'mixed-otherbook'), 'invalid',
  'a mixed-scope coupon refuses a book it does not name');
select is((select r.rejection from t_result r where r.label = 'mixed-otherbundle'), 'invalid',
  'a mixed-scope coupon refuses a bundle it does not name');

-- (14)-(15) The discount itself still lands on a bundle order, and an application that leaves
-- something to pay grants nothing.
select is((select r.total_minor from t_result r where r.label = 'global-bundle'), 240000::bigint,
  '20% off a 300000 bundle order leaves 240000');
select is((select r.entitlement_ids from t_result r where r.label = 'global-bundle'), array[]::uuid[],
  'an application that leaves a balance returns an empty entitlement array, not null');

-- (16) Every scope refusal spent one attempt from the reader's quota, exactly as an unknown code
-- does - the S8 rate limit is unchanged. coupon_attempts is granted to nobody, so it is read back
-- as the owner.
reset role;
select is((select a.failure_count from public.coupon_attempts a where a.profile_id = (select reader_a from t_ids)),
  5, 'each of the five scope refusals recorded one failed attempt');

-- ============================================================================================
-- A 100%-off bundle code, as reader B, who already owns book 1 of the three.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000002', true);

insert into t_result select 'free-bundle', * from public.apply_coupon_to_order('e7000000-0000-0000-0000-0000000000b1', 'FREEBUNDLE');

-- (17)-(19)
select is((select r.rejection from t_result r where r.label = 'free-bundle'), null,
  'a 100%-off bundle code applies');
select is((select r.total_minor from t_result r where r.label = 'free-bundle'), 0::bigint,
  'and takes the whole bundle price');
select is((select r.order_status from t_result r where r.label = 'free-bundle'), 'completed'::public.order_status,
  'a zero-total bundle order completes inside the same call');

-- (20)-(22) The array covers every book of the bundle, including the one the reader already held.
select is((select cardinality(r.entitlement_ids) from t_result r where r.label = 'free-bundle'), 3,
  'the call returns one entitlement per book of the bundle');
select ok(
  (select (select e.id from public.entitlements e
           where e.profile_id = (select reader_b from t_ids)
             and e.book_id = 'e2000000-0000-0000-0000-000000000001') = any(r.entitlement_ids)
   from t_result r where r.label = 'free-bundle'),
  'the entitlement the reader already held is resolved by subject and returned, not re-granted');
select is(
  (select cardinality(r.entitlement_ids) from t_result r where r.label = 'free-bundle'),
  (select count(distinct id)::int from t_result r, unnest(r.entitlement_ids) as u(id) where r.label = 'free-bundle'),
  'and the array holds no duplicate id');

-- (23)-(26) One entitlement and one library row per MISSING book; the pre-owned book keeps the
-- single grant it already had.
reset role;
select is((select count(*) from public.entitlements e
           where e.profile_id = (select reader_b from t_ids) and e.status = 'active'),
  3::bigint, 'the reader ends with exactly three active entitlements');
select is((select count(*) from public.entitlements e
           where e.profile_id = (select reader_b from t_ids)
             and e.book_id = 'e2000000-0000-0000-0000-000000000001'),
  1::bigint, 'the pre-owned book has no second entitlement row of any status');
select is((select e.source_type::text from public.entitlements e
           where e.profile_id = (select reader_b from t_ids)
             and e.book_id = 'e2000000-0000-0000-0000-000000000001'),
  'admin_grant', 'and the pre-owned entitlement is left exactly as it was');
select is((select count(*) from public.entitlements e where e.source_order_id = 'e7000000-0000-0000-0000-0000000000b1'),
  2::bigint, 'only the two books the reader was missing were granted by the order');

-- (27)-(28)
select is((select count(*) from public.library_items li where li.profile_id = (select reader_b from t_ids)),
  3::bigint, 'the reader has one library item per book, with no duplicate for the pre-owned one');
select is((select count(*) from public.coupon_redemptions r
           where r.order_id = 'e7000000-0000-0000-0000-0000000000b1' and r.status = 'redeemed'),
  1::bigint, 'the order flips exactly ONE redemption, not one per line');

-- (29)-(30) The rest of the S8 completion contract on a bundle order.
select is((select o.status::text || '/' || o.payment_status::text from public.orders o
           where o.id = 'e7000000-0000-0000-0000-0000000000b1'),
  'completed/not_required', 'the bundle order completes with payment_status not_required');
select is((select pay.status::text from public.payments pay where pay.order_id = 'e7000000-0000-0000-0000-0000000000b1'),
  'cancelled', 'and its pending payment is cancelled rather than left waiting');

-- ============================================================================================
-- The admin surface carries bundle scope of its own.
-- ============================================================================================
-- (31) anon holds no EXECUTE on the new signature.
select is(
  has_function_privilege('anon', 'public.admin_create_coupon(text, text, int, bigint, text, timestamptz, timestamptz, int, int, text, uuid[], uuid[])', 'EXECUTE'),
  false, 'anon holds no EXECUTE on admin_create_coupon');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000003', true);

insert into t_coupons (label, id)
select 'scoped', public.admin_create_coupon('BUNDLESCOPE', 'percent', 15, null, null, null, null, null, 1, null,
  '{}'::uuid[], array['e8000000-0000-0000-0000-000000000001']::uuid[]);

-- (32)-(34) Bundle scope round-trips, is never inferred from the bundle's member books, and can be
-- replaced by an update.
select is(
  (select g.bundle_ids from public.admin_get_coupon((select id from t_coupons where label = 'scoped')) g),
  array['e8000000-0000-0000-0000-000000000001']::uuid[],
  'the bundle scope round-trips through admin_get_coupon');
select is(
  (select g.book_ids from public.admin_get_coupon((select id from t_coupons where label = 'scoped')) g),
  array[]::uuid[],
  'and no book scope is inferred from the bundle''s member books');
select lives_ok(
  format($$select public.admin_update_coupon(%L, 'percent', 15, null, null, null, null, true, null, 1, null, '{}'::uuid[], array['e8000000-0000-0000-0000-000000000002']::uuid[])$$,
    (select id from t_coupons where label = 'scoped')),
  'an update replaces the bundle scope');

reset role;
select * from finish();
rollback;
