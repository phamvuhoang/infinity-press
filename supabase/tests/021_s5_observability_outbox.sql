begin;
select plan(53);

-- S5: durable analytics events and the one-row-per-entitlement notification outbox
-- (docs/superpowers/specs/2026-09-16-s5-seo-operations-design.md 6.1-6.3, 6.5).

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's5-outbox-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '80000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's5-outbox-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

-- Resolved as the connecting role: profiles RLS would hide other readers' rows after a role switch.
create temporary table t_ids as
select
  (select id from public.profiles where auth_user_id = '80000000-0000-0000-0000-000000000001') as reader_id,
  (select id from public.profiles where auth_user_id = '80000000-0000-0000-0000-000000000002') as admin_id;
grant select on t_ids to public;

insert into public.user_roles (profile_id, role) select admin_id, 'admin' from t_ids;

insert into public.authors (id, canonical_slug, display_name, status)
values ('81000000-0000-0000-0000-000000000001', 's5-outbox-author', 'S5 Outbox Author', 'published');

-- book1: the active-then-duplicated grant. book2: revoked-then-activated. book3: revoked and
-- never reactivated. book4: written while the entitlement trigger is disabled, modeling an
-- entitlement that predates this migration.
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
select ('82000000-0000-0000-0000-00000000000' || n)::uuid, 's5-outbox-book-' || n, 'vi', '81000000-0000-0000-0000-000000000001', 'published'
from generate_series(1, 4) as n;
insert into public.editions (id, book_id, language_code)
select ('82100000-0000-0000-0000-00000000000' || n)::uuid, ('82000000-0000-0000-0000-00000000000' || n)::uuid, 'vi'
from generate_series(1, 4) as n;

-- Schema and function contract (1-5)
select has_table('public', 'analytics_events'::name);
select has_table('public', 'notification_outbox'::name);
select has_function('public', 'claim_notification_outbox', array['integer', 'uuid']);
select has_function('public', 'complete_notification_outbox', array['uuid', 'uuid', 'text']);
select has_function('public', 'fail_notification_outbox', array['uuid', 'uuid', 'text']);

-- analytics_events accepts only approved event names (6)
select throws_ok(
  $$insert into public.analytics_events(event_name) values ('raw_reader_location')$$,
  '23514'
);

-- The partial unique dedupe index supports `on conflict (dedupe_key) where dedupe_key is not
-- null do nothing`, the exact inference later tasks rely on (7)
set local role service_role;
insert into public.analytics_events (event_name, dedupe_key) values ('view_book', 's5-dedupe-fixture')
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
insert into public.analytics_events (event_name, dedupe_key) values ('view_book', 's5-dedupe-fixture')
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
reset role;
select is(
  (select count(*)::int from public.analytics_events where dedupe_key = 's5-dedupe-fixture'),
  1,
  'a duplicate dedupe_key insert via the partial-index on conflict clause is a no-op'
);

-- An active entitlement produces exactly one book_ready outbox row (8)
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '83000000-0000-0000-0000-000000000001', t_ids.reader_id, '82000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.admin_id, 'Test fixture', 'active'
from t_ids;
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000001' and template_key = 'book_ready'),
  1,
  'an active entitlement produces one book_ready outbox row'
);

-- Re-granting the same logical entitlement (same profile/book) through the standard
-- `on conflict (profile_id, book_id) where status = 'active' do nothing` clause leaves exactly
-- one active entitlement row, so the trigger never fires a second time for it (9)
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select t_ids.reader_id, '82000000-0000-0000-0000-000000000001', 'admin_grant', t_ids.admin_id, 'Test fixture repeat', 'active'
from t_ids
on conflict (profile_id, edition_id) where status = 'active' and edition_id is not null do nothing;
select is(
  (select count(*)::int from public.entitlements where profile_id = (select reader_id from t_ids) and book_id = '82000000-0000-0000-0000-000000000001'),
  1,
  'the same logical grant repeated leaves one active entitlement row'
);
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000001'),
  1,
  'the repeated grant does not create a second outbox row for the same entitlement (10)'
);

