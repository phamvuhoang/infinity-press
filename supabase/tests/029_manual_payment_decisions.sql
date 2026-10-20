begin;
select plan(56);

-- S7: confirm_manual_payment and reject_manual_payment, the admin's decision on a reported bank
-- transfer (spec 5.6).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's7-decide-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's7-decide-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  -- A second reader who owns nothing here. Without one, manual_payment_declines_owner_select would
  -- pass every assertion in this file even if it were `using (true)`: the only reader in the suite
  -- is the owner of every decline in it. Spec section 10 makes a cross-user negative an exit
  -- criterion, and this is the reader who provides it.
  ('00000000-0000-0000-0000-000000000000', 'a1000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's7-decide-other-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = 'a1000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = 'a1000000-0000-0000-0000-000000000002') as reader_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

-- Both RPCs' return values are captured here and asserted against afterwards, rather than compared
-- inline with results_eq. results_eq declares both cursors before fetching from either, so an
-- expected query that reads the rows the call under test is about to write could be planned against
-- a snapshot that predates them. Writing the result to a table first removes that ordering
-- question entirely: by assertion time both sides are plain table reads. So the shorter form -
-- passing the RPC call straight to results_eq as its "have" query - is not a simplification
-- available here, and collapsing these tables into one would reintroduce the hazard.
create temporary table t_confirm (
  label text primary key, entitlement_ids uuid[], order_status text, payment_status text);
create temporary table t_reject (label text primary key, order_status text, payment_status text);
grant select, insert on t_confirm, t_reject to public;

insert into public.authors (id, canonical_slug, display_name)
values ('a3000000-0000-0000-0000-000000000001', 's7-decide-author', 'S7 Decide Author');

-- One book per order, so each confirmation has to grant its own entitlement rather than resolving
-- to one the reader already holds for the same book.
insert into public.books (id, canonical_key, original_language, primary_author_id)
select ('a2000000-0000-0000-0000-00000000000' || n)::uuid, 's7-decide-book-' || n, 'vi', 'a3000000-0000-0000-0000-000000000001'
from generate_series(1, 3) as n;
insert into public.editions (id, book_id, language_code)
select ('a4000000-0000-0000-0000-00000000000' || n)::uuid, ('a2000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 3) as n;
insert into public.skus (id, edition_id, sku_code)
select ('a5000000-0000-0000-0000-00000000000' || n)::uuid, ('a4000000-0000-0000-0000-00000000000' || n)::uuid, 's7-decide-sku-' || n
from generate_series(1, 3) as n;

-- Three pending manual orders for the same reader, each already reported as transferred.
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select ('a6000000-0000-0000-0000-00000000000' || n)::uuid, t_ids.reader_id, 'pending', 'pending', 'VN', 'VND', 129000, 'manual'
from t_ids, generate_series(1, 3) as n;

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
select ('a6000000-0000-0000-0000-00000000000' || n)::uuid, ('a5000000-0000-0000-0000-00000000000' || n)::uuid,
  ('a2000000-0000-0000-0000-00000000000' || n)::uuid, 'S7 Decide Book ' || n, 129000, 1
from generate_series(1, 3) as n;

insert into public.payments (order_id, provider, status, amount_minor, currency)
select ('a6000000-0000-0000-0000-00000000000' || n)::uuid, 'manual', 'pending', 129000, 'VND'
from generate_series(1, 3) as n;

insert into public.manual_transfer_claims (order_id, profile_id, note)
select ('a6000000-0000-0000-0000-00000000000' || n)::uuid, t_ids.reader_id, 'da chuyen'
from t_ids, generate_series(1, 3) as n;

-- A fourth order, pending like the others but booked under the simulator. It exists for one
-- assertion: confirm_manual_payment raises EB022 from two places, and only the "not pending" arm
-- was ever exercised. The untested arm is the payments join - the thing that stops an admin
-- hand-confirming an order no bank transfer was ever made for.
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('a2000000-0000-0000-0000-000000000004', 's7-decide-book-4', 'vi', 'a3000000-0000-0000-0000-000000000001');
insert into public.editions (id, book_id, language_code)
values ('a4000000-0000-0000-0000-000000000004', 'a2000000-0000-0000-0000-000000000004', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('a5000000-0000-0000-0000-000000000004', 'a4000000-0000-0000-0000-000000000004', 's7-decide-sku-4');
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor, payment_provider)
select 'a6000000-0000-0000-0000-000000000004', t_ids.reader_id, 'pending', 'pending', 'VN', 'VND', 129000, 'simulator'
from t_ids;
insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor, quantity)
values ('a6000000-0000-0000-0000-000000000004', 'a5000000-0000-0000-0000-000000000004',
  'a2000000-0000-0000-0000-000000000004', 'S7 Decide Book 4', 129000, 1);
insert into public.payments (order_id, provider, status, amount_minor, currency)
values ('a6000000-0000-0000-0000-000000000004', 'simulator', 'pending', 129000, 'VND');

-- ============================================================================================
-- The admin decides. is_admin() reads auth.uid(), so the session has to be an authenticated one
-- carrying the admin's subject claim, not the owning superuser.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);

-- A short payment
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000001', 100000, 'VCB-1', null, false)$$,
  'EB021', 'confirm_manual_payment: received 100000 but the order total is 129000',
  'a short payment is refused without an explicit override');
