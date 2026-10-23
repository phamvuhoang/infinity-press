begin;
select plan(7);

-- Automatic passage alignment: replace_passage_alignments writes both directions, and
-- reader_aligned_passage answers only a reader entitled to both editions.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'fb100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'pa-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'fb100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'pa-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'fb100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'pa-half@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.authors (id, canonical_slug, display_name, status) values ('fb200000-0000-0000-0000-000000000001', 'pa-author', 'PA Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('fb300000-0000-0000-0000-000000000001', 'pa-book', 'en', 'fb200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('fb400000-0000-0000-0000-000000000001', 'fb300000-0000-0000-0000-000000000001', 'en'),
  ('fb400000-0000-0000-0000-000000000002', 'fb300000-0000-0000-0000-000000000001', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('fb500000-0000-0000-0000-000000000001', 'fb400000-0000-0000-0000-000000000001', 'pa/en.epub', 1, 'published'),
  ('fb500000-0000-0000-0000-000000000002', 'fb400000-0000-0000-0000-000000000002', 'pa/vi.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('fb600000-0000-0000-0000-000000000001', 'fb500000-0000-0000-0000-000000000001', 1, 'pa/en.json', 'published'),
  ('fb600000-0000-0000-0000-000000000002', 'fb500000-0000-0000-0000-000000000002', 1, 'pa/vi.json', 'published');
update public.editions set active_publication_id = 'fb600000-0000-0000-0000-000000000001', status = 'published'
where id = 'fb400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'fb600000-0000-0000-0000-000000000002', status = 'published'
where id = 'fb400000-0000-0000-0000-000000000002';

-- The reader owns both editions; the half-owner owns only the Vietnamese one.
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
select pr.id, 'fb300000-0000-0000-0000-000000000001', e.id, 'admin_grant', pr.id, 'fixture', 'active'
from public.profiles pr
cross join (values ('fb400000-0000-0000-0000-000000000001'::uuid), ('fb400000-0000-0000-0000-000000000002'::uuid)) as e(id)
where pr.auth_user_id = 'fb100000-0000-0000-0000-000000000001';
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
select pr.id, 'fb300000-0000-0000-0000-000000000001', 'fb400000-0000-0000-0000-000000000002', 'admin_grant', pr.id, 'fixture', 'active'
from public.profiles pr where pr.auth_user_id = 'fb100000-0000-0000-0000-000000000003';

insert into public.ebook_search_chunks (id, publication_id, href, ordinal, plain_text, locator_json) values
  ('fb700000-0000-0000-0000-000000000001', 'fb600000-0000-0000-0000-000000000001', 'c1', 0, 'one', '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"one"}}'),
  ('fb700000-0000-0000-0000-000000000002', 'fb600000-0000-0000-0000-000000000001', 'c1', 1, 'two', '{"href":"c1","progression":0.5,"totalProgression":0.2,"locations":{"position":2},"text":{"highlight":"two"}}'),
  ('fb700000-0000-0000-0000-000000000003', 'fb600000-0000-0000-0000-000000000001', 'c2', 2, 'three', '{"href":"c2","progression":0,"totalProgression":0.5,"locations":{"position":3},"text":{"highlight":"three"}}'),
  ('fb700000-0000-0000-0000-000000000004', 'fb600000-0000-0000-0000-000000000001', 'c2', 3, 'four', '{"href":"c2","progression":0.5,"totalProgression":0.7,"locations":{"position":4},"text":{"highlight":"four"}}'),
  ('fb800000-0000-0000-0000-000000000001', 'fb600000-0000-0000-0000-000000000002', 'v1', 0, 'một', '{"href":"v1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"một"}}'),
  ('fb800000-0000-0000-0000-000000000002', 'fb600000-0000-0000-0000-000000000002', 'v1', 1, 'hai', '{"href":"v1","progression":0.5,"totalProgression":0.2,"locations":{"position":2},"text":{"highlight":"hai"}}'),
  ('fb800000-0000-0000-0000-000000000003', 'fb600000-0000-0000-0000-000000000002', 'v2', 2, 'ba', '{"href":"v2","progression":0,"totalProgression":0.5,"locations":{"position":3},"text":{"highlight":"ba"}}'),
  ('fb800000-0000-0000-0000-000000000004', 'fb600000-0000-0000-0000-000000000002', 'v2', 3, 'bốn', '{"href":"v2","progression":0.5,"totalProgression":0.7,"locations":{"position":4},"text":{"highlight":"bốn"}}');

-- Only the first resource pairs: half of each publication's chunks.
set local role service_role;
select public.replace_passage_alignments(
  'fb300000-0000-0000-0000-000000000001', 'fb600000-0000-0000-0000-000000000001', 'fb600000-0000-0000-0000-000000000002',
  '[{"sourceId":"fb700000-0000-0000-0000-000000000001","targetId":"fb800000-0000-0000-0000-000000000001","confidence":1},
    {"sourceId":"fb700000-0000-0000-0000-000000000002","targetId":"fb800000-0000-0000-0000-000000000002","confidence":1}]'::jsonb);
reset role;

select is(
  (select array_agg(source_chunk_id::text || '>' || target_chunk_id::text order by source_chunk_id) from public.passage_alignments),
  array[
    'fb700000-0000-0000-0000-000000000001>fb800000-0000-0000-0000-000000000001',
    'fb700000-0000-0000-0000-000000000002>fb800000-0000-0000-0000-000000000002',
    'fb800000-0000-0000-0000-000000000001>fb700000-0000-0000-0000-000000000001',
    'fb800000-0000-0000-0000-000000000002>fb700000-0000-0000-0000-000000000002'],
  'replace_passage_alignments writes both directions');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'fb100000-0000-0000-0000-000000000001', true);
select is(
  public.reader_aligned_passage('fb600000-0000-0000-0000-000000000002', 1) - 'confidence',
  jsonb_build_object(
    'targetPublicationId', 'fb600000-0000-0000-0000-000000000001', 'targetEditionId', 'fb400000-0000-0000-0000-000000000001',
    'targetLanguageCode', 'en', 'targetOrdinal', 1, 'text', 'two'),
  'a reader entitled to both editions gets the aligned English text');
select is(public.reader_aligned_passage('fb600000-0000-0000-0000-000000000002', 2), null, 'an unpaired ordinal is null');

create temporary table t_refused (who text, result jsonb);
grant all on t_refused to public;
select set_config('request.jwt.claim.sub', 'fb100000-0000-0000-0000-000000000002', true);
insert into t_refused select 'stranger', public.reader_aligned_passage('fb600000-0000-0000-0000-000000000002', 1);
select set_config('request.jwt.claim.sub', 'fb100000-0000-0000-0000-000000000003', true);
insert into t_refused select 'vi only', public.reader_aligned_passage('fb600000-0000-0000-0000-000000000002', 1);
select is(
  (select array_agg(result::text order by who) from t_refused),
  array[null, null]::text[],
  'a stranger and a reader without the target edition both get null');
reset role;

set local role anon;
select is(public.alignment_coverage('fb600000-0000-0000-0000-000000000001'), 0.5::numeric, 'coverage is the paired share of chunks');
reset role;

-- A new Vietnamese version goes live; the old pairs stay but no longer count.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('fb500000-0000-0000-0000-000000000003', 'fb400000-0000-0000-0000-000000000002', 'pa/vi-2.epub', 2, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('fb600000-0000-0000-0000-000000000003', 'fb500000-0000-0000-0000-000000000003', 2, 'pa/vi-2.json', 'published');
update public.editions set active_publication_id = 'fb600000-0000-0000-0000-000000000003'
where id = 'fb400000-0000-0000-0000-000000000002';
select is(public.alignment_coverage('fb600000-0000-0000-0000-000000000001'), 0::numeric, 'pairs with a target that is no longer live do not count');

delete from public.ebook_search_chunks where id = 'fb700000-0000-0000-0000-000000000001';
select is(
  (select count(*) from public.passage_alignments)::int,
  2,
  'deleting a chunk removes its alignments in both directions');

select * from finish();
rollback;
