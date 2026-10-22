begin;
select plan(7);

-- Passage anchors: reader_chunk_locator and reader_chunk_for_locator answer only an entitled reader;
-- sample_chunk_locator answers anyone, but only for an href the sample allowlist lets through.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'fa100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'cl-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'fa100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'cl-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.authors (id, canonical_slug, display_name, status) values ('fa200000-0000-0000-0000-000000000001', 'cl-author', 'CL Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('fa300000-0000-0000-0000-000000000001', 'cl-book', 'en', 'fa200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values ('fa400000-0000-0000-0000-000000000001', 'fa300000-0000-0000-0000-000000000001', 'en');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('fa500000-0000-0000-0000-000000000001', 'fa400000-0000-0000-0000-000000000001', 'cl/en.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('fa600000-0000-0000-0000-000000000001', 'fa500000-0000-0000-0000-000000000001', 1, 'cl/en.json', 'published');
update public.editions set active_publication_id = 'fa600000-0000-0000-0000-000000000001', status = 'published'
where id = 'fa400000-0000-0000-0000-000000000001';
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select id, 'fa300000-0000-0000-0000-000000000001', 'admin_grant', id, 'fixture', 'active'
from public.profiles where auth_user_id = 'fa100000-0000-0000-0000-000000000001';
insert into public.book_samples (publication_id, allowed_hrefs) values ('fa600000-0000-0000-0000-000000000001', '["c1"]');
insert into public.ebook_search_chunks (publication_id, href, ordinal, plain_text, locator_json) values
  ('fa600000-0000-0000-0000-000000000001', 'c1', 0, 'one', '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"one"}}'),
  ('fa600000-0000-0000-0000-000000000001', 'c1', 1, 'two', '{"href":"c1","progression":0.5,"totalProgression":0.3,"locations":{"position":2},"text":{"highlight":"two"}}'),
  ('fa600000-0000-0000-0000-000000000001', 'c2', 2, 'three', '{"href":"c2","progression":0,"totalProgression":0.6,"locations":{"position":3},"text":{"highlight":"three"}}');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-000000000001', true);
select is(public.reader_chunk_locator('fa600000-0000-0000-0000-000000000001', 1) ->> 'progression', '0.5', 'an entitled reader gets the chunk''s locator');
select is(public.reader_chunk_locator('fa600000-0000-0000-0000-000000000001', 99), null, 'an out-of-range ordinal is null');
select is(public.reader_chunk_for_locator('fa600000-0000-0000-0000-000000000001', 'c1', 0.7), 1, 'a locator falls in the last chunk of its href starting at or before it');
select is(public.reader_chunk_for_locator('fa600000-0000-0000-0000-000000000001', 'c1', 0.1), 0, 'a locator before the second chunk falls in the first');
select is(public.reader_chunk_for_locator('fa600000-0000-0000-0000-000000000001', 'zz', 0), null, 'an href the publication does not have is null');

select set_config('request.jwt.claim.sub', 'fa100000-0000-0000-0000-000000000002', true);
select is(
  array[public.reader_chunk_locator('fa600000-0000-0000-0000-000000000001', 1)::text,
        public.reader_chunk_for_locator('fa600000-0000-0000-0000-000000000001', 'c1', 0.7)::text],
  array[null, null]::text[],
  'a stranger gets null from both entitled functions');
reset role;

-- Refused while c2 is not on the allowlist, served once it is (as an anonymous visitor both times).
create temporary table t_sample (refused text);
grant all on t_sample to public;
set local role anon;
insert into t_sample select public.sample_chunk_locator('fa600000-0000-0000-0000-000000000001', 2) ->> 'href';
reset role;
update public.book_samples set allowed_hrefs = '["c1","c2"]' where publication_id = 'fa600000-0000-0000-0000-000000000001';
set local role anon;
select is(
  array[(select refused from t_sample), public.sample_chunk_locator('fa600000-0000-0000-0000-000000000001', 2) ->> 'href'],
  array[null, 'c2'],
  'sample_chunk_locator returns c2 only when the allowlist lets it through');
reset role;

select * from finish();
rollback;
