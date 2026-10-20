-- S9: one order, several books (spec 5).
--
-- Until this change an order held exactly one book, and apply_payment_event resolved it with
-- `select oi.book_id ... limit 1`. Every assertion here is about the assumption that removed:
-- a paid order grants one entitlement and one library item PER order item, and the function
-- reports all of them, in a deterministic order, on every path that returns at all - success,
-- replay, and a late event against an order that has already left 'pending'.
--
-- The arrays are pinned against the rows that now exist rather than against literals, because
-- the property under test is "every book of this order, and nothing else" - a literal list would
-- pass just as well if the function returned somebody else's entitlements.
begin;
select plan(26);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-multi-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-multi-buyer-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's9-multi-buyer-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 's9-multi-buyer-c@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 's9-multi-buyer-d@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'd0000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = 'd0000000-0000-0000-0000-000000000002') as buyer_a_id,
  (select id from public.profiles where auth_user_id = 'd0000000-0000-0000-0000-000000000003') as buyer_b_id,
  (select id from public.profiles where auth_user_id = 'd0000000-0000-0000-0000-000000000004') as buyer_c_id,
  (select id from public.profiles where auth_user_id = 'd0000000-0000-0000-0000-000000000005') as buyer_d_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name)
values ('d3000000-0000-0000-0000-000000000001', 's9-multi-author', 'S9 Multi Author');

insert into public.books (id, canonical_key, original_language, primary_author_id)
select ('d1000000-0000-0000-0000-00000000000' || n)::uuid, 's9-multi-book-' || n, 'vi', 'd3000000-0000-0000-0000-000000000001'
from generate_series(1, 3) as n;
insert into public.editions (id, book_id, language_code)
select ('d4000000-0000-0000-0000-00000000000' || n)::uuid, ('d1000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 3) as n;
insert into public.skus (id, edition_id, sku_code)
select ('d5000000-0000-0000-0000-00000000000' || n)::uuid, ('d4000000-0000-0000-0000-00000000000' || n)::uuid, 's9-multi-sku-' || n
from generate_series(1, 3) as n;

-- Two three-book orders, one per buyer, so buyer A's revocation at the end cannot be confused
-- with buyer B's pre-owned scenario. Both default to the 'simulator' provider.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select 'd6000000-0000-0000-0000-000000000001'::uuid, buyer_a_id, 'pending'::public.order_status,
       'pending'::public.payment_status, 'VN', 'VND', 300000 from t_ids
union all
select 'd6000000-0000-0000-0000-000000000002'::uuid, buyer_b_id, 'pending'::public.order_status,
       'pending'::public.payment_status, 'VN', 'VND', 300000 from t_ids
union all
select 'd6000000-0000-0000-0000-000000000003'::uuid, buyer_c_id, 'pending'::public.order_status,
       'pending'::public.payment_status, 'VN', 'VND', 300000 from t_ids;

-- Buyer D's order is booked under the manual provider, so it goes through confirm_manual_payment
-- rather than a simulator event. Two books, so the revocation below is a multi-book one.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select 'd6000000-0000-0000-0000-000000000004'::uuid, buyer_d_id, 'pending'::public.order_status,
       'pending'::public.payment_status, 'VN', 'VND', 200000, 'manual' from t_ids;
insert into public.payments (order_id, provider, status, amount_minor, currency)
values ('d6000000-0000-0000-0000-000000000004', 'manual', 'pending', 200000, 'VND');

-- 20260924110000 gave order_items a position that is unique within the order, so a hand-built
-- multi-item order has to state one. n is already the item's place in the order.
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
select o.id::uuid, ('d5000000-0000-0000-0000-00000000000' || n)::uuid, ('d1000000-0000-0000-0000-00000000000' || n)::uuid,
       'S9 Multi Book ' || n, 100000, n
from (values ('d6000000-0000-0000-0000-000000000001'), ('d6000000-0000-0000-0000-000000000002'),
             ('d6000000-0000-0000-0000-000000000003')) as o(id),
     generate_series(1, 3) as n;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, position)
select 'd6000000-0000-0000-0000-000000000004', ('d5000000-0000-0000-0000-00000000000' || n)::uuid,
       ('d1000000-0000-0000-0000-00000000000' || n)::uuid, 'S9 Multi Book ' || n, 100000, n
from generate_series(1, 2) as n;

-- ============================================================================================
-- A succeeded event on a three-book order.
-- ============================================================================================
set local role service_role;
create temporary table t_a as
select * from public.apply_payment_event(
  'simulator', 's9-multi-success', 'd6000000-0000-0000-0000-000000000001',
  's9-payment', 'succeeded', 300000, 'VND', now()
);
reset role;
grant select on t_a to public;