-- Revoking then reactivating an entitlement that already has an outbox row proves the row is
-- not duplicated: `on conflict (entitlement_id) do nothing` makes reactivation idempotent even
-- when the entitlement already produced a row once before (11)
update public.entitlements set status = 'revoked', revoked_at = now()
where id = '83000000-0000-0000-0000-000000000001';
update public.entitlements set status = 'active', revoked_at = null
where id = '83000000-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000001'),
  1,
  'revoking then reactivating an entitlement that already has an outbox row still leaves one row'
);

-- A revoked entitlement produces no row (12)
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status, revoked_at)
select '83000000-0000-0000-0000-000000000002', t_ids.reader_id, '82000000-0000-0000-0000-000000000002', 'admin_grant', t_ids.admin_id, 'Test fixture', 'revoked', now()
from t_ids;
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000002'),
  0,
  'a revoked entitlement produces no outbox row'
);

-- Changing revoked to active produces one row (13)
update public.entitlements set status = 'active', revoked_at = null
where id = '83000000-0000-0000-0000-000000000002';
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000002' and template_key = 'book_ready'),
  1,
  'reactivating a revoked entitlement produces one outbox row'
);

-- No backfill: disabling the trigger models an entitlement row that existed before this
-- migration's trigger was created (the migration itself never runs an insert-select over
-- entitlements, so the only way a pre-existing row could get an outbox row is if the trigger
-- retroactively noticed it - it does not) (14)
alter table public.entitlements disable trigger entitlements_notification_outbox;
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '83000000-0000-0000-0000-000000000004', t_ids.reader_id, '82000000-0000-0000-0000-000000000004', 'admin_grant', t_ids.admin_id, 'Pre-existing fixture', 'active'
from t_ids;
alter table public.entitlements enable trigger entitlements_notification_outbox;
select is(
  (select count(*)::int from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000004'),
  0,
  'an entitlement written while the trigger is disabled (modeling data written before the migration) gets no outbox row'
);

-- Claiming with two lease tokens: each pending row is claimed by at most one lease (15-17)
set local role service_role;
create temporary table t_claim1 as
select * from public.claim_notification_outbox(1, '84000000-0000-0000-0000-000000000001');
create temporary table t_claim2 as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000002');
reset role;
grant select on t_claim1, t_claim2 to public;

select is((select count(*)::int from t_claim1), 1, 'the first lease claims exactly one row');
select is((select count(*)::int from t_claim2), 1, 'the second lease claims exactly one row');
select is(
  (select count(*)::int from t_claim1 join t_claim2 using (id)),
  0,
  'the two leases never claim the same row'
);

-- Revoking one entitlement makes its pending row unclaimable (18-19)
insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select '83000000-0000-0000-0000-000000000003', t_ids.reader_id, '82000000-0000-0000-0000-000000000003', 'admin_grant', t_ids.admin_id, 'Test fixture', 'active'
from t_ids;
update public.entitlements set status = 'revoked', revoked_at = now()
where id = '83000000-0000-0000-0000-000000000003';

set local role service_role;
create temporary table t_claim3 as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000003');
reset role;
grant select on t_claim3 to public;

select is(
  (select count(*)::int from t_claim3 where entitlement_id = '83000000-0000-0000-0000-000000000003'),
  0,
  'a revoked entitlement''s pending outbox row is not claimable'
);
select is(
  (select lease_token from public.notification_outbox where entitlement_id = '83000000-0000-0000-0000-000000000003'),
  null,
  'the revoked entitlement''s row is left unleased'
);

-- Completing with the wrong token changes nothing (20-21)
select is(
  (select public.complete_notification_outbox((select id from t_claim1), '84000000-0000-0000-0000-000000000099', 'wrong-token-msg')),
  false,
  'completing with a token that does not own the lease returns false'
);
select is(
  (select sent_at from public.notification_outbox where id = (select id from t_claim1)),
  null,
  'a completion attempt with the wrong token leaves sent_at unset'
);

-- Completing with the owning token records provider acceptance (22-23)
select is(
  (select public.complete_notification_outbox((select id from t_claim1), '84000000-0000-0000-0000-000000000001', 'provider-msg-1')),
  true,
  'completing with the owning token succeeds'
);
select results_eq(
  $$ select (sent_at is not null), provider_message_id, lease_token from public.notification_outbox where id = (select id from t_claim1) $$,
  $$ values (true, 'provider-msg-1'::text, null::uuid) $$,
  'a successful completion sets sent_at and the provider message id, and clears the lease'
);

-- Five failures follow the documented retry delays: 1m, 5m, 30m, 2h, 6h (24-33). now() is
-- constant for the whole transaction, so an exact equality against now() + interval is
-- deterministic. available_at is walked back to now() as the test superuser (bypassing grants
-- via table ownership) between claims to model the passage of time.
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000002', 'smtp_5xx')),
  true,
  'the first failure is recorded'
);
select results_eq(
  $$ select attempt_count, available_at from public.notification_outbox where id = (select id from t_claim2) $$,
  $$ values (1, now() + interval '1 minute') $$,
  'the first failure schedules a retry after 1 minute'
);

