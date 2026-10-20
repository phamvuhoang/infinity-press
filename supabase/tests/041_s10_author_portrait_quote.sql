begin;
select plan(13);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
('00000000-0000-0000-0000-000000000000', 'db000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'portrait-admin@example.test', '', now(), '{}', '{}', now(), now()),
('00000000-0000-0000-0000-000000000000', 'db000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'portrait-reader@example.test', '', now(), '{}', '{}', now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'db000000-0000-4000-8000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('db100000-0000-4000-8000-000000000001', 'portrait-author', 'Portrait Author', 'published');
insert into storage.objects (bucket_id, name) values
('covers', 'authors/db100000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp');

insert into public.topics (id, canonical_slug, name, status)
values ('db200000-0000-4000-8000-000000000001', 'portrait-topic', 'Portrait Topic', 'published');

select has_column('public', 'author_localizations', 'quote', 'authors carry a localized quote');
select has_function('public', 'admin_set_author_image', array['uuid', 'text', 'text', 'integer', 'integer'], 'portrait write RPC exists');
select has_function('public', 'admin_get_author_image', array['uuid'], 'portrait read RPC exists');
-- The six-argument signature is gone, so no call can resolve to a version that drops the quote.
select is((select count(*) from pg_proc where proname = 'admin_save_entity_localization'), 1::bigint,
  'only the quote-aware localization RPC remains');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'db000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.admin_set_author_image('db100000-0000-4000-8000-000000000001', 'authors/db100000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'A portrait', null, null)$$,
  '42501', null, 'a non-admin cannot set a portrait');
select throws_ok($$select * from public.admin_get_author_image('db100000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a non-admin cannot read the portrait key');

select set_config('request.jwt.claim.sub', 'db000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.admin_set_author_image('db100000-0000-4000-8000-000000000001', 'authors/db100000-0000-4000-8000-000000000002/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'A portrait', null, null)$$,
  '22023', null, 'a key belonging to another author is rejected');
select throws_ok(
  $$select public.admin_set_author_image('db100000-0000-4000-8000-000000000001', 'authors/db100000-0000-4000-8000-000000000001/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp', 'A portrait', null, null)$$,
  'P0002', null, 'a key with no storage object is rejected');

select lives_ok(
  $$select public.admin_set_author_image('db100000-0000-4000-8000-000000000001', 'authors/db100000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', '  A portrait  ', 800, 1000)$$,
  'an admin sets the portrait');
select results_eq(
  $$select storage_key, alt_text from public.admin_get_author_image('db100000-0000-4000-8000-000000000001')$$,
  $$values ('authors/db100000-0000-4000-8000-000000000001/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'::text, 'A portrait'::text)$$,
  'the admin read returns the trimmed portrait');

-- The quote round-trips for authors and is dropped for the other entity types.
select lives_ok(
  $$select public.admin_save_entity_localization('author', 'db100000-0000-4000-8000-000000000001', 'vi', 'portrait-author', 'Portrait Author', 'Tiểu sử.', '  Tôi viết để bạn nhìn lại.  ')$$,
  'an admin saves an author quote');
select is(
  (select quote from public.author_localizations where author_id = 'db100000-0000-4000-8000-000000000001' and locale = 'vi'),
  'Tôi viết để bạn nhìn lại.',
  'the quote is stored trimmed');

select lives_ok(
  $$select public.admin_save_entity_localization('topic', 'db200000-0000-4000-8000-000000000001', 'vi', 'portrait-topic', 'Chủ đề', 'Mô tả.', 'Ignored')$$,
  'a quote sent for a topic is accepted and dropped');
reset role;

select * from finish();
rollback;
