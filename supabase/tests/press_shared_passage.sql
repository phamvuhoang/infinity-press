begin;
select plan(10);

-- S20 passage cards: create_shared_quote takes a question, a text kind and a chunk ordinal; a share
-- with an ordinal writes passage_shared; catalog_shared_quote says whether the chunk still exists,
-- whether the sample lets a visitor in there, and which aligned editions can open it.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'f9100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sp-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.authors (id, canonical_slug, display_name, status) values ('f9200000-0000-0000-0000-000000000001', 'sp-author', 'SP Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('f9300000-0000-0000-0000-000000000001', 'sp-book', 'vi', 'f9200000-0000-0000-0000-000000000001', 'published');
insert into public.editions (id, book_id, language_code) values
  ('f9400000-0000-0000-0000-000000000001', 'f9300000-0000-0000-0000-000000000001', 'vi'),
  ('f9400000-0000-0000-0000-000000000002', 'f9300000-0000-0000-0000-000000000001', 'en'),
  ('f9400000-0000-0000-0000-000000000003', 'f9300000-0000-0000-0000-000000000001', 'ja');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values
  ('f9500000-0000-0000-0000-000000000001', 'f9400000-0000-0000-0000-000000000001', 'sp/vi.epub', 1, 'published'),
  ('f9500000-0000-0000-0000-000000000002', 'f9400000-0000-0000-0000-000000000002', 'sp/en.epub', 1, 'published'),
  ('f9500000-0000-0000-0000-000000000003', 'f9400000-0000-0000-0000-000000000003', 'sp/ja.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values
  ('f9600000-0000-0000-0000-000000000001', 'f9500000-0000-0000-0000-000000000001', 1, 'sp/vi.json', 'published'),
  ('f9600000-0000-0000-0000-000000000002', 'f9500000-0000-0000-0000-000000000002', 1, 'sp/en.json', 'published'),
  ('f9600000-0000-0000-0000-000000000003', 'f9500000-0000-0000-0000-000000000003', 1, 'sp/ja.json', 'published');
update public.editions set active_publication_id = 'f9600000-0000-0000-0000-000000000001', status = 'published' where id = 'f9400000-0000-0000-0000-000000000001';
update public.editions set active_publication_id = 'f9600000-0000-0000-0000-000000000002', status = 'published' where id = 'f9400000-0000-0000-0000-000000000002';
-- ja is live but blocked: it must never appear to a visitor.
update public.editions set active_publication_id = 'f9600000-0000-0000-0000-000000000003', status = 'published', editorial_state = 'blocked', reviewed_at = now(), reviewed_by = (select id from public.profiles where auth_user_id = 'f9100000-0000-0000-0000-000000000001') where id = 'f9400000-0000-0000-0000-000000000003';
insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status)
select id, 'f9300000-0000-0000-0000-000000000001', 'f9400000-0000-0000-0000-000000000001', 'admin_grant', id, 'fixture', 'active'
from public.profiles where auth_user_id = 'f9100000-0000-0000-0000-000000000001';
-- vi: c1 is the sample chapter, c2 is paid. en: c1 is not on its sample at all.
insert into public.book_samples (publication_id, allowed_hrefs) values
  ('f9600000-0000-0000-0000-000000000001', '["c1"]'),
  ('f9600000-0000-0000-0000-000000000002', '[]');
insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class) values
  ('f9600000-0000-0000-0000-000000000001', 'c1', 'application/xhtml+xml', 'sp/vi/c1.xhtml', 10, 'sha-sp-1', 'sample'),
  ('f9600000-0000-0000-0000-000000000001', 'c2', 'application/xhtml+xml', 'sp/vi/c2.xhtml', 10, 'sha-sp-2', 'paid'),
  ('f9600000-0000-0000-0000-000000000002', 'c1', 'application/xhtml+xml', 'sp/en/c1.xhtml', 10, 'sha-sp-3', 'paid');
insert into public.ebook_search_chunks (id, publication_id, href, ordinal, plain_text, locator_json) values
  ('f9700000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'c1', 1, 'một', '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"một"}}'),
  ('f9700000-0000-0000-0000-000000000002', 'f9600000-0000-0000-0000-000000000001', 'c2', 2, 'hai', '{"href":"c2","progression":0,"totalProgression":0.5,"locations":{"position":2},"text":{"highlight":"hai"}}'),
  ('f9700000-0000-0000-0000-000000000003', 'f9600000-0000-0000-0000-000000000002', 'c1', 4, 'one', '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"one"}}'),
  ('f9700000-0000-0000-0000-000000000004', 'f9600000-0000-0000-0000-000000000003', 'c1', 5, 'ichi', '{"href":"c1","progression":0,"totalProgression":0,"locations":{"position":1},"text":{"highlight":"ichi"}}');
