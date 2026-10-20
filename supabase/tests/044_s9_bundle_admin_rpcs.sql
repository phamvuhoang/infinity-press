begin;
select plan(59);

-- S9: the audited bundle admin RPCs and the publish gate
-- (docs/superpowers/specs/2026-09-21-s9-bundles-and-gifts-design.md 6.2, 6.4).
--
-- 043_s9_bundle_schema.sql proved that no browser role can write a bundle table at all. This file
-- proves the only remaining write path is sound: each RPC is admin-only, validates its input,
-- performs one logical mutation, and leaves exactly one audit row behind. The storage/bucket rules
-- for a bundle cover are asserted here rather than in 043, because that is where they live -
-- admin_set_bundle_cover enforces them, not a constraint.

-- Fixtures ------------------------------------------------------------------------------------
--
-- Two published books and one draft book: the draft one is what separates "has two members" from
-- "has two PUBLISHED members", which is the whole point of too_few_published_members.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's9-bundle-rpc-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's9-bundle-rpc-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('c3000000-0000-0000-0000-000000000001', 's9-rpc-author', 'S9 RPC Author', 'published');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('c2000000-0000-0000-0000-000000000001', 's9-rpc-book-1', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published'),
  ('c2000000-0000-0000-0000-000000000002', 's9-rpc-book-2', 'vi', 'c3000000-0000-0000-0000-000000000001', 'published'),
  ('c2000000-0000-0000-0000-000000000003', 's9-rpc-book-3', 'vi', 'c3000000-0000-0000-0000-000000000001', 'draft');

-- A bundle created directly, so the non-admin refusals below have a real id to call against
-- without any of them having had to succeed first.
insert into public.bundles (id, status) values ('c7000000-0000-0000-0000-000000000001', 'draft');

-- Ids minted by gen_random_uuid() inside admin_create_bundle cannot be hardcoded.
create temporary table t_bundles (label text primary key, id uuid);
grant select, insert on t_bundles to public;

-- Shape ---------------------------------------------------------------------------------------
select has_function('public', 'admin_create_bundle', array['text', 'text', 'text'], 'admin_create_bundle exists');
select has_function('public', 'admin_save_bundle_localization', array['uuid', 'text', 'text', 'text', 'text', 'text'],
  'admin_save_bundle_localization exists');
select has_function('public', 'admin_set_bundle_members', array['uuid', 'uuid[]'], 'admin_set_bundle_members exists');
select has_function('public', 'admin_set_bundle_offer', array['uuid', 'text', 'text', 'bigint', 'boolean'],
  'admin_set_bundle_offer exists');
select has_function('public', 'admin_set_bundle_cover', array['uuid', 'text', 'text', 'integer', 'integer'],
  'admin_set_bundle_cover exists');
select has_function('public', 'publish_bundle', array['uuid'], 'publish_bundle exists');
select has_function('public', 'unpublish_bundle', array['uuid'], 'unpublish_bundle exists');

-- Every one of them is a definer function with an empty search_path and no PUBLIC execute grant,
-- asserted over the whole set rather than one at a time so a future eighth RPC cannot slip past.
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('admin_create_bundle', 'admin_save_bundle_localization', 'admin_set_bundle_members',
                       'admin_set_bundle_offer', 'admin_set_bundle_cover', 'publish_bundle', 'unpublish_bundle',
                       'bundle_readiness_issues')
     and (not p.prosecdef or not (p.proconfig @> array['search_path=""']))),
  0::bigint,
  'every bundle admin function is security definer with an empty search_path');
