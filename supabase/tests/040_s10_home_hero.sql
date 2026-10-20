begin;
select plan(14);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
('00000000-0000-0000-0000-000000000000', 'da000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'hero-admin@example.test', '', now(), '{}', '{}', now(), now()),
('00000000-0000-0000-0000-000000000000', 'da000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'hero-reader@example.test', '', now(), '{}', '{}', now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'da000000-0000-4000-8000-000000000001';

-- Two objects that exist, and one key that names an object that does not.
insert into storage.objects (bucket_id, name) values
('covers', 'home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp'),
('covers', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp');

select has_function('public', 'admin_set_home_hero', array['text', 'text', 'text'], 'hero write RPC exists');
select has_function('public', 'catalog_home_hero', 'hero read RPC exists');
select has_function('public', 'catalog_home_topics', array['text'], 'home topics RPC exists');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'da000000-0000-4000-8000-000000000002', true);
select throws_ok(
  $$select public.admin_set_home_hero('home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', 'A reading desk')$$,
  '42501', null, 'a non-admin cannot set the hero');
select throws_ok($$select public.admin_clear_home_hero()$$, '42501', null, 'a non-admin cannot clear the hero');

select set_config('request.jwt.claim.sub', 'da000000-0000-4000-8000-000000000001', true);
select throws_ok(
  $$select public.admin_set_home_hero('books/whatever/cover.webp', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', 'A reading desk')$$,
  '22023', null, 'a key outside home/hero/ is rejected');
select throws_ok(
  $$select public.admin_set_home_hero('home/hero/cccccccc-cccc-4ccc-8ccc-cccccccccccc.webp', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', 'A reading desk')$$,
  'P0002', null, 'a key with no storage object is rejected');
select throws_ok(
  $$select public.admin_set_home_hero('home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', '   ')$$,
  '22023', null, 'blank alt text is rejected');

select lives_ok(
  $$select public.admin_set_home_hero('home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', '  A reading desk  ')$$,
  'an admin sets the hero');
select is((select count(*) from public.home_hero), 1::bigint, 'the hero table holds one row');
select is(
  (select public.catalog_home_hero()),
  jsonb_build_object(
    'desktopPath', 'home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp',
    'mobilePath', 'home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp',
    'altText', 'A reading desk'),
  'the public read returns the trimmed hero');

-- A second write replaces the row rather than adding one.
select lives_ok(
  $$select public.admin_set_home_hero('home/hero/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp', 'home/hero/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp', 'Another desk')$$,
  'setting the hero again replaces it');
select is((select count(*) from public.home_hero), 1::bigint, 'the hero stays a singleton');

select lives_ok($$select public.admin_clear_home_hero()$$, 'an admin clears the hero');
reset role;

select * from finish();
rollback;
