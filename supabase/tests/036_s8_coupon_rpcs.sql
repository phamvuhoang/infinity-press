begin;
select plan(39);

-- S8: apply_coupon_to_order and remove_coupon_from_order (spec 5.4, 5.5, 6, and the spec 8 pgTAP
-- row). The discount cases here are the same table lib/commerce/coupon.test.ts runs: 20% of 129001
-- floors to 25800, 100% takes the whole subtotal, a fixed amount subtracts in the same currency, a
-- fixed amount larger than the subtotal clamps to it, and a fixed amount in another currency is
-- refused rather than converted.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's8-rpc-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's8-rpc-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000002') as reader_b;
grant select on t_ids to public;

-- The zero-total application below is read back field by field, so its result row is captured
-- rather than asserted on in flight: a second call would raise EB024 on an order that now carries
-- a coupon. Created here, by the owner, because the insert happens under `role authenticated`.
create temporary table t_free (
  subtotal_minor bigint,
  discount_minor bigint,
  total_minor bigint,
  order_status public.order_status,
  entitlement_ids uuid[],
  rejection text
);
grant select, insert on t_free to public;

insert into public.authors (id, canonical_slug, display_name) values ('c3000000-0000-0000-0000-000000000001', 's8-rpc-author', 'S8 RPC Author');
insert into public.books (id, canonical_key, original_language, primary_author_id) values
  ('c2000000-0000-0000-0000-000000000001', 's8-rpc-book', 'vi', 'c3000000-0000-0000-0000-000000000001'),
  ('c2000000-0000-0000-0000-000000000002', 's8-rpc-other', 'vi', 'c3000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code) values ('c4000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values ('c5000000-0000-0000-0000-000000000001', 'c4000000-0000-0000-0000-000000000001', 's8-rpc-sku');

-- Coupons: a 20% code, a 100% code, an expired code, a code scoped to the OTHER book, a USD fixed
-- code, a single-use code, a one-use-each code, an inactive code, a code whose window has not
-- opened yet, and two VND fixed codes - one that subtracts and one larger than the price, which is
-- the clamp.
insert into public.coupons (id, code, kind, percent_off, amount_off_minor, currency, active, starts_at, ends_at, max_redemptions, max_redemptions_per_profile) values
  ('c6000000-0000-0000-0000-000000000001', 'TWENTY', 'percent', 20, null, null, true, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000002', 'TESTER-100', 'percent', 100, null, null, true, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000003', 'GONE', 'percent', 20, null, null, true, null, now() - interval '1 day', null, 5),
  ('c6000000-0000-0000-0000-000000000004', 'OTHERBOOK', 'percent', 20, null, null, true, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000005', 'USDFIVE', 'fixed', null, 500, 'USD', true, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000006', 'LASTONE', 'percent', 20, null, null, true, null, null, 1, 5),
  ('c6000000-0000-0000-0000-000000000007', 'SLEEPING', 'percent', 20, null, null, false, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000008', 'VND29K', 'fixed', null, 29000, 'VND', true, null, null, null, 5),
  ('c6000000-0000-0000-0000-000000000009', 'VNDBIG', 'fixed', null, 500000, 'VND', true, null, null, null, 5),
  ('c6000000-0000-0000-0000-00000000000a', 'SOONISH', 'percent', 20, null, null, true, now() + interval '1 day', null, null, 5),
  ('c6000000-0000-0000-0000-00000000000b', 'ONEEACH', 'percent', 20, null, null, true, null, null, null, 1);
insert into public.coupon_books (coupon_id, book_id) values ('c6000000-0000-0000-0000-000000000004', 'c2000000-0000-0000-0000-000000000002');

-- Twelve pending orders for reader A and one for reader B, each with its order item and its
-- pending payment. All are 129_000 VND except order 6, which is 129_001 so the 20% floor has
-- something to round away.
create temporary table t_orders (id uuid, owner text, amount bigint);
insert into t_orders values
  ('c7000000-0000-0000-0000-000000000001', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000002', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000003', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000004', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000005', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000006', 'a', 129001),
  ('c7000000-0000-0000-0000-000000000007', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000008', 'a', 129000),
  ('c7000000-0000-0000-0000-000000000009', 'a', 129000),
  ('c7000000-0000-0000-0000-00000000000a', 'a', 129000),
  ('c7000000-0000-0000-0000-00000000000b', 'a', 129000),
  ('c7000000-0000-0000-0000-00000000000c', 'a', 129000),
  ('c7000000-0000-0000-0000-0000000000b1', 'b', 129000);

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, subtotal_minor, payment_provider)
select o.id, case when o.owner = 'b' then t.reader_b else t.reader_a end, 'pending', 'pending', 'VN', 'VND', o.amount, o.amount, 'simulator'
from t_orders o, t_ids t;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select o.id, 'c5000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000001', 'S8 RPC Book', o.amount, 1
from t_orders o;

insert into public.payments (order_id, provider, status, amount_minor, currency)
select o.id, 'simulator', 'pending', o.amount, 'VND' from t_orders o;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

-- A 20% code applies, writes the snapshot, moves the payment, and reserves exactly one use (1-5)
select is((select r.total_minor from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000001', 'twenty') r), 103200::bigint,
  'a 20% code on 129000 leaves 103200, and the code is matched case-insensitively');
select is((select o.discount_minor from public.orders o where o.id = 'c7000000-0000-0000-0000-000000000001'), 25800::bigint,
  'the discount is written to the order snapshot');
select is((select o.coupon_code from public.orders o where o.id = 'c7000000-0000-0000-0000-000000000001'), 'TWENTY',
  'the code is snapshotted onto the order');
-- payments and audit_logs are admin-only under RLS, so the two of them are read back as the owner
-- and the reader's session is restored afterwards.
reset role;
select is((select pay.amount_minor from public.payments pay where pay.order_id = 'c7000000-0000-0000-0000-000000000001'), 103200::bigint,
  'the pending payment follows the new total');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

select is((select count(*) from public.coupon_redemptions r where r.order_id = 'c7000000-0000-0000-0000-000000000001' and r.status = 'reserved'),
  1::bigint, 'applying a code reserves exactly one redemption');

-- A second coupon on one order is refused (6)
select throws_ok(
  $$select public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000001', 'TESTER-100')$$,
  'EB024', null, 'a second coupon on one order is refused');

-- Removal restores the order and releases the reservation (7-9)
select is((select r.total_minor from public.remove_coupon_from_order('c7000000-0000-0000-0000-000000000001') r), 129000::bigint,
  'removing the code restores the total');
select is((select count(*) from public.coupon_redemptions r where r.order_id = 'c7000000-0000-0000-0000-000000000001'), 0::bigint,
  'removing the code releases the reservation');
reset role;
select is((select pay.amount_minor from public.payments pay where pay.order_id = 'c7000000-0000-0000-0000-000000000001'), 129000::bigint,
  'the pending payment is restored too');

-- Both movements of the order's money are on the record (10-11)
select is((select count(*) from public.audit_logs a
           where a.entity_id = 'c7000000-0000-0000-0000-000000000001' and a.action = 'coupon.applied'),
  1::bigint, 'applying a code is audited');
select is((select count(*) from public.audit_logs a
           where a.entity_id = 'c7000000-0000-0000-0000-000000000001' and a.action = 'coupon.removed'),
  1::bigint, 'removing a code is audited');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

-- Every invalid code is rejected the same way, and none of them says why (12-18)
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'NOSUCHCODE') r), 'invalid', 'an unknown code is invalid');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'GONE') r), 'invalid', 'an expired code is invalid');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'SLEEPING') r), 'invalid', 'an inactive code is invalid');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'SOONISH') r), 'invalid', 'a code whose window has not opened is invalid');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'OTHERBOOK') r), 'invalid', 'a code scoped to another book is invalid');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'USDFIVE') r), 'invalid', 'a fixed code in another currency is invalid');
select is((select o.total_minor from public.orders o where o.id = 'c7000000-0000-0000-0000-000000000002'), 129000::bigint,
  'a rejected code leaves the order exactly as it was');

