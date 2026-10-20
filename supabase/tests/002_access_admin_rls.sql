begin;
select plan(43);

-- Fixed fixtures, inserted with elevated privileges before switching roles. Profiles and
-- customer_identities are created by the auth.users bootstrap trigger, not inserted directly.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'other@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.authors (id, canonical_slug, display_name, status) values
  ('20000000-0000-0000-0000-000000000001', 'admin-test-author', 'Admin Test Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('30000000-0000-0000-0000-000000000001', 'admin-test-book', 'vi', '20000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code) values
  ('45000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'ADMIN-TEST-SKU');
insert into public.ebook_assets (id, edition_id, source_storage_key, source_checksum, version, status) values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'admin-test/source.epub', 'sha-admin', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'admin-test/manifest.json', 'published');

insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000001', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000002', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';

insert into public.order_items (id, order_id, sku_id, book_id, title_snapshot, unit_price_minor)
values
  ('71000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', '45000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Admin Test Book', 0),
  ('71000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', '45000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Admin Test Book', 0);

insert into public.payments (id, order_id, provider, status, amount_minor, currency)
values ('72000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'simulator', 'succeeded', 0, 'VND');
insert into public.payment_events (id, payment_id, provider, provider_event_id, payload_hash)
values ('73000000-0000-0000-0000-000000000001', '72000000-0000-0000-0000-000000000001', 'simulator', 'evt-1', 'hash-1');

-- reading_progress rows for both users, needed for the owner-write assertions below (Important #1).
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select id, '60000000-0000-0000-0000-000000000001', '{}'::jsonb, 0, 'seed-device', 1
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select id, '60000000-0000-0000-0000-000000000001', '{}'::jsonb, 0, 'seed-device', 1
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';

insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000003';
-- (Minor #1) a non-admin role holder, so removing is_admin()'s role filter has a fixture to fail against.
insert into public.user_roles (profile_id, role)
select id, 'reader' from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';

insert into public.audit_logs (id, actor_profile_id, action, entity_type, entity_id)
select '74000000-0000-0000-0000-000000000001', id, 'grant_entitlement', 'entitlement', null
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000003';

insert into public.redirects (id, source_path, destination_path)
values ('75000000-0000-0000-0000-000000000001', '/old-path', '/new-path');
insert into public.merchandising_slots (id, slot_key, book_id)
values ('76000000-0000-0000-0000-000000000001', 'home_featured', '30000000-0000-0000-0000-000000000001');

-- (l) service_role: proves ruling 2's grant, and is the assertion that catches its removal.
-- The array covers both Task 5's and Task 6's tables (Minor #11), since Task 5's grant block
-- lives in an unreleased migration this suite is equally responsible for pinning.
select is(
  (
    select bool_and(has_table_privilege('service_role', 'public.' || t, p))
    from unnest(array[
      'authors', 'books', 'book_localizations', 'topics', 'book_topics', 'editions', 'skus',
      'offers', 'media_assets', 'ebook_assets', 'ebook_publications', 'processing_jobs',
      'ebook_resources', 'book_samples',
      'profiles', 'customer_identities', 'orders', 'entitlements', 'library_items',
      'reading_progress', 'reader_sessions', 'order_items', 'payments', 'payment_events',
      'user_roles', 'audit_logs', 'redirects', 'merchandising_slots'
    ]) as t
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p
  ),
  true,
  'service_role holds select, insert, update, and delete on every Task 5 and Task 6 table'
);

-- Grant posture, asserted while still connected as the elevated test-runner role so every grant
-- on every role is visible. Only REFERENCES and TRIGGER are excluded, since those are
-- pre-existing default-ACL entries this migration never touches (see supabase/config.toml
-- auto_expose_new_tables); TRUNCATE is included below because ruling 1 explicitly revokes it,
-- matching supabase/tests/001_catalog_publishing_rls.sql.
select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('profiles', 'customer_identities', 'orders', 'entitlements', 'library_items',
                          'reading_progress', 'reader_sessions', 'order_items', 'payments', 'payment_events',
                          'user_roles', 'audit_logs', 'redirects', 'merchandising_slots')
      and grantee = 'anon'
      and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')$$,
  'anon holds no select or write privileges on the Task 6 tables'
);
select is_empty(
  $$select table_name, privilege_type from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('profiles', 'customer_identities', 'orders', 'entitlements', 'library_items',
                          'reading_progress', 'reader_sessions', 'order_items', 'payments', 'payment_events',
                          'user_roles', 'audit_logs', 'redirects', 'merchandising_slots')
      and grantee = 'authenticated'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')$$,
  'authenticated holds none of the revoked table-level write privileges on the Task 6 tables'
);
select is(
  (select count(distinct table_name) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('profiles', 'customer_identities', 'orders', 'entitlements', 'library_items',
                           'reading_progress', 'reader_sessions', 'order_items', 'payments', 'payment_events',
                           'user_roles', 'audit_logs', 'redirects', 'merchandising_slots')
       and grantee = 'authenticated'
       and privilege_type = 'SELECT')::int,
  14,
  'authenticated holds SELECT on all 14 Task 6 tables'
);

-- (j) reader_sessions rejects a publication_version that does not match its publication.
select throws_ok(
  $$insert into public.reader_sessions (profile_id, publication_id, publication_version, expires_at)
    select p.id, '60000000-0000-0000-0000-000000000001', 99, now() + interval '15 minutes'
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '23503',
  null,
  'reader_sessions rejects a publication_version that does not match the publication'
);

-- (k) entitlement source consistency checks.
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, source_order_id)
    select p.id, '30000000-0000-0000-0000-000000000001', 'admin_grant', p.id, '   ', null
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000003'$$,
  '23514',
  null,
  'admin_grant entitlement requires a non-empty reason'
);
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, source_order_id)
    select p.id, '30000000-0000-0000-0000-000000000001', 'free_order', null
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'free_order entitlement requires a source_order_id'
);
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, source_order_id)
    select p.id, '30000000-0000-0000-0000-000000000001', 'admin_grant', null, 'valid reason', null
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000003'$$,
  '23514',
  null,
  'admin_grant entitlement requires a non-null actor_profile_id'
);
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, source_order_id)
    select p.id, '30000000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'valid reason', '70000000-0000-0000-0000-000000000001'
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000003'$$,
  '23514',
  null,
  'admin_grant entitlement rejects a non-null source_order_id'
);
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, source_order_id)
    select p.id, '30000000-0000-0000-0000-000000000001', 'simulated_payment', null
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'simulated_payment entitlement requires a source_order_id'
);
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
    select p.id, '30000000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'valid reason', 'revoked'
    from public.profiles p where p.auth_user_id = '10000000-0000-0000-0000-000000000003'$$,
  '23514',
  null,
  'a revoked entitlement requires a non-null revoked_at'
);