select is((select o.status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000001'), 'pending',
  'the refused confirmation changed nothing');
select is((select count(*) from public.manual_payment_confirmations), 0::bigint,
  'the refused confirmation wrote no evidence row');
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000001', 129000, '   ', null, false)$$,
  '22023', 'confirm_manual_payment: a bank reference is required', 'a bank reference is required');
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000001', null, 'VCB-1', null, false)$$,
  '22023', 'confirm_manual_payment: a received amount is required',
  'a null received amount is refused rather than silently skipping the mismatch check');

-- A matching amount confirms
insert into t_confirm
select 'o1-first', c.entitlement_ids, c.order_status::text, c.payment_status::text
from public.confirm_manual_payment('a6000000-0000-0000-0000-000000000001', 129000, 'VCB-1', 'khop', false) c;

-- The returned array is pinned against the rows that now exist, not against a literal, so an
-- empty array or a foreign subject fails here. This is the contract the admin UI consumes.
select results_eq(
  $$select entitlement_ids, order_status, payment_status from t_confirm where label = 'o1-first'$$,
  $$select array_agg(e.id order by e.book_id), 'completed'::text, 'succeeded'::text
    from public.entitlements e
    where e.source_order_id = 'a6000000-0000-0000-0000-000000000001' and e.status = 'active'$$,
  'a matching amount confirms and returns the granted entitlement');