select is(
  (select count(*) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace,
   lateral aclexplode(p.proacl) a
   where n.nspname = 'public'
     and p.proname in ('admin_create_bundle', 'admin_save_bundle_localization', 'admin_set_bundle_members',
                       'admin_set_bundle_offer', 'admin_set_bundle_cover', 'publish_bundle', 'unpublish_bundle',
                       'bundle_readiness_issues')
     and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0::bigint,
  'PUBLIC holds no execute grant on any bundle admin function');
select is(
  has_function_privilege('anon', 'public.admin_create_bundle(text, text, text)', 'EXECUTE'),
  false, 'anon holds no EXECUTE on admin_create_bundle');
select is(
  has_function_privilege('authenticated', 'public.bundle_readiness_issues(uuid)', 'EXECUTE'),
  false, 'the readiness helper is internal to publish_bundle, not a browser-callable function');

-- A signed-in reader reaches none of it --------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_create_bundle('vi', 'sneaky-bundle', 'Sneaky')$$,
  '42501', null, 'a reader cannot create a bundle');
select throws_ok(
  $$select public.admin_save_bundle_localization('c7000000-0000-0000-0000-000000000001', 'vi', 'sneaky', 'Sneaky', null, null)$$,
  '42501', null, 'a reader cannot localize a bundle');
select throws_ok(
  $$select public.admin_set_bundle_members('c7000000-0000-0000-0000-000000000001', array['c2000000-0000-0000-0000-000000000001']::uuid[])$$,
  '42501', null, 'a reader cannot set bundle members');
select throws_ok(
  $$select public.admin_set_bundle_offer('c7000000-0000-0000-0000-000000000001', 'VN', 'VND', 1, true)$$,
  '42501', null, 'a reader cannot price a bundle');