insert into public.passage_alignments (book_id, source_publication_id, target_publication_id, source_chunk_id, target_chunk_id, confidence) values
  ('f9300000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000002', 'f9700000-0000-0000-0000-000000000001', 'f9700000-0000-0000-0000-000000000003', 0.9),
  ('f9300000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000003', 'f9700000-0000-0000-0000-000000000001', 'f9700000-0000-0000-0000-000000000004', 0.8);

create temporary table t_cards (name text, card jsonb);
grant all on t_cards to public;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'f9100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.create_shared_quote('f9600000-0000-0000-0000-000000000001', 'Một câu.', 'vi', repeat('?', 281))$$,
  'EB039', null, 'a question of 281 characters is refused');
select throws_ok($$select public.create_shared_quote('f9600000-0000-0000-0000-000000000001', 'Một câu.', 'vi', null, 'poem')$$,
  'EB039', null, 'an unknown text kind is refused');
insert into t_cards values
  ('passage', public.create_shared_quote('f9600000-0000-0000-0000-000000000001', 'Một câu.', 'vi', 'Vì sao?', 'paraphrase', 1)),
  ('plain', public.create_shared_quote('f9600000-0000-0000-0000-000000000001', 'Câu khác.', 'vi', null, 'verbatim', null)),
  ('legacy', public.create_shared_quote('f9600000-0000-0000-0000-000000000001', 'Câu cũ.', 'vi'));
reset role;

select results_eq(
  $$select e.profile_id is not null, e.book_id::text, e.publication_id::text, e.locale from public.analytics_events e
    where e.event_name = 'passage_shared' and e.dedupe_key = 'shared_quote:' || (select card ->> 'id' from t_cards where name = 'passage') || ':passage'$$,
  $$values (true, 'f9300000-0000-0000-0000-000000000001', 'f9600000-0000-0000-0000-000000000001', null::text)$$,
  'a share with an ordinal writes one passage_shared event with identifier columns only');
select is(
  (select count(*)::int from public.analytics_events e where e.event_name = 'passage_shared'
   and e.shared_quote_id = (select (card ->> 'id')::uuid from t_cards where name = 'plain')),
  0, 'a share without an ordinal writes no passage_shared');
select is(
  (select array[card ->> 'textKind', card ->> 'question', coalesce(card ->> 'chunkOrdinal', 'null')] from t_cards where name = 'legacy'),
  array['verbatim', null, 'null'], 'the three-argument call still works with the defaults');

set local role anon;
select is(
  (select jsonb_build_object('q', c ->> 'question', 'k', c ->> 'textKind', 'o', c -> 'chunkOrdinal', 'e', c ->> 'editionId',
     'x', c -> 'chunkExists', 's', c -> 'sampleAllowsChunk')
   from (select public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) as c) r),
  jsonb_build_object('q', 'Vì sao?', 'k', 'paraphrase', 'o', 1, 'e', 'f9400000-0000-0000-0000-000000000001', 'x', true, 's', true),
  'the card carries the question, the kind, the ordinal, and an open sample chunk');
select is(
  (public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) -> 'languages'),
  '[{"editionId":"f9400000-0000-0000-0000-000000000001","languageCode":"vi","ordinal":1,"sampleAllows":true},
    {"editionId":"f9400000-0000-0000-0000-000000000002","languageCode":"en","ordinal":4,"sampleAllows":false}]'::jsonb,
  'languages lists the shared edition, then the aligned live edition with its ordinal and its own sample rule');
reset role;

-- The blocked edition is absent; once unblocked, the same alignment shows it (the positive control).
create temporary table t_blocked (present boolean);
grant all on t_blocked to public;
set local role anon;
insert into t_blocked select public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) -> 'languages' @> '[{"languageCode":"ja"}]';
reset role;
update public.editions set editorial_state = 'approved' where id = 'f9400000-0000-0000-0000-000000000003';
set local role anon;
select is(
  array[(select present from t_blocked), public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) -> 'languages' @> '[{"languageCode":"ja"}]'],
  array[false, true], 'a blocked aligned edition is absent from languages');
reset role;

-- The sample chapter is taken off the allowlist: the chunk exists but the sample refuses it.
update public.book_samples set allowed_hrefs = '[]' where publication_id = 'f9600000-0000-0000-0000-000000000001';
set local role anon;
select is(
  (select array[c ->> 'chunkExists', c ->> 'sampleAllowsChunk']
   from (select public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) as c) r),
  array['true', 'false'], 'a chunk the sample no longer allows is reported as refused');
reset role;

delete from public.ebook_search_chunks where id = 'f9700000-0000-0000-0000-000000000001';
set local role anon;
select is(
  (select array[c ->> 'chunkExists', c ->> 'sampleAllowsChunk', c ->> 'languages']
   from (select public.catalog_shared_quote((select card ->> 'code' from t_cards where name = 'passage')) as c) r),
  array['false', 'false', '[]'], 'a deleted chunk is reported as gone, with no language to open');
reset role;

select * from finish();
rollback;