update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2b as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000004');
reset role;
grant select on t_claim2b to public;
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000004', 'smtp_5xx')),
  true,
  'the second failure is recorded'
);
select results_eq(
  $$ select attempt_count, available_at from public.notification_outbox where id = (select id from t_claim2) $$,
  $$ values (2, now() + interval '5 minutes') $$,
  'the second failure schedules a retry after 5 minutes'
);

update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2c as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000005');
reset role;
grant select on t_claim2c to public;
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000005', 'smtp_5xx')),
  true,
  'the third failure is recorded'
);
select results_eq(
  $$ select attempt_count, available_at from public.notification_outbox where id = (select id from t_claim2) $$,
  $$ values (3, now() + interval '30 minutes') $$,
  'the third failure schedules a retry after 30 minutes'
);

update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2d as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000006');
reset role;
grant select on t_claim2d to public;
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000006', 'smtp_5xx')),
  true,
  'the fourth failure is recorded'
);
select results_eq(
  $$ select attempt_count, available_at from public.notification_outbox where id = (select id from t_claim2) $$,
  $$ values (4, now() + interval '2 hours') $$,
  'the fourth failure schedules a retry after 2 hours'
);

update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2e as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000007');
reset role;
grant select on t_claim2e to public;
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000007', 'smtp_5xx')),
  true,
  'the fifth failure is recorded'
);
select results_eq(
  $$ select attempt_count, available_at from public.notification_outbox where id = (select id from t_claim2) $$,
  $$ values (5, now() + interval '6 hours') $$,
  'the fifth failure schedules a retry after 6 hours'
);

-- The sixth failure is terminal: attempt_count reaches 6 and the row stops being claimable
-- (34-36)
update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2f as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000008');
reset role;
grant select on t_claim2f to public;
select is(
  (select public.fail_notification_outbox((select id from t_claim2), '84000000-0000-0000-0000-000000000008', 'smtp_5xx')),
  true,
  'the sixth failure is recorded'
);
select is(
  (select attempt_count from public.notification_outbox where id = (select id from t_claim2)),
  6,
  'attempt_count reaches 6 after the sixth failure'
);

update public.notification_outbox set available_at = now() where id = (select id from t_claim2);
set local role service_role;
create temporary table t_claim2g as
select * from public.claim_notification_outbox(10, '84000000-0000-0000-0000-000000000009');
reset role;
grant select on t_claim2g to public;
select is(
  (select count(*)::int from t_claim2g where id = (select id from t_claim2)),
  0,
  'a row with 6 failed attempts is no longer claimable'
);