select throws_ok(
  $$select public.admin_set_bundle_cover('c7000000-0000-0000-0000-000000000001', 'bundles/c7000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'Alt', 1, 1)$$,
  '42501', null, 'a reader cannot set a bundle cover');
select throws_ok(
  $$select public.publish_bundle('c7000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'a reader cannot publish a bundle');
select throws_ok(
  $$select public.unpublish_bundle('c7000000-0000-0000-0000-000000000001')$$,
  '42501', null, 'a reader cannot unpublish a bundle');
reset role;

-- Creation --------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

insert into t_bundles (label, id)
select 'main', public.admin_create_bundle('vi', 'goi-sach-tinh-thuc', 'Gói sách tỉnh thức');

select is(
  (select b.status from public.bundles b where b.id = (select id from t_bundles where label = 'main')),
  'draft'::public.content_status,
  'a new bundle starts as a draft');
select is(
  (select l.title from public.bundle_localizations l
   where l.bundle_id = (select id from t_bundles where label = 'main') and l.locale = 'vi'),
  'Gói sách tỉnh thức',
  'creation seeds the first localization');
select is(
  (select count(*) from public.audit_logs a where a.action = 'create_bundle'),
  1::bigint, 'creating a bundle writes exactly one audit row');
select is(
  (select a.entity_type from public.audit_logs a where a.action = 'create_bundle'),
  'bundles', 'the create audit row names the bundles table');
select throws_ok(
  $$select public.admin_create_bundle('fr', 'coffret', 'Coffret')$$,
  '22023', null, 'a locale outside vi|en is refused');
select throws_ok(
  $$select public.admin_save_bundle_localization('c7000000-0000-0000-0000-0000000000ff', 'vi', 'x', 'X', null, null)$$,
  'P0002', null, 'localizing a bundle that does not exist is refused');

-- Members ---------------------------------------------------------------------------------------
select throws_ok(
  format($$select public.admin_set_bundle_members(%L, array['c2000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001']::uuid[])$$,
         (select id from t_bundles where label = 'main')),
  '22023', null, 'the same book cannot be listed twice');
select throws_ok(
  format($$select public.admin_set_bundle_members(%L, '{}'::uuid[])$$, (select id from t_bundles where label = 'main')),
  '22023', null, 'a bundle cannot be emptied of members');
select throws_ok(
  format($$select public.admin_set_bundle_members(%L, array['c2000000-0000-0000-0000-0000000000ee']::uuid[])$$,
         (select id from t_bundles where label = 'main')),
  'P0002', null, 'a book that does not exist cannot be a member');

select public.admin_set_bundle_members(
  (select id from t_bundles where label = 'main'),
  array['c2000000-0000-0000-0000-000000000002', 'c2000000-0000-0000-0000-000000000001']::uuid[]);
select results_eq(
  format($$select book_id, position from public.bundle_books where bundle_id = %L order by position$$,
         (select id from t_bundles where label = 'main')),
  $$values ('c2000000-0000-0000-0000-000000000002'::uuid, 1), ('c2000000-0000-0000-0000-000000000001'::uuid, 2)$$,
  'members are numbered in the order they were submitted, not by id');

-- Reordering is the same call with the list rearranged, and a third member appended.
select public.admin_set_bundle_members(
  (select id from t_bundles where label = 'main'),
  array['c2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000003',
        'c2000000-0000-0000-0000-000000000002']::uuid[]);
select results_eq(
  format($$select book_id, position from public.bundle_books where bundle_id = %L order by position$$,
         (select id from t_bundles where label = 'main')),
  $$values ('c2000000-0000-0000-0000-000000000001'::uuid, 1), ('c2000000-0000-0000-0000-000000000003'::uuid, 2),
           ('c2000000-0000-0000-0000-000000000002'::uuid, 3)$$,
  'resubmitting the list renumbers every member, leaving no stale position behind');
select is(
  (select count(*) from public.audit_logs a where a.action = 'set_bundle_members'),
  2::bigint, 'each member change writes exactly one audit row');

-- Offer -------------------------------------------------------------------------------------------
select public.admin_set_bundle_offer((select id from t_bundles where label = 'main'), 'VN', 'VND', 199000, true);
select is(
  (select o.price_minor from public.offers o where o.bundle_id = (select id from t_bundles where label = 'main')),
  199000::bigint, 'the bundle carries its price');
select is(
  (select o.sku_id from public.offers o where o.bundle_id = (select id from t_bundles where label = 'main')),
  null::uuid, 'a bundle offer names no sku, satisfying offers_exactly_one_product');

-- The same market and currency again is an edit of the one offer, not a second row: the partial
-- unique index would refuse a second row anyway, so anything but an upsert would be an error the
-- operator sees when they change a price.
select public.admin_set_bundle_offer((select id from t_bundles where label = 'main'), 'VN', 'VND', 149000, true);
select is(
  (select count(*) from public.offers o where o.bundle_id = (select id from t_bundles where label = 'main')),
  1::bigint, 'repricing the same market and currency edits the one offer');
select is(
  (select o.price_minor from public.offers o where o.bundle_id = (select id from t_bundles where label = 'main')),
  149000::bigint, 'the new price took effect');
select is(
  (select count(*) from public.audit_logs a where a.action = 'set_bundle_offer'),
  2::bigint, 'each pricing change writes exactly one audit row');

-- Cover ---------------------------------------------------------------------------------------
-- The bucket fixtures need the generated bundle id, so they are written after creation. Only the
-- first key exists as a storage object; the second is a real key shape that was never uploaded.
reset role;
insert into storage.objects (bucket_id, name)
select 'covers', 'bundles/' || id || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp' from t_bundles where label = 'main';
insert into storage.objects (bucket_id, name)
select 'covers', 'bundles/' || id || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp' from t_bundles where label = 'main';
insert into storage.objects (bucket_id, name)
values ('covers', 'bundles/c7000000-0000-0000-0000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

select throws_ok(
  format($$select public.admin_set_bundle_cover(%L, 'bundles/c7000000-0000-0000-0000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp', 'Alt', 1, 1)$$,
         (select id from t_bundles where label = 'main')),
  '22023', null, 'a key minted under another bundle cannot be attached');
select throws_ok(
  format($$select public.admin_set_bundle_cover(%L, %L, 'Alt', 1, 1)$$,
         (select id from t_bundles where label = 'main'),
         'covers/' || (select id from t_bundles where label = 'main') || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'),
  '22023', null, 'a key outside the bundles/{id}/ prefix is refused');
select throws_ok(
  format($$select public.admin_set_bundle_cover(%L, %L, 'Alt', 1, 1)$$,
         (select id from t_bundles where label = 'main'),
         'bundles/' || (select id from t_bundles where label = 'main') || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.gif'),
  '22023', null, 'a cover extension outside jpg|png|webp is refused');
select throws_ok(
  format($$select public.admin_set_bundle_cover(%L, %L, 'Alt', 1, 1)$$,
         (select id from t_bundles where label = 'main'),
         'bundles/' || (select id from t_bundles where label = 'main') || '/dddddddd-dddd-4ddd-8ddd-dddddddddddd.webp'),
  'P0002', null, 'a key that names no object in the covers bucket is refused');
select throws_ok(
  format($$select public.admin_set_bundle_cover(%L, %L, '   ', 1, 1)$$,
         (select id from t_bundles where label = 'main'),
         'bundles/' || (select id from t_bundles where label = 'main') || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'),
  '22023', null, 'blank alt text is refused');

select lives_ok(
  format($$select public.admin_set_bundle_cover(%L, %L, '  Hai cuốn sách  ', 1200, 1600)$$,
         (select id from t_bundles where label = 'main'),
         'bundles/' || (select id from t_bundles where label = 'main') || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'),
  'an uploaded key under the bundle''s own prefix is attached');
select is(
  (select m.alt_text from public.media_assets m
   where m.owner_type = 'bundle' and m.owner_id = (select id from t_bundles where label = 'main')),
  'Hai cuốn sách', 'alt text is stored trimmed');

select public.admin_set_bundle_cover(
  (select id from t_bundles where label = 'main'),
  'bundles/' || (select id from t_bundles where label = 'main') || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp',
  'Bìa mới', 1200, 1600);
select is(
  (select count(*) from public.media_assets m
   where m.owner_type = 'bundle' and m.owner_id = (select id from t_bundles where label = 'main')),
  1::bigint, 'replacing the cover updates the one media row rather than adding a second');
-- Selected by the key it wrote rather than by created_at: both rows are written inside one
-- transaction, so now() - and therefore created_at - is identical for them.
select is(
  (select a.metadata ->> 'previous_storage_key' from public.audit_logs a
   where a.action = 'set_bundle_cover'
     and a.metadata ->> 'storage_key' = 'bundles/' || (select id from t_bundles where label = 'main') || '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp'),
  'bundles/' || (select id from t_bundles where label = 'main') || '/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
  'the cover audit row records the key that was replaced');

-- Publishing --------------------------------------------------------------------------------------
--
-- The bundle now has three members (two published), a cover, and an active offer, but its
-- localization still has no description - so exactly one blocking code is left.
select throws_ok(
  format($$select public.publish_bundle(%L)$$, (select id from t_bundles where label = 'main')),
  'EB026', 'publish_bundle: bundle is not ready: missing_localization',
  'publishing is refused while the localization is incomplete, naming the reason');

-- Parity with lib/catalog/bundle-readiness.ts: an untouched bundle reports every blocking code, in
-- the order checkBundleReadiness pushes them. This literal and the matching Vitest expectation are
-- the parity contract between the two implementations.
-- bundle_readiness_issues is executable by no browser role, so this one assertion steps out of
-- the admin session to call it directly; publish_bundle is how `authenticated` reaches it.
reset role;
select is(
  array_to_string(public.bundle_readiness_issues('c7000000-0000-0000-0000-000000000001'), ','),
  'too_few_published_members,missing_localization,missing_cover,missing_offer',
  'the SQL gate reports the same blocking codes, in the same order, as checkBundleReadiness');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);

select public.admin_save_bundle_localization(
  (select id from t_bundles where label = 'main'), 'vi', 'goi-sach-tinh-thuc', 'Gói sách tỉnh thức',
  'Hai cuốn', 'Trọn bộ hai cuốn sách.');
select is(
  (select count(*) from public.audit_logs a where a.action = 'save_bundle_localization'),
  1::bigint, 'saving a localization writes exactly one audit row');
select lives_ok(
  format($$select public.publish_bundle(%L)$$, (select id from t_bundles where label = 'main')),
  'a complete bundle publishes');
select is(
  (select b.status from public.bundles b where b.id = (select id from t_bundles where label = 'main')),
  'published'::public.content_status, 'publishing sets the bundle live');
select is(
  (select count(*) from public.audit_logs a where a.action = 'publish_bundle'),
  1::bigint, 'publishing writes exactly one audit row');
select throws_ok(
  $$select public.publish_bundle('c7000000-0000-0000-0000-0000000000ff')$$,
  'P0002', null, 'publishing a bundle that does not exist is refused');

-- Only two of the three members are published, which is what readiness requires; the third being
-- a draft is a warning the editor shows, never a refusal.
select is(
  (select count(*) from public.bundle_books bb join public.books b on b.id = bb.book_id
   where bb.bundle_id = (select id from t_bundles where label = 'main') and b.status <> 'published'),
  1::bigint, 'the published bundle still holds one unpublished member, the warning case');

-- Renaming a published bundle -----------------------------------------------------------------------
-- a -> b -> c must leave both old paths pointing at c. A chain (a -> b, b -> c) would cost a
-- reader two redirects and would break entirely once the first hop is pruned.
select public.admin_save_bundle_localization(
  (select id from t_bundles where label = 'main'), 'vi', 'goi-sach-b', 'Gói sách tỉnh thức', 'Hai cuốn', 'Trọn bộ hai cuốn sách.');
select public.admin_save_bundle_localization(
  (select id from t_bundles where label = 'main'), 'vi', 'goi-sach-c', 'Gói sách tỉnh thức', 'Hai cuốn', 'Trọn bộ hai cuốn sách.');
select is(
  (select r.destination_path from public.redirects r where r.source_path = '/vi/bundles/goi-sach-tinh-thuc'),
  '/vi/bundles/goi-sach-c', 'the original slug points straight at the newest one');
select is(
  (select r.destination_path from public.redirects r where r.source_path = '/vi/bundles/goi-sach-b'),
  '/vi/bundles/goi-sach-c', 'the intermediate slug points at the newest one too');
select is(
  (select count(*) from public.redirects r where r.destination_path = '/vi/bundles/goi-sach-b'),
  0::bigint, 'no redirect is left pointing at the intermediate slug, so there is no chain');

-- Unpublishing ---------------------------------------------------------------------------------------
select public.unpublish_bundle((select id from t_bundles where label = 'main'));
select is(
  (select b.status from public.bundles b where b.id = (select id from t_bundles where label = 'main')),
  'draft'::public.content_status, 'unpublishing returns the bundle to draft');
select is(
  (select count(*) from public.audit_logs a where a.action = 'unpublish_bundle'),
  1::bigint, 'unpublishing writes exactly one audit row');
select throws_ok(
  $$select public.unpublish_bundle('c7000000-0000-0000-0000-0000000000ff')$$,
  'P0002', null, 'unpublishing a bundle that does not exist is refused');

-- A draft bundle's slug change is not a rename a reader can have followed, so it records nothing.
select public.admin_save_bundle_localization(
  (select id from t_bundles where label = 'main'), 'vi', 'goi-sach-d', 'Gói sách tỉnh thức', 'Hai cuốn', 'Trọn bộ hai cuốn sách.');
select is(
  (select count(*) from public.redirects r where r.source_path = '/vi/bundles/goi-sach-c'),
  0::bigint, 'renaming a draft bundle records no redirect');

reset role;
select * from finish();
rollback;