select is((select o.status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000001'), 'completed',
  'the order completes');
select is((select o.payment_status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000001'), 'succeeded',
  'the order is paid');
select is((select e.source_type::text from public.entitlements e where e.source_order_id = 'a6000000-0000-0000-0000-000000000001'),
  'manual_payment', 'the buyer gets a manual_payment entitlement');
select is((select count(*) from public.manual_transfer_claims where order_id = 'a6000000-0000-0000-0000-000000000001'),
  0::bigint, 'confirming clears the claim so it leaves the review queue');

-- Confirming twice. A claim is planted on the already-completed order first: no route in this
-- schema leaves one there today, but if one ever did it would sit in the review queue forever and
-- the admin's natural remedy is to press confirm again, so the idempotent branch has to release it.
reset role;
insert into public.manual_transfer_claims (order_id, profile_id)
select 'a6000000-0000-0000-0000-000000000001', reader_id from t_ids;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);

insert into t_confirm
select 'o1-again', c.entitlement_ids, c.order_status::text, c.payment_status::text
from public.confirm_manual_payment('a6000000-0000-0000-0000-000000000001', 129000, 'VCB-1', null, false) c;

-- The idempotent branch resolves the entitlement through a join written only for it, so this is
-- the one assertion that would catch it returning null or another reader's row.
select results_eq(
  $$select entitlement_ids, order_status, payment_status from t_confirm where label = 'o1-again'$$,
  $$select array_agg(e.id order by e.book_id), 'completed'::text, 'succeeded'::text
    from public.entitlements e
    where e.source_order_id = 'a6000000-0000-0000-0000-000000000001' and e.status = 'active'$$,
  'confirming twice returns the same entitlement, not a second one and not null');
select is((select count(*) from public.entitlements where source_order_id = 'a6000000-0000-0000-0000-000000000001'),
  1::bigint, 'confirming twice grants exactly one entitlement');
select is((select count(*) from public.audit_logs
  where action = 'manual_payment.confirmed' and entity_id = 'a6000000-0000-0000-0000-000000000001'),
  1::bigint, 'the second confirmation writes no second audit row');
select is((select count(*) from public.manual_transfer_claims where order_id = 'a6000000-0000-0000-0000-000000000001'),
  0::bigint, 'the idempotent confirmation releases a claim left behind by any other route');

-- An accepted mismatch
insert into t_confirm
select 'o2', c.entitlement_ids, c.order_status::text, c.payment_status::text
from public.confirm_manual_payment('a6000000-0000-0000-0000-000000000002', 100000, 'VCB-2', 'thieu tien', true) c;

-- The override path must still return the grant, not merely record the evidence row.
select results_eq(
  $$select entitlement_ids, order_status, payment_status from t_confirm where label = 'o2'$$,
  $$select array_agg(e.id order by e.book_id), 'completed'::text, 'succeeded'::text
    from public.entitlements e
    where e.source_order_id = 'a6000000-0000-0000-0000-000000000002' and e.status = 'active'$$,
  'an accepted mismatch confirms and returns the granted entitlement');
select is((select c.mismatch_accepted from public.manual_payment_confirmations c where c.order_id = 'a6000000-0000-0000-0000-000000000002'),
  true, 'the override is recorded on the confirmation');
select is((select c.received_amount_minor from public.manual_payment_confirmations c where c.order_id = 'a6000000-0000-0000-0000-000000000002'),
  100000::bigint, 'the confirmation records what actually arrived, not the order total');
select is((select o.status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000002'), 'completed',
  'the mismatched order completes too');
select is((select count(*) from public.audit_logs where action = 'manual_payment.confirmed'), 2::bigint,
  'each confirmation writes one audit row');
select is((select l.metadata ->> 'mismatch_accepted' from public.audit_logs l
  where l.action = 'manual_payment.confirmed' and l.entity_id = 'a6000000-0000-0000-0000-000000000002'),
  'true', 'the audit row records the accepted mismatch');

-- not_received
insert into t_reject
select 'o3-not-received', r.order_status::text, r.payment_status::text
from public.reject_manual_payment('a6000000-0000-0000-0000-000000000003', 'khong thay tien', 'not_received') r;

-- The order-status half is load-bearing: it is what tells the admin UI the order is still payable.
select results_eq(
  $$select order_status, payment_status from t_reject where label = 'o3-not-received'$$,
  $$values ('pending'::text, 'failed'::text)$$,
  'not_received returns a still-pending order with a failed payment');
select is((select o.status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000003'), 'pending',
  'a not_received order stays payable');
select is((select o.payment_status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000003'), 'failed',
  'a not_received order is marked failed');
select is((select count(*) from public.manual_transfer_claims where order_id = 'a6000000-0000-0000-0000-000000000003'),
  0::bigint, 'declining releases the claim so the reader can report again');
select is((select count(*) from public.manual_payment_declines where order_id = 'a6000000-0000-0000-0000-000000000003'),
  1::bigint, 'the decline is recorded');
select is((select d.sequence from public.manual_payment_declines d where d.order_id = 'a6000000-0000-0000-0000-000000000003'),
  1, 'the first decline on an order is sequence 1');

-- Refused declines
select throws_ok(
  $$select public.reject_manual_payment('a6000000-0000-0000-0000-000000000003', '   ', 'not_received')$$,
  '22023', 'reject_manual_payment: a reason is required', 'a decline requires a reason');
select throws_ok(
  $$select public.reject_manual_payment('a6000000-0000-0000-0000-000000000003', 'x', 'shrug')$$,
  'EB023', 'reject_manual_payment: unknown outcome shrug', 'an unknown outcome is refused');
select is((select count(*) from public.manual_payment_declines where order_id = 'a6000000-0000-0000-0000-000000000003'),
  1::bigint, 'a refused decline wrote no second evidence row');

-- cancel
insert into t_reject
select 'o3-cancel', r.order_status::text, r.payment_status::text
from public.reject_manual_payment('a6000000-0000-0000-0000-000000000003', 'khach doi y', 'cancel') r;

select results_eq(
  $$select order_status, payment_status from t_reject where label = 'o3-cancel'$$,
  $$values ('cancelled'::text, 'cancelled'::text)$$,
  'cancel returns an ended order');
select is((select o.status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000003'), 'cancelled',
  'the order is cancelled');
select is((select o.payment_status::text from public.orders o where o.id = 'a6000000-0000-0000-0000-000000000003'), 'cancelled',
  'the cancelled order carries a cancelled payment status');
select is((select max(d.sequence) from public.manual_payment_declines d where d.order_id = 'a6000000-0000-0000-0000-000000000003'),
  2, 'the second decline on the same order is sequence 2');
select is((select count(*) from public.audit_logs
  where action = 'manual_payment.declined' and entity_id = 'a6000000-0000-0000-0000-000000000003'),
  2::bigint, 'each decline writes one audit row');
-- The message is pinned because confirm_manual_payment raises EB022 from two places: this one,
-- and "not a manual order". Without it this assertion would also pass if the payments join had
-- silently stopped matching.
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000003', 129000, 'VCB-3', null, false)$$,
  'EB022',
  'confirm_manual_payment: order a6000000-0000-0000-0000-000000000003 is cancelled, not pending',
  'a cancelled order cannot be confirmed');

-- No entitlement was ever granted for the declined order
select is((select count(*) from public.entitlements where source_order_id = 'a6000000-0000-0000-0000-000000000003'),
  0::bigint, 'a declined order grants nothing');

-- EB022's other raise site. Order 4 is pending, so "not pending" cannot be what refuses it; what
-- refuses it is the payments join finding no manual row. The message is pinned for the same reason
-- the cancelled-order assertion above pins its own: it is what keeps the two arms distinguishable.
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000004', 129000, 'VCB-4', null, false)$$,
  'EB022',
  'confirm_manual_payment: order a6000000-0000-0000-0000-000000000004 is not a manual order',
  'a simulator order cannot be confirmed by hand, however pending it is');

-- ============================================================================================
-- The ordinary reader
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);

-- Messages pinned: 42501 is also what a missing EXECUTE grant or a denied table write raises, and
-- the point here is that the admin gate inside the function is what refuses, not a grant.
select throws_ok(
  $$select public.confirm_manual_payment('a6000000-0000-0000-0000-000000000002', 129000, 'VCB-9', null, false)$$,
  '42501', 'confirm_manual_payment: caller is not an admin', 'a non-admin cannot confirm');
select throws_ok(
  $$select public.reject_manual_payment('a6000000-0000-0000-0000-000000000002', 'x', 'cancel')$$,
  '42501', 'reject_manual_payment: caller is not an admin', 'a non-admin cannot decline');
select is((select count(*) from public.manual_payment_confirmations), 0::bigint,
  'a non-admin cannot read the confirmations table');
select is((select count(*) from public.manual_payment_declines), 2::bigint,
  'the declined reader reads the reasons on their own order');

-- The negative half of that policy. Without it the assertion above proves only that a reader can
-- read declines - not that manual_payment_declines_owner_select restricts them to their own.
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
select is((select count(*) from public.manual_payment_declines), 0::bigint,
  'another reader reads no decline of an order they do not own');

-- ============================================================================================
-- Privileges. Both new tables are select-only for every role; the RPCs write as the table
-- owner. authenticated is proved by the grant itself, because its RLS default-deny would hide a
-- present grant; service_role bypasses RLS, so an attempted write is unambiguous there.
select is(has_table_privilege('authenticated', 'public.manual_payment_confirmations', 'insert'), false, 'authenticated cannot insert into manual_payment_confirmations');
select is(has_table_privilege('authenticated', 'public.manual_payment_confirmations', 'update'), false, 'authenticated cannot update manual_payment_confirmations');
select is(has_table_privilege('authenticated', 'public.manual_payment_confirmations', 'delete'), false, 'authenticated cannot delete from manual_payment_confirmations');
select is(has_table_privilege('authenticated', 'public.manual_payment_declines', 'insert'), false, 'authenticated cannot insert into manual_payment_declines');
select is(has_table_privilege('authenticated', 'public.manual_payment_declines', 'update'), false, 'authenticated cannot update manual_payment_declines');
select is(has_table_privilege('authenticated', 'public.manual_payment_declines', 'delete'), false, 'authenticated cannot delete from manual_payment_declines');

reset role;
set local role service_role;
select throws_ok(
  $$insert into public.manual_payment_confirmations (order_id, admin_profile_id, received_amount_minor, bank_reference)
    values ('a6000000-0000-0000-0000-000000000003', (select admin_id from t_ids), 129000, 'VCB-X')$$,
  '42501', null, 'service_role cannot insert into manual_payment_confirmations directly');
select throws_ok(
  $$update public.manual_payment_confirmations set bank_reference = 'x'$$,
  '42501', null, 'service_role cannot update manual_payment_confirmations directly');
select throws_ok(
  $$delete from public.manual_payment_confirmations$$,
  '42501', null, 'service_role cannot delete from manual_payment_confirmations directly');
select throws_ok(
  $$insert into public.manual_payment_declines (order_id, sequence, admin_profile_id, reason, outcome)
    values ('a6000000-0000-0000-0000-000000000001', 1, (select admin_id from t_ids), 'x', 'cancel')$$,
  '42501', null, 'service_role cannot insert into manual_payment_declines directly');
select throws_ok(
  $$update public.manual_payment_declines set reason = 'x'$$,
  '42501', null, 'service_role cannot update manual_payment_declines directly');
select throws_ok(
  $$delete from public.manual_payment_declines$$,
  '42501', null, 'service_role cannot delete from manual_payment_declines directly');
reset role;

select is(has_function_privilege('anon', 'public.confirm_manual_payment(uuid, bigint, text, text, boolean)', 'execute'),
  false, 'anon cannot confirm a manual payment');
select is(has_function_privilege('anon', 'public.reject_manual_payment(uuid, text, text)', 'execute'),
  false, 'anon cannot decline a manual payment');

select * from finish();
rollback;