-- Browser roles cannot write either table directly (37-40)
set local role anon;
select throws_ok(
  $$insert into public.analytics_events (event_name) values ('view_book')$$,
  '42501'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$insert into public.analytics_events (event_name) values ('view_book')$$,
  '42501'
);
reset role;
set local role anon;
select throws_ok(
  $$insert into public.notification_outbox (entitlement_id, profile_id, template_key) values ('83000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'book_ready')$$,
  '42501'
);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$insert into public.notification_outbox (entitlement_id, profile_id, template_key) values ('83000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'book_ready')$$,
  '42501'
);
reset role;

-- An admin identity can actually read the fixture rows (not just avoid an error - RLS filters
-- rows silently rather than raising, so a bare `lives_ok(select ...)` would pass even if the
-- admin policy returned nothing) but cannot update or delete either table; a non-admin reader
-- sees zero rows in both, proving the admin-only select policy actually gates on `is_admin()`
-- (41-46). The fixture rows so far: one analytics_events row (the dedupe fixture, id
-- 's5-dedupe-fixture') and three notification_outbox rows (entitlements ...0001, ...0002,
-- ...0003 each produced exactly one; ...0004 produced none, per the no-backfill assertion above).
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::int from public.analytics_events),
  1,
  'an admin can read the analytics_events fixture row'
);
select throws_ok(
  $$ update public.analytics_events set occurred_at = now() $$,
  '42501'
);
select is(
  (select count(*)::int from public.notification_outbox),
  3,
  'an admin can read all three notification_outbox fixture rows'
);
select throws_ok(
  $$ delete from public.notification_outbox $$,
  '42501'
);
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-000000000001', true);
select is(
  (select count(*)::int from public.analytics_events),
  0,
  'a non-admin reader sees no analytics_events rows'
);
select is(
  (select count(*)::int from public.notification_outbox),
  0,
  'a non-admin reader sees no notification_outbox rows'
);
reset role;

-- Grant posture (47-51), asserted as the elevated connecting role so every grant on every role is
-- visible - matching supabase/tests/001 and 002. Unlike those tests, REFERENCES and TRIGGER are
-- not excluded: the migration revokes all and re-grants exactly, so an auto-exposed default-ACL
-- privilege (including TRUNCATE, which bypasses the row-level delete trigger) must never survive.
select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('analytics_events', 'notification_outbox')
      and grantee in ('anon', 'PUBLIC')$$,
  'anon and PUBLIC hold no privilege on analytics_events or notification_outbox'
);
select set_eq(
  $$select table_name::text, privilege_type::text from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('analytics_events', 'notification_outbox')
      and grantee = 'authenticated'$$,
  $$values ('analytics_events', 'SELECT'), ('notification_outbox', 'SELECT')$$,
  'authenticated holds exactly SELECT on analytics_events and notification_outbox'
);
select set_eq(
  $$select table_name::text, privilege_type::text from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('analytics_events', 'notification_outbox')
      and grantee = 'service_role'$$,
  $$values ('analytics_events', 'SELECT'), ('analytics_events', 'INSERT'), ('notification_outbox', 'SELECT')$$,
  'service_role holds exactly SELECT+INSERT on analytics_events and SELECT on notification_outbox'
);
select is_empty(
  $$select table_name, grantee from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('analytics_events', 'notification_outbox')
      and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
      and privilege_type = 'TRUNCATE'$$,
  'no API role holds TRUNCATE on analytics_events or notification_outbox'
);
select throws_ok(
  $$truncate public.analytics_events$$,
  '55000',
  null,
  'the statement-level trigger blocks TRUNCATE on analytics_events even for the table owner'
);

-- Without the grant, service_role cannot reach the trigger at all (52), and the append-only
-- log still accepts an ordinary insert afterwards (53).
set local role service_role;
select throws_ok(
  $$truncate public.analytics_events$$,
  '42501',
  null,
  'service_role cannot truncate analytics_events'
);
select lives_ok(
  $$insert into public.analytics_events (event_name) values ('view_library')$$,
  'service_role can still insert into analytics_events'
);
reset role;

select * from finish();
rollback;
