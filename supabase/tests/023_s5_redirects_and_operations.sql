begin;
select plan(44);

-- S5 operations alert state (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 6.4,
-- 6.5, 10), and the stored public redirect lookup (7.6, 12). Also proves that an admin's normal session can read every source table the
-- operational rules load for /admin/operations, and that a non-admin reader sees none of it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's5-ops-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's5-ops-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '90000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 's5-ops-buyer@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000001') as reader_id,
  (select id from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000002') as admin_id,
  (select id from public.profiles where auth_user_id = '90000000-0000-0000-0000-000000000003') as buyer_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

-- Source fixtures: one of each row the operational rules read. The order belongs to a third
-- profile, so the non-admin reader cannot see it through the owner policy either.
insert into public.authors (id, canonical_slug, display_name, status)
values ('91000000-0000-0000-0000-000000000001', 's5-ops-author', 'S5 Ops Author', 'draft');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('92000000-0000-0000-0000-000000000001', 's5-ops-book', 'vi', '91000000-0000-0000-0000-000000000001', 'draft');
insert into public.editions (id, book_id, language_code)
values ('93000000-0000-0000-0000-000000000001', '92000000-0000-0000-0000-000000000001', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('94000000-0000-0000-0000-000000000001', '93000000-0000-0000-0000-000000000001', 's5-ops/source.epub', 1, 'queued');
insert into public.processing_jobs (id, target_id, status, correlation_id)
values ('95000000-0000-0000-0000-000000000001', '94000000-0000-0000-0000-000000000001', 'queued', 's5-ops-correlation');
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '96000000-0000-0000-0000-000000000001', buyer_id, 'completed', 'succeeded', 'VN', 'VND', 1000 from t_ids;
insert into public.payments (id, order_id, provider, status, amount_minor, currency)
values ('97000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000001', 'simulator', 'succeeded', 1000, 'VND');
insert into public.payment_events (id, payment_id, provider, provider_event_id, payload_hash)
values ('98000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000001', 'simulator', 's5-ops-event', 'hash');
insert into public.entitlements (id, profile_id, book_id, source_type, source_order_id, status)
select '99000000-0000-0000-0000-000000000001', buyer_id, '92000000-0000-0000-0000-000000000001', 'simulated_payment', '96000000-0000-0000-0000-000000000001', 'active'
from t_ids;

-- Schema contract and seed rows (1-4)
select has_table('public', 'operations_alert_state'::name);
select results_eq(
  $$select rule_name from public.operations_alert_state order by rule_name$$,
  $$values ('missing_order_entitlement'), ('stale_epub_job'), ('stale_reader_question'), ('stuck_notification'), ('unprocessed_payment_event'), ('unreviewed_manual_transfer_claim')$$,
  'the migrations seed exactly one row per rule, S7''s and S13''s included'
);
select is(
  (select count(*)::int from public.operations_alert_state
   where not active and fingerprint is null and first_detected_at is null
     and last_alerted_at is null and resolved_at is null and last_evaluated_at is null),
  6,
  'every seeded row starts inactive and never evaluated, so /admin/operations shows "Not yet run"'
);
select col_is_pk('public', 'operations_alert_state', 'rule_name', 'rule_name is the primary key');

-- Constraints (5-7)
select throws_ok(
  $$insert into public.operations_alert_state (rule_name, last_evaluated_at) values ('unknown_rule', now())$$,
  '23514'
);
select throws_ok(
  $$insert into public.operations_alert_state (rule_name, last_evaluated_at) values ('stale_epub_job', now())$$,
  '23505'
);
select col_is_null(
  'public', 'operations_alert_state', 'last_evaluated_at',
  'last_evaluated_at is null until the first scheduled worker run'
);

-- Browser roles cannot write alert state (8-13)
set local role anon;
select throws_ok($$select count(*) from public.operations_alert_state$$, '42501');
select throws_ok(
  $$update public.operations_alert_state set active = true where rule_name = 'stale_epub_job'$$,
  '42501'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$update public.operations_alert_state set active = true where rule_name = 'stale_epub_job'$$,
  '42501'
);
select throws_ok(
  $$insert into public.operations_alert_state (rule_name, last_evaluated_at) values ('stale_epub_job', now()) on conflict (rule_name) do nothing$$,
  '42501'
);
select throws_ok($$delete from public.operations_alert_state$$, '42501');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$update public.operations_alert_state set active = true where rule_name = 'stale_epub_job'$$,
  '42501'
);
reset role;

-- service_role owns the state transition: it can upsert and update, never delete (14-17)
set local role service_role;
select lives_ok(
  $$insert into public.operations_alert_state (rule_name, active, fingerprint, first_detected_at, last_evaluated_at)
    values ('stale_epub_job', true, 'fp-1', now(), now())
    on conflict (rule_name) do update set
      active = excluded.active,
      fingerprint = excluded.fingerprint,
      first_detected_at = excluded.first_detected_at,
      last_evaluated_at = excluded.last_evaluated_at$$,
  'service_role can upsert alert state'
);
select lives_ok(
  $$update public.operations_alert_state set last_alerted_at = now() where rule_name = 'stale_epub_job'$$,
  'service_role can update alert state'
);
select throws_ok($$delete from public.operations_alert_state$$, '42501');
reset role;
select is(
  (select fingerprint from public.operations_alert_state where rule_name = 'stale_epub_job' and active and last_alerted_at is not null),
  'fp-1',
  'the service_role writes landed'
);

-- An admin session reads alert state and every operations source table (18-26)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000002', true);
select is((select count(*)::int from public.operations_alert_state), 6, 'an admin reads all alert state rows');
select is(
  (select count(*)::int from public.processing_jobs where id = '95000000-0000-0000-0000-000000000001'),
  1, 'an admin reads processing_jobs'
);
select is(
  (select count(*)::int from public.ebook_assets a join public.editions e on e.id = a.edition_id
   where a.id = '94000000-0000-0000-0000-000000000001' and e.book_id = '92000000-0000-0000-0000-000000000001'),
  1, 'an admin resolves a job''s book through ebook_assets and editions'
);
select is(
  (select count(*)::int from public.orders where id = '96000000-0000-0000-0000-000000000001'),
  1, 'an admin reads orders'
);
select is(
  (select count(*)::int from public.entitlements where source_order_id = '96000000-0000-0000-0000-000000000001'),
  1, 'an admin reads entitlements'
);
select is(
  (select count(*)::int from public.payments where id = '97000000-0000-0000-0000-000000000001'),
  1, 'an admin reads payments'
);
select is(
  (select count(*)::int from public.payment_events where id = '98000000-0000-0000-0000-000000000001'),
  1, 'an admin reads payment_events'
);
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '99000000-0000-0000-0000-000000000001'),
  1, 'an admin reads notification_outbox'
);
select is(
  (select count(*)::int from public.editions where id = '93000000-0000-0000-0000-000000000001'),
  1, 'an admin reads editions of an unpublished book'
);
reset role;