-- The global limit. LASTONE has max_redemptions = 1: reader A takes it, reader B cannot (19-20)
select is((select r.total_minor from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000003', 'LASTONE') r), 103200::bigint,
  'the last remaining use is taken by the first caller');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-0000000000b1', 'LASTONE') r), 'invalid',
  'the second caller finds the code exhausted');

-- Another reader's order is not reachable at all (21-22)
select throws_ok(
  $$select public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000002', 'TWENTY')$$,
  'EB024', null, 'another reader cannot apply a code to an order that is not theirs');
select throws_ok(
  $$select public.remove_coupon_from_order('c7000000-0000-0000-0000-000000000003')$$,
  'EB024', null, 'another reader cannot remove a code from an order that is not theirs');

-- The lock that makes the limit true under concurrency. pgTAP is one session and one transaction,
-- so two simultaneous callers cannot be staged here; what CAN be asserted is the property the
-- serialized case above relies on - that the coupon row is locked before either limit is counted
-- (23)
select matches(
  (select pg_get_functiondef(p.oid) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'apply_coupon_to_order'),
  'from public\.coupons c\s+where c\.code = v_code\s+for update;'
  '.*select count\(\*\) into v_used from public\.coupon_redemptions'
  '.*select count\(\*\) into v_used_by_profile',
  'the coupon row is locked before either limit is counted, so two sessions serialize on it');