-- (1)
select results_eq(
  $$select cardinality(entitlement_ids), order_status::text, payment_status::text from t_a$$,
  $$values (3, 'completed', 'succeeded')$$,
  'success returns every current active entitlement for the order books'
);
-- (2)
select is(
  (select count(*)::int from public.entitlements where source_order_id = 'd6000000-0000-0000-0000-000000000001'),
  3,
  'one entitlement is created per order item'
);
-- (3)
select is(
  (select count(*)::int from public.library_items li, t_ids
   where li.profile_id = t_ids.buyer_a_id and li.book_id in (
     'd1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002',
     'd1000000-0000-0000-0000-000000000003')),
  3,
  'every order book reaches the library'
);
-- (4) The array is the buyer's active entitlements for this order's books, in book order - not an
-- arbitrary insertion order, so a caller may rely on it.
select results_eq(
  $$select entitlement_ids from t_a$$,
  $$select array_agg(e.id order by e.book_id) from public.entitlements e, t_ids
    where e.profile_id = t_ids.buyer_a_id and e.status = 'active'$$,
  'the returned array is every active entitlement, ordered by book'
);
-- (5) Each entitlement carries this order and the provider's source type.
select is(
  (select count(*)::int from public.entitlements e
   where e.source_order_id = 'd6000000-0000-0000-0000-000000000001' and e.source_type = 'simulated_payment'),
  3,
  'every entitlement is simulated_payment-sourced from this order'
);

-- ============================================================================================
-- Replay: the same event id again returns the same array and writes nothing.
-- ============================================================================================
set local role service_role;
create temporary table t_a_replay as
select * from public.apply_payment_event(
  'simulator', 's9-multi-success', 'd6000000-0000-0000-0000-000000000001',
  's9-payment', 'succeeded', 300000, 'VND', now()
);
reset role;
grant select on t_a_replay to public;

-- (6)
select is((select entitlement_ids from t_a_replay), (select entitlement_ids from t_a),
  'a replayed event returns the same array');
-- (7)
select is(
  (select count(*)::int from public.payment_events where provider = 'simulator' and provider_event_id = 's9-multi-success'),
  1,
  'the replay recorded no second payment event');
-- (8)
select is(
  (select count(*)::int from public.entitlements where source_order_id = 'd6000000-0000-0000-0000-000000000001'),
  3,
  'the replay granted nothing further');

-- ============================================================================================
-- A late event against the now-completed order: recorded, but it neither resurrects nor re-derives.
-- ============================================================================================
set local role service_role;
create temporary table t_a_late as
select * from public.apply_payment_event(
  'simulator', 's9-multi-late-cancel', 'd6000000-0000-0000-0000-000000000001',
  's9-payment', 'cancelled', 300000, 'VND', now()
);
reset role;
grant select on t_a_late to public;

-- (9)
select results_eq(
  $$select cardinality(entitlement_ids), order_status::text, payment_status::text from t_a_late$$,
  $$values (3, 'completed', 'succeeded')$$,
  'a late event reports the recorded outcome and every current entitlement');
-- (10)
select is((select entitlement_ids from t_a_late), (select entitlement_ids from t_a),
  'the late event returns the same array');
-- (11)
select is(
  (select count(*)::int from public.entitlements where source_order_id = 'd6000000-0000-0000-0000-000000000001'),
  3,
  'the late event inserted no entitlement');

-- ============================================================================================
-- A buyer who already owns one member book. The array still names all three current entitlements,
-- but only the two this order actually minted point back at it.
-- ============================================================================================
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select buyer_b_id, 'd1000000-0000-0000-0000-000000000002', 'admin_grant', admin_id, 'Pre-owned', 'active' from t_ids;
insert into public.library_items (profile_id, book_id, entitlement_id)
select e.profile_id, e.book_id, e.id from public.entitlements e, t_ids
where e.profile_id = t_ids.buyer_b_id and e.source_type = 'admin_grant';

set local role service_role;
create temporary table t_b as
select * from public.apply_payment_event(
  'simulator', 's9-multi-preowned', 'd6000000-0000-0000-0000-000000000002',
  's9-payment-b', 'succeeded', 300000, 'VND', now()
);
reset role;
grant select on t_b to public;

-- (12)
select is((select cardinality(entitlement_ids) from t_b), 3,
  'a pre-owned member still yields an array of every order book');
-- (13)
select is(
  (select count(*)::int from public.entitlements where source_order_id = 'd6000000-0000-0000-0000-000000000002'),
  2,
  'the pre-owned book mints no second entitlement');
-- (14) Including the pre-owned admin_grant row, resolved by subject the way a single-book order
-- already resolved it.
select results_eq(
  $$select entitlement_ids from t_b$$,
  $$select array_agg(e.id order by e.book_id) from public.entitlements e, t_ids
    where e.profile_id = t_ids.buyer_b_id and e.status = 'active'$$,
  'the array carries the pre-owned entitlement alongside the two new ones');

