begin;
select plan(16);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's3-revoke-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's3-revoke-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '61000000-0000-0000-0000-000000000001') as admin_id,
  (select id from public.profiles where auth_user_id = '61000000-0000-0000-0000-000000000002') as reader_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

create temporary table t_results (label text primary key, entitlement_ids uuid[]);
grant select, insert on t_results to public;

insert into public.authors (id, canonical_slug, display_name)
values ('63000000-0000-0000-0000-000000000001', 's3-revoke-author', 'S3 Revoke Author');

insert into public.books (id, canonical_key, original_language, primary_author_id)
select ('62000000-0000-0000-0000-00000000000' || n)::uuid, 's3-revoke-book-' || n, 'vi', '63000000-0000-0000-0000-000000000001'
from generate_series(1, 4) as n;
insert into public.editions (id, book_id, language_code)
select ('64000000-0000-0000-0000-00000000000' || n)::uuid, ('62000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 4) as n;
insert into public.skus (id, edition_id, sku_code)
select ('65000000-0000-0000-0000-00000000000' || n)::uuid, ('64000000-0000-0000-0000-00000000000' || n)::uuid, 's3-revoke-sku-' || n
from generate_series(1, 4) as n;

-- O1 paid book 1, O2 free book 2, O4 paid book 4, O6 pending (no entitlement).
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select o.id::uuid, t_ids.reader_id, o.status::public.order_status, o.payment_status::public.payment_status, 'VN', 'VND', o.total
from t_ids, (values
  ('66000000-0000-0000-0000-000000000001', 'completed', 'succeeded', 150000),
  ('66000000-0000-0000-0000-000000000002', 'completed', 'not_required', 0),
  ('66000000-0000-0000-0000-000000000004', 'completed', 'succeeded', 150000),
  ('66000000-0000-0000-0000-000000000006', 'pending', 'pending', 150000)
) as o(id, status, payment_status, total);

insert into public.order_items (order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values
  ('66000000-0000-0000-0000-000000000001', '65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Book 1', 150000),
  ('66000000-0000-0000-0000-000000000002', '65000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000002', 'Book 2', 0),
  ('66000000-0000-0000-0000-000000000004', '65000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000004', 'Book 4', 150000),
  ('66000000-0000-0000-0000-000000000006', '65000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'Book 1', 150000);

insert into public.entitlements (id, profile_id, book_id, source_type, source_order_id, actor_profile_id, reason, status)
select e.id::uuid, t_ids.reader_id, e.book_id::uuid, e.source::public.entitlement_source, e.order_id::uuid,
  case when e.source = 'admin_grant' then t_ids.admin_id end,
  case when e.source = 'admin_grant' then 'Gift' end,
  'active'
from t_ids, (values
  ('67000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000001', 'simulated_payment', '66000000-0000-0000-0000-000000000001'),
  ('67000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000002', 'free_order', '66000000-0000-0000-0000-000000000002'),
  ('67000000-0000-0000-0000-000000000003', '62000000-0000-0000-0000-000000000003', 'admin_grant', null),
  ('67000000-0000-0000-0000-000000000004', '62000000-0000-0000-0000-000000000004', 'simulated_payment', '66000000-0000-0000-0000-000000000004')
) as e(id, book_id, source, order_id);

insert into public.library_items (profile_id, book_id, entitlement_id)
select t_ids.reader_id, e.book_id, e.id from t_ids, public.entitlements e where e.profile_id = t_ids.reader_id;

-- Authorization and validation (1-2)
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000002', true);
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'No') $$, '42501', null, 'a reader cannot revoke order access');
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', '  ') $$, '22023', null, 'a reason is required');

-- Revoke a paid order (3-10)
insert into t_results values ('o1', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'Chargeback'));
reset role;

select is((select entitlement_ids from t_results where label = 'o1'), array['67000000-0000-0000-0000-000000000001'::uuid], 'returns the order''s entitlements');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000001'), 'revoked', 'the paid entitlement is revoked');
select isnt((select revoked_at from public.entitlements where id = '67000000-0000-0000-0000-000000000001'), null, 'revoked_at is set');
select is((select count(*)::int from public.library_items where entitlement_id = '67000000-0000-0000-0000-000000000001'), 0, 'the library item is removed');
select is((select count(*)::int from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '66000000-0000-0000-0000-000000000001'), 1, 'one audit row is written');
-- The audit row now hangs off the ORDER, with the revoked ids in its metadata: one admin decision
-- is one row however many books the order held.
select is((select metadata -> 'entitlement_ids' from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '66000000-0000-0000-0000-000000000001'), to_jsonb(array['67000000-0000-0000-0000-000000000001'::uuid]), 'the audit row names every revoked entitlement');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000004'), 'active', 'another order''s entitlement is untouched');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000003'), 'active', 'an admin grant is untouched');

-- Repeat, free order, missing entitlement (11-15)
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
insert into t_results values ('o1-repeat', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000001', 'Again'));
insert into t_results values ('o2', public.revoke_order_entitlement('66000000-0000-0000-0000-000000000002', 'Abuse'));
select throws_ok($$ select public.revoke_order_entitlement('66000000-0000-0000-0000-000000000006', 'Nothing') $$, 'P0002', null, 'an order that granted nothing cannot be revoked');
reset role;

select is((select entitlement_ids from t_results where label = 'o1-repeat'), array['67000000-0000-0000-0000-000000000001'::uuid], 'a repeat returns the same entitlements');
select is((select count(*)::int from public.audit_logs where action = 'revoke_order_entitlement' and entity_id = '66000000-0000-0000-0000-000000000001'), 1, 'a repeat writes no second audit row');
select is((select status::text from public.entitlements where id = '67000000-0000-0000-0000-000000000002'), 'revoked', 'a free-order entitlement can be revoked');
select is((select status::text from public.orders where id = '66000000-0000-0000-0000-000000000001'), 'completed', 'the order itself does not change');

-- Privileges (16)
select is(has_function_privilege('anon', 'public.revoke_order_entitlement(uuid, text)', 'execute'), false, 'anon cannot revoke');

select * from finish();
rollback;
