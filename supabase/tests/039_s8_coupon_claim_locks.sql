begin;
select plan(12);

-- S8 PR fixes C1 and H1: the locks that make a reported transfer and a coupon application
-- serialize (20260923150000), and the lock that makes the attempt quota atomic (20260923160000).
--
-- What this file can and cannot do. pgTAP is one session in one transaction, so the interleaving
-- both findings describe cannot be staged here - the same limit 036 records for the coupon row
-- lock. Three things can be asserted, and together they are the property:
--
--   * the two outcomes the locks leave behind, in both orders: a claim first makes the coupon RPCs
--     refuse with EB024, and a coupon first leaves a claim that agrees with the order it was made
--     against;
--   * that the advisory lock is really taken, and really keyed on the profile, read straight out of
--     pg_locks rather than out of the function's text;
--   * and, for the order row lock, the shape 036 established - that the `for update` precedes the
--     checks it is there to protect, which is what the serialized cases above rely on.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's8-lock-a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's8-lock-b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000001') as reader_a,
  (select id from public.profiles where auth_user_id = 'f1000000-0000-0000-0000-000000000002') as reader_b;
grant select on t_ids to public;

insert into public.authors (id, canonical_slug, display_name)
values ('f3000000-0000-0000-0000-000000000001', 's8-lock-author', 'S8 Lock Author');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('f2000000-0000-0000-0000-000000000001', 's8-lock-book', 'vi', 'f3000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code)
values ('f4000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('f5000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', 's8-lock-sku');

-- A plain 20% code with room for several uses: this file is about locks, not about limits.
insert into public.coupons (id, code, kind, percent_off, currency, active, max_redemptions, max_redemptions_per_profile)
values ('f6000000-0000-0000-0000-000000000001', 'LOCK20', 'percent', 20, null, true, null, 5);

-- Four pending manual orders of 129_000 VND: three for reader A, one for reader B.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, subtotal_minor, total_minor, payment_provider)
select ('f7000000-0000-0000-0000-00000000000' || n)::uuid,
       case when n = 4 then t.reader_b else t.reader_a end,
       'pending', 'pending', 'VN', 'VND', 129000, 129000, 'manual'
from t_ids t, generate_series(1, 4) as n;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select ('f7000000-0000-0000-0000-00000000000' || n)::uuid, 'f5000000-0000-0000-0000-000000000001',
       'f2000000-0000-0000-0000-000000000001', 'S8 Lock Book', 129000, 1
from generate_series(1, 4) as n;

insert into public.payments (order_id, provider, status, amount_minor, currency)
select ('f7000000-0000-0000-0000-00000000000' || n)::uuid, 'manual', 'pending', 129000, 'VND'
from generate_series(1, 4) as n;

-- Claim first, then the coupon (1-3). This is the losing side of the race: once a reader has told
-- us they transferred 129_000, no code may move that number.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);

select lives_ok(
  $$select public.claim_manual_transfer('f7000000-0000-0000-0000-000000000001', 'da chuyen khoan')$$,
  'a reader can report a transfer on an uncouponed pending order');
select is(
  (select count(*) from public.manual_transfer_claims c where c.order_id = 'f7000000-0000-0000-0000-000000000001'),
  1::bigint, 'the report is written');
select throws_ok(
  $$select public.apply_coupon_to_order('f7000000-0000-0000-0000-000000000001', 'LOCK20')$$,
  'EB024', null, 'a code cannot be applied to an order whose transfer has already been reported');

-- The coupon first (4). The discount lands while there is still no claim, which is when a reader
-- would actually enter a code.
select is(
  (select r.total_minor from public.apply_coupon_to_order('f7000000-0000-0000-0000-000000000002', 'LOCK20') r),
  103200::bigint, '20% off 129000 leaves 103200');

-- The advisory lock, read out of pg_locks (5-7). Read as the owner: the view is global, so every
-- count below is narrowed to this backend.
reset role;
select is(
  (select count(*) from pg_locks l where l.pid = pg_backend_pid() and l.locktype = 'advisory' and l.granted),
  1::bigint, 'applying a code takes one advisory lock, held for the rest of the transaction');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);
select r.total_minor from public.apply_coupon_to_order('f7000000-0000-0000-0000-000000000003', 'LOCK20') r;
reset role;
select is(
  (select count(*) from pg_locks l where l.pid = pg_backend_pid() and l.locktype = 'advisory' and l.granted),
  1::bigint, 'a second application by the same reader takes the same key, not a second one');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000002', true);
select r.total_minor from public.apply_coupon_to_order('f7000000-0000-0000-0000-000000000004', 'LOCK20') r;
reset role;
select is(
  (select count(*) from pg_locks l where l.pid = pg_backend_pid() and l.locktype = 'advisory' and l.granted),
  2::bigint, 'another reader takes a key of their own, so the critical section is per profile');

-- A claim made after the discount, and the order it agrees with (8-9). The reader reports the
-- number they were shown, and nothing has moved it since.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.claim_manual_transfer('f7000000-0000-0000-0000-000000000002', 'da chuyen khoan')$$,
  'a discounted order can still have its transfer reported');

-- Read back as the owner: a reader has no select on public.payments, so this cross-table check
-- cannot be made from under their role.
reset role;
select is(
  (select o.total_minor::text || '/' || (select pay.amount_minor from public.payments pay
                                        where pay.order_id = o.id and pay.status = 'pending')::text
   from public.orders o where o.id = 'f7000000-0000-0000-0000-000000000002'),
  '103200/103200', 'the reported order and its pending payment carry the same discounted total');

-- And the discount cannot be taken back underneath that report (10).
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.remove_coupon_from_order('f7000000-0000-0000-0000-000000000002')$$,
  'EB024', null, 'a code cannot be removed from an order whose transfer has already been reported');
reset role;

-- The lock order itself (11-12). Both are properties of the source because one session cannot
-- observe two transactions queueing, and both are exactly what the cases above depend on.
select matches(
  (select pg_get_functiondef(p.oid) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_manual_transfer'),
  'from public\.orders o\s+where o\.id = p_order_id and o\.profile_id = v_profile_id\s+for update;'
  '.*EB020'
  '.*EB017'
  '.*insert into public\.manual_transfer_claims',
  'claim_manual_transfer locks the order before its own checks and before it writes the claim');
select matches(
  (select pg_get_functiondef(p.oid) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'apply_coupon_to_order'),
  'pg_advisory_xact_lock'
  '.*from public\.orders o'
  '.*for update;'
  '.*coupon_attempts_exhausted',
  'apply_coupon_to_order takes the per-profile lock first, then the order, then reads the quota');

select * from finish();
rollback;