-- (Minor #4) an auth.users insert with a null email still creates a profile, but no identity.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', null, '', null, '{}'::jsonb, '{}'::jsonb, now(), now());
select ok(
  exists(select 1 from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000004'),
  'auth.users insert with a null email still creates a profile'
);
select ok(
  not exists(
    select 1 from public.customer_identities ci
    join public.profiles p on p.id = ci.profile_id
    where p.auth_user_id = '10000000-0000-0000-0000-000000000004'
  ),
  'auth.users insert with a null email creates no customer_identity'
);

-- (h) auth.users email_confirmed_at update syncs the identity's verified_at.
update auth.users set email_confirmed_at = '2030-01-01 00:00:00+00'::timestamptz
where id = '10000000-0000-0000-0000-000000000001';
select is(
  (select verified_at from public.customer_identities
     where profile_id = (select id from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001')),
  '2030-01-01 00:00:00+00'::timestamptz,
  'auth.users email_confirmed_at update syncs customer_identities.verified_at'
);

-- (Minor #10) normalization: a mixed-case, whitespace-padded email is lower-cased and trimmed.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', ' NormTest@Example.test ', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
select is(
  (select normalized_email from public.customer_identities
     where profile_id = (select id from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000005')),
  'normtest@example.test',
  'auth.users insert normalizes a mixed-case, padded email'
);

-- (Minor #10) the email-change path of the UPDATE branch re-syncs normalized_email, not just verified_at.
update auth.users set email = ' Other2@Example.test ' where id = '10000000-0000-0000-0000-000000000002';
select is(
  (select normalized_email from public.customer_identities
     where profile_id = (select id from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002')),
  'other2@example.test',
  'auth.users email update re-syncs customer_identities.normalized_email'
);

-- (i) audit_logs is immutable even for service_role. service_role is used here (rather than
-- anon/authenticated, which hold no privilege on audit_logs at all and would just get 42501)
-- because it is the only non-superuser role with UPDATE/DELETE/TRUNCATE on this table, so it is
-- the role that actually reaches the trigger rather than being stopped earlier by a grant check.
set local role service_role;
select throws_ok(
  $$update public.audit_logs set reason = 'edited' where id = '74000000-0000-0000-0000-000000000001'$$,
  'P0001',
  null,
  'service_role cannot update audit_logs rows'
);
select throws_ok(
  $$delete from public.audit_logs where id = '74000000-0000-0000-0000-000000000001'$$,
  'P0001',
  null,
  'service_role cannot delete audit_logs rows'
);
select throws_ok(
  $$truncate public.audit_logs$$,
  'P0001',
  null,
  'service_role cannot truncate audit_logs'
);
reset role;

-- Assertions as anon.
set local role anon;

-- (a) anon is denied on the Task 6 tables (no grant exists on any of them).
select throws_ok(
  $$select * from public.profiles$$,
  '42501',
  null,
  'anon: select from profiles is rejected'
);
select throws_ok(
  $$select * from public.audit_logs$$,
  '42501',
  null,
  'anon: select from audit_logs is rejected'
);

-- (g) anon cannot execute is_admin().
select throws_ok(
  $$select public.is_admin()$$,
  '42501',
  null,
  'anon: execute on is_admin() is rejected'
);

reset role;

-- Assertions as authenticated, acting as the reader.
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);

-- (b) a reader gets zero rows across every admin-facing table.
select is(
  (
    (select count(*) from public.customer_identities) +
    (select count(*) from public.payments) +
    (select count(*) from public.payment_events) +
    (select count(*) from public.user_roles) +
    (select count(*) from public.audit_logs) +
    (select count(*) from public.redirects) +
    (select count(*) from public.merchandising_slots)
  )::bigint,
  0::bigint,
  'reader: zero rows visible across all admin-facing tables'
);

-- (c) a reader reads their own order_items but not another user's.
select results_eq(
  'select count(*) from public.order_items',
  array[1::bigint],
  'reader: sees only their own order_items'
);
select ok(
  not exists(select 1 from public.order_items where id = '71000000-0000-0000-0000-000000000002'),
  'reader: cannot see another user''s order_item'
);

-- (Important #1) the only two browser write paths. Both run with no WHERE clause, so the UPDATE
-- policy's USING clause is the only thing scoping the affected rows, and deliberately without
-- RETURNING: a RETURNING clause makes PostgreSQL re-apply the table's SELECT policy to the
-- updated rows, which would silently mask a broken UPDATE policy (loosening USING to `true` still
-- returns only the caller's own row, because the unrelated SELECT policy filters what comes back
-- from RETURNING). `lives_ok` only proves the write is allowed at all (RLS + the column grant);
-- how many rows it actually touched is asserted after `reset role` below, with RLS out of the way.
select lives_ok(
  $$update public.profiles set display_name = 'mine'$$,
  'reader: can update their own display_name'
);
select lives_ok(
  $$update public.reading_progress set progression = 0.5$$,
  'reader: can update their own reading_progress'
);

-- (e) authenticated INSERT is rejected on the trusted-server-only tables.
select throws_ok(
  $$insert into public.entitlements (profile_id, book_id, source_type, source_order_id)
    select id, '30000000-0000-0000-0000-000000000001', 'free_order', '70000000-0000-0000-0000-000000000001'
    from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'authenticated: insert into entitlements is rejected'
);
select throws_ok(
  $$insert into public.orders (profile_id, status, payment_status, market_code, currency, total_minor)
    select id, 'draft', 'not_required', 'VN', 'VND', 0
    from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'authenticated: insert into orders is rejected'
);
select throws_ok(
  $$insert into public.payments (order_id, provider, status, amount_minor, currency)
    values ('70000000-0000-0000-0000-000000000001', 'simulator', 'pending', 0, 'VND')$$,
  '42501',
  null,
  'authenticated: insert into payments is rejected'
);
select throws_ok(
  $$insert into public.user_roles (profile_id, role)
    select id, 'admin' from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'authenticated: insert into user_roles is rejected'
);
select throws_ok(
  $$insert into public.audit_logs (action, entity_type)
    values ('self-grant', 'entitlement')$$,
  '42501',
  null,
  'authenticated: insert into audit_logs is rejected'
);

-- (f) updating a disallowed profile column is rejected.
select throws_ok(
  $$update public.profiles set auth_user_id = '10000000-0000-0000-0000-000000000002'
    where auth_user_id = '10000000-0000-0000-0000-000000000001'$$,
  '42501',
  null,
  'authenticated: updating profiles.auth_user_id is rejected'
);

-- (Minor #1) a profile holding the 'reader' role in user_roles is not treated as admin. Without
-- this, removing is_admin()'s `ur.role = 'admin'` filter would pass every other assertion, since
-- no other fixture user holds a non-admin user_roles row.
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select is(public.is_admin(), false, 'a user_roles row with role ''reader'' is not admin');

-- (d) an admin reads the admin-facing tables.
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
select results_eq(
  'select count(*) from public.customer_identities',
  array[4::bigint],
  'admin: reads all customer_identities'
);
select results_eq(
  'select count(*) from public.payments',
  array[1::bigint],
  'admin: reads payments'
);
select results_eq(
  'select count(*) from public.payment_events',
  array[1::bigint],
  'admin: reads payment_events'
);
select results_eq(
  'select count(*) from public.user_roles',
  array[2::bigint],
  'admin: reads user_roles'
);
select results_eq(
  'select count(*) from public.audit_logs',
  array[2::bigint],
  'admin: reads audit_logs'
);
select results_eq(
  'select count(*) from public.redirects',
  array[1::bigint],
  'admin: reads redirects'
);
select results_eq(
  'select count(*) from public.merchandising_slots',
  array[1::bigint],
  'admin: reads merchandising_slots'
);

reset role;

-- (Important #1) row-scoping proof for the two writes above, with RLS out of the way (the
-- connecting role) so every profile/progress row is visible regardless of ownership. There are
-- 5 profiles and 2 reading_progress rows in this fixture; each query below must return exactly
-- reader A's row, or it fails on either row count or row identity. This is what actually catches
-- a USING (true) (or a missing WITH CHECK) on either UPDATE policy, since a RETURNING-based
-- check above would have been masked by the unrelated SELECT policy (see the comment there).
select results_eq(
  $$select auth_user_id from public.profiles where display_name = 'mine'$$,
  array['10000000-0000-0000-0000-000000000001'::uuid],
  'exactly reader A''s profile was updated to display_name = mine'
);
select results_eq(
  $$select p.auth_user_id from public.reading_progress rp
    join public.profiles p on p.id = rp.profile_id
    where rp.progression = 0.5$$,
  array['10000000-0000-0000-0000-000000000001'::uuid],
  'exactly reader A''s reading_progress row was updated to progression = 0.5'
);

select * from finish();
rollback;
