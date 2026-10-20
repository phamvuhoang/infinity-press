begin;
select plan(8);
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'a@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'b@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.authors (id, canonical_slug, display_name, status)
values ('20000000-0000-0000-0000-000000000001', 'test-author', 'Test Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('30000000-0000-0000-0000-000000000001', 'book-a', 'vi', '20000000-0000-0000-0000-000000000001', 'published'),
  ('30000000-0000-0000-0000-000000000002', 'book-b', 'vi', '20000000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code)
values
  ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'vi'),
  ('40000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, source_checksum, version, status)
values
  ('50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'a/source.epub', 'sha-a', 1, 'published'),
  ('50000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 'b/source.epub', 'sha-b', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 1, 'a/manifest.json', 'published'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000002', 1, 'b/manifest.json', 'published');
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000001', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.orders (id, profile_id, status, payment_status, market_code, currency, total_minor)
select '70000000-0000-0000-0000-000000000002', id, 'completed', 'not_required', 'VN', 'VND', 0
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';
insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
select id, '30000000-0000-0000-0000-000000000001', 'free_order', '70000000-0000-0000-0000-000000000001', 'active'
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000001';
insert into public.entitlements (profile_id, book_id, source_type, source_order_id, status)
select id, '30000000-0000-0000-0000-000000000002', 'free_order', '70000000-0000-0000-0000-000000000002', 'active'
from public.profiles where auth_user_id = '10000000-0000-0000-0000-000000000002';
insert into public.library_items (profile_id, book_id, entitlement_id)
select e.profile_id, e.book_id, e.id from public.entitlements e;
insert into public.reading_progress (profile_id, publication_id, locator_json, progression, device_id, client_sequence)
select p.id,
  case when p.auth_user_id = '10000000-0000-0000-0000-000000000001' then '60000000-0000-0000-0000-000000000001'::uuid else '60000000-0000-0000-0000-000000000002'::uuid end,
  '{}'::jsonb, 0, 'test-device', 1
from public.profiles p;
insert into public.reader_sessions (profile_id, publication_id, publication_version, expires_at)
select rp.profile_id, rp.publication_id, 1, now() + interval '15 minutes' from public.reading_progress rp;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select results_eq('select count(*) from public.profiles', array[1::bigint]);
select results_eq('select count(*) from public.entitlements', array[1::bigint]);
select results_eq('select count(*) from public.library_items', array[1::bigint]);
select results_eq('select count(*) from public.reading_progress', array[1::bigint]);
select results_eq('select count(*) from public.orders', array[1::bigint]);
select results_eq('select count(*) from public.reader_sessions', array[1::bigint]);
select is(public.is_admin(), false, 'reader is not an admin');
select results_eq(
  $$ update public.profiles set display_name = 'intrusion' where auth_user_id = '10000000-0000-0000-0000-000000000002' returning display_name $$,
  array[]::text[]
);
select * from finish();
rollback;
