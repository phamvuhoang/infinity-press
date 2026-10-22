begin;
select plan(3);

-- admin_set_sample_full: admin only; true writes exactly ["*"]; false restores the worker's list,
-- which is the publication's access_class = 'sample' resources.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'f9100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sf-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'f9100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'sf-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role) select id, 'admin' from public.profiles where auth_user_id = 'f9100000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values ('f9200000-0000-0000-0000-000000000001', 'sf-author', 'SF Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f9300000-0000-0000-0000-000000000001', 'sf-book', 'en', 'f9200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code, status) values ('f9400000-0000-0000-0000-000000000001', 'f9300000-0000-0000-0000-000000000001', 'en', 'published');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('f9500000-0000-0000-0000-000000000001', 'f9400000-0000-0000-0000-000000000001', 'sf/en.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language) values
  ('f9600000-0000-0000-0000-000000000001', 'f9500000-0000-0000-0000-000000000001', 1, 'sf/en.json', 'published', 'en');
insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class) values
  ('f9600000-0000-0000-0000-000000000001', 'OEBPS/c1.xhtml', 'application/xhtml+xml', 'sf/c1.xhtml', 10, 'sha-sf-1', 'sample'),
  ('f9600000-0000-0000-0000-000000000001', 'OEBPS/c9.xhtml', 'application/xhtml+xml', 'sf/c9.xhtml', 10, 'sha-sf-9', 'paid');
insert into public.book_samples (publication_id, allowed_hrefs) values ('f9600000-0000-0000-0000-000000000001', '["OEBPS/c1.xhtml"]');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f9100000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.admin_set_sample_full('f9600000-0000-0000-0000-000000000001', true)$$, '42501', null, 'a non-admin cannot open the whole book');

select set_config('request.jwt.claim.sub', 'f9100000-0000-0000-0000-000000000001', true);
select public.admin_set_sample_full('f9600000-0000-0000-0000-000000000001', true);
reset role;
select is((select allowed_hrefs from public.book_samples where publication_id = 'f9600000-0000-0000-0000-000000000001'), '["*"]'::jsonb, 'admin true writes exactly ["*"]');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f9100000-0000-0000-0000-000000000001', true);
select public.admin_set_sample_full('f9600000-0000-0000-0000-000000000001', false);
reset role;
select is((select allowed_hrefs from public.book_samples where publication_id = 'f9600000-0000-0000-0000-000000000001'), '["OEBPS/c1.xhtml"]'::jsonb, 'admin false restores the sample-class list');

select * from finish();
rollback;