-- A non-admin reader sees none of it (27-34)
set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select is((select count(*)::int from public.operations_alert_state), 0, 'a reader sees no alert state');
select is((select count(*)::int from public.processing_jobs), 0, 'a reader sees no processing_jobs');
select is((select count(*)::int from public.ebook_assets), 0, 'a reader sees no ebook_assets');
select is(
  (select count(*)::int from public.orders where id = '96000000-0000-0000-0000-000000000001'),
  0, 'a reader sees no other customer''s order'
);
select is(
  (select count(*)::int from public.entitlements where source_order_id = '96000000-0000-0000-0000-000000000001'),
  0, 'a reader sees no other customer''s entitlement'
);
select is((select count(*)::int from public.payments), 0, 'a reader sees no payments');
select is((select count(*)::int from public.payment_events), 0, 'a reader sees no payment_events');
select is((select count(*)::int from public.notification_outbox), 0, 'a reader sees no notification_outbox rows');
reset role;

-- Stored public redirects (35-44). resolve_public_redirect returns one destination for an exact
-- source path and nothing else; anon still cannot read the table itself.
insert into public.redirects (source_path, destination_path)
values ('/vi/books/s5-old-slug', '/vi/books/s5-new-slug');

select has_function('public', 'resolve_public_redirect', array['text']);
select function_returns('public', 'resolve_public_redirect', array['text'], 'text');
select is_definer('public', 'resolve_public_redirect', array['text']);
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) acl
    where p.oid = 'public.resolve_public_redirect(text)'::regprocedure
      and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC has no default execute on resolve_public_redirect'
);

set local role anon;
select is(
  public.resolve_public_redirect('/vi/books/s5-old-slug'),
  '/vi/books/s5-new-slug',
  'anon resolves an exact source path to its destination'
);
select is(public.resolve_public_redirect('/vi/books/s5-unknown'), null, 'an unknown path resolves to null');
select is(public.resolve_public_redirect('/vi/books/s5-old-slug/'), null, 'a trailing slash is not an exact match');
select is(public.resolve_public_redirect('/VI/books/s5-old-slug'), null, 'matching is case-sensitive');
select throws_ok($$select count(*) from public.redirects$$, '42501');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '90000000-0000-0000-0000-000000000001', true);
select is(
  public.resolve_public_redirect('/vi/books/s5-old-slug'),
  '/vi/books/s5-new-slug',
  'a signed-in reader resolves the same destination'
);
reset role;

select * from finish();
rollback;