-- ============================================================================================
-- Revoking a three-book order.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
create temporary table t_revoke as
select public.revoke_order_entitlement('d6000000-0000-0000-0000-000000000001', 'Chargeback') as entitlement_ids;
reset role;
grant select on t_revoke to public;

-- (15)
select is((select entitlement_ids from t_revoke), (select entitlement_ids from t_a),
  'revocation returns every entitlement the order granted');
-- (16)
select is(
  (select count(*)::int from public.entitlements
   where source_order_id = 'd6000000-0000-0000-0000-000000000001' and status = 'revoked' and revoked_at is not null),
  3,
  'all three entitlements are revoked');
-- (17)
select is(
  (select count(*)::int from public.library_items li
   where li.entitlement_id in (select unnest(entitlement_ids) from t_revoke)),
  0,
  'every matching library row is deleted');
-- (18)
select is(
  (select count(*)::int from public.audit_logs
   where action = 'revoke_order_entitlement' and entity_id = 'd6000000-0000-0000-0000-000000000001'),
  1,
  'one audit row covers the whole order');
-- (19)
select results_eq(
  $$select metadata -> 'entitlement_ids' from public.audit_logs
    where action = 'revoke_order_entitlement' and entity_id = 'd6000000-0000-0000-0000-000000000001'$$,
  $$select to_jsonb((select entitlement_ids from t_revoke))$$,
  'the audit row names every revoked entitlement');

-- ============================================================================================
-- Every member book already owned. This is where the success branch's `on conflict ... do nothing`
-- falls through to its resolve-by-subject lookup on EVERY iteration rather than on one of three,
-- so the order mints nothing at all and the array is built entirely from rows it did not create.
-- ============================================================================================
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select buyer_c_id, ('d1000000-0000-0000-0000-00000000000' || n)::uuid, 'admin_grant', admin_id, 'Pre-owned', 'active'
from t_ids, generate_series(1, 3) as n;
insert into public.library_items (profile_id, book_id, entitlement_id)
select e.profile_id, e.book_id, e.id from public.entitlements e, t_ids where e.profile_id = t_ids.buyer_c_id;

set local role service_role;
create temporary table t_c as
select * from public.apply_payment_event(
  'simulator', 's9-multi-all-preowned', 'd6000000-0000-0000-0000-000000000003',
  's9-payment-c', 'succeeded', 300000, 'VND', now()
);
reset role;
grant select on t_c to public;

-- (20)
select results_eq(
  $$select cardinality(entitlement_ids), order_status::text, payment_status::text from t_c$$,
  $$values (3, 'completed', 'succeeded')$$,
  'an order whose every book is already owned still reports all three entitlements');
-- (21)
select is(
  (select count(*)::int from public.entitlements where source_order_id = 'd6000000-0000-0000-0000-000000000003'),
  0,
  'an order whose every book is already owned mints no entitlement');
-- (22)
select results_eq(
  $$select entitlement_ids from t_c$$,
  $$select array_agg(e.id order by e.book_id) from public.entitlements e, t_ids
    where e.profile_id = t_ids.buyer_c_id and e.status = 'active'$$,
  'the array is built entirely from the entitlements the buyer already held');

-- ============================================================================================
-- A confirmed bank transfer can be revoked. Regression for the order-backed source set: until this
-- change revoke_order_entitlement matched only ('free_order', 'simulated_payment'), so a
-- manual_payment entitlement - order-backed since S7, by entitlements_source_consistency - raised
-- P0002 as though the order had granted nothing, and a confirmed transfer was unrevokable.
-- ============================================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
create temporary table t_manual as
select * from public.confirm_manual_payment('d6000000-0000-0000-0000-000000000004', 200000, 'VCB-S9', null, false);
reset role;
grant select on t_manual to public;

-- (23)
select results_eq(
  $$select cardinality(entitlement_ids), order_status::text, payment_status::text from t_manual$$,
  $$values (2, 'completed', 'succeeded')$$,
  'confirming a two-book manual order grants both books');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd0000000-0000-0000-0000-000000000001', true);
create temporary table t_manual_revoke as
select public.revoke_order_entitlement('d6000000-0000-0000-0000-000000000004', 'Transfer reversed') as entitlement_ids;
reset role;
grant select on t_manual_revoke to public;

-- (24)
select is((select entitlement_ids from t_manual_revoke), (select entitlement_ids from t_manual),
  'a manual order''s entitlements can be revoked at all, and every one is returned');
-- (25)
select is(
  (select count(*)::int from public.entitlements
   where source_order_id = 'd6000000-0000-0000-0000-000000000004' and status = 'revoked'),
  2,
  'both manual_payment entitlements are revoked');
-- (26)
select is(
  (select count(*)::int from public.library_items li
   where li.entitlement_id in (select unnest(entitlement_ids) from t_manual_revoke)),
  0,
  'the manual order''s library rows are deleted too');

select * from finish();
rollback;