-- A 100% code completes the order in the same call (24-28)
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select is((select cardinality(r.entitlement_ids) from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000004', 'TESTER-100') r), 1,
  'a fully discounted single-book order returns the one entitlement it granted');
select is((select o.status::text || '/' || o.payment_status::text from public.orders o where o.id = 'c7000000-0000-0000-0000-000000000004'),
  'completed/not_required', 'a fully discounted order completes with payment_status not_required');
select is((select count(*) from public.entitlements e where e.source_order_id = 'c7000000-0000-0000-0000-000000000004' and e.status = 'active'),
  1::bigint, 'exactly one entitlement');
select is((select count(*) from public.library_items li where li.profile_id = (select reader_a from t_ids)
           and li.book_id = 'c2000000-0000-0000-0000-000000000001'), 1::bigint, 'exactly one library item');
select is((select r.status from public.coupon_redemptions r where r.order_id = 'c7000000-0000-0000-0000-000000000004'), 'redeemed',
  'completion redeems the reservation');

-- The rest of lib/commerce/coupon.test.ts's arithmetic, in SQL (29-32)
select is((select r.total_minor from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000006', 'TWENTY') r), 103201::bigint,
  '20% of 129001 leaves 103201');
select is((select o.discount_minor from public.orders o where o.id = 'c7000000-0000-0000-0000-000000000006'), 25800::bigint,
  '20% of 129001 is floored to 25800, so rounding never favours the discount');
select is((select r.total_minor from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000007', 'VND29K') r), 100000::bigint,
  'a fixed code in the order currency subtracts its amount');

insert into t_free select * from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000008', 'VNDBIG');
select is((select f.total_minor from t_free f), 0::bigint,
  'a fixed code larger than the subtotal clamps to it rather than going negative');

-- The clamped order also completes. The reader already owns this book from order 4, so the code is
-- spent for no new access - a known divergence from claim_manual_transfer's EB017, ruled and parked
-- rather than endorsed. What is pinned here is only that the divergence is harmless: the entitlement
-- returned is the existing one resolved by subject, not a second grant (33-34)
select is(
  (select f.entitlement_ids from t_free f),
  (select array[e.id] from public.entitlements e where e.source_order_id = 'c7000000-0000-0000-0000-000000000004'),
  'a completion for a book the reader already owns returns the entitlement they already hold');
select is((select count(*) from public.library_items li where li.profile_id = (select reader_a from t_ids)
           and li.book_id = 'c2000000-0000-0000-0000-000000000001'), 1::bigint,
  'and adds no second library item');

-- The per-profile limit. ONEEACH has no global cap and allows one use each, so the reader's second
-- attempt is refused - and is told no more than any other invalid code is (35-36)
select is((select r.total_minor from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000009', 'ONEEACH') r), 103200::bigint,
  'a reader may take their one allowed use of a per-profile-limited code');
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-00000000000a', 'ONEEACH') r), 'invalid',
  'the same reader is refused a second use of a per-profile-limited code');

-- An order whose transfer the reader has already reported is frozen: the admin is reconciling a
-- specific sum against a specific reference, and neither applying nor removing a code may move it
-- underneath them (37-38). Order c takes a code first, then both orders get a claim - inserted as
-- the owner, since manual_transfer_claims is written only by its own definer RPCs.
select public.apply_coupon_to_order('c7000000-0000-0000-0000-00000000000c', 'TWENTY');
reset role;
insert into public.manual_transfer_claims (order_id, profile_id)
select o.id, t.reader_a
from (values ('c7000000-0000-0000-0000-00000000000b'::uuid), ('c7000000-0000-0000-0000-00000000000c'::uuid)) as o(id), t_ids t;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.apply_coupon_to_order('c7000000-0000-0000-0000-00000000000b', 'TWENTY')$$,
  'EB024', null, 'a code cannot be applied to an order whose transfer has already been reported');
select throws_ok(
  $$select public.remove_coupon_from_order('c7000000-0000-0000-0000-00000000000c')$$,
  'EB024', null, 'a code cannot be removed from an order whose transfer has already been reported');

-- The rate limit. Reader A has seven wrong codes on the record from the blocks above; ten more
-- attempts carry the count past the allowance, after which even a VALID code comes back
-- rate_limited (39)
do $$
begin
  for i in 1..10 loop perform public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000005', 'NOSUCHCODE' || i::text); end loop;
end;
$$;
select is((select r.rejection from public.apply_coupon_to_order('c7000000-0000-0000-0000-000000000005', 'TWENTY') r), 'rate_limited',
  'a profile that has guessed ten times is refused even a valid code');

reset role;
select * from finish();
rollback;
