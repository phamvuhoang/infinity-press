begin;
select plan(30);

-- A distinct fixture keeps the search test independent of annotation test ordering.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('d2000000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'search-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
create temporary table t_reader as select id from public.profiles where auth_user_id = 'd2000000-0000-0000-0000-000000000001';
grant select on t_reader to public;
insert into public.authors (id, canonical_slug, display_name, status) values ('d2000000-0000-0000-0000-000000000010', 'search-author', 'Search Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values ('d2000000-0000-0000-0000-000000000020', 'search-book', 'vi', 'd2000000-0000-0000-0000-000000000010', 'published');
insert into public.editions (id, book_id, language_code) values ('d2000000-0000-0000-0000-000000000030', 'd2000000-0000-0000-0000-000000000020', 'vi');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status) values ('d2000000-0000-0000-0000-000000000040', 'd2000000-0000-0000-0000-000000000030', 'search.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status) values ('d2000000-0000-0000-0000-000000000050', 'd2000000-0000-0000-0000-000000000040', 1, 'search.json', 'published');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'd2000000-0000-0000-0000-000000000050' and (b.id = 'd2000000-0000-0000-0000-000000000020');
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status) select id, 'd2000000-0000-0000-0000-000000000020', 'admin_grant', id, 'fixture', 'active' from t_reader;

select has_table('public', 'ebook_search_chunks', 'private chunks exist');
select ok(not has_table_privilege('authenticated', 'public.ebook_search_chunks', 'SELECT'), 'browser role cannot select chunks');
select has_index('public', 'ebook_search_chunks', 'ebook_search_chunks_publication_id_ordinal_key', 'publication ordinal is unique');
select has_index('public', 'ebook_search_chunks', 'ebook_search_chunks_search_document_idx', 'token GIN index exists');
select has_index('public', 'ebook_search_chunks', 'ebook_search_chunks_normalized_text_trgm_idx', 'normalized trigram index exists');
select is(has_function_privilege('anon', 'public.search_reader_publication(uuid, uuid, text)', 'EXECUTE'), false, 'anon cannot execute search');
select is(has_function_privilege('authenticated', 'public.search_reader_publication(uuid, uuid, text)', 'EXECUTE'), true, 'authenticated can execute search');

select throws_ok(
  $$insert into public.ebook_search_chunks (publication_id, href, ordinal, plain_text, locator_json) values ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/missing-text.xhtml', 90, 'text', '{"href":"OEBPS/text/missing-text.xhtml","progression":0.1,"locations":{"position":90}}'::jsonb)$$,
  null, null, 'search chunk requires a text locator object rather than accepting NULL check semantics'
);
select throws_ok(
  $$insert into public.ebook_search_chunks (publication_id, href, ordinal, plain_text, locator_json) values ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/missing-highlight.xhtml', 91, 'text', '{"href":"OEBPS/text/missing-highlight.xhtml","progression":0.1,"locations":{"position":91},"text":{}}'::jsonb)$$,
  null, null, 'search chunk requires a text highlight anchor rather than accepting NULL check semantics'
);
select throws_ok(
  $$insert into public.ebook_search_chunks (publication_id, href, ordinal, plain_text, locator_json) values ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/null-highlight.xhtml', 92, 'text', '{"href":"OEBPS/text/null-highlight.xhtml","progression":0.1,"locations":{"position":92},"text":{"highlight":null}}'::jsonb)$$,
  null, null, 'search chunk rejects a null text highlight anchor'
);
select throws_ok(
  $$insert into public.ebook_search_chunks (publication_id, href, ordinal, plain_text, locator_json) values ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/number-highlight.xhtml', 93, 'text', '{"href":"OEBPS/text/number-highlight.xhtml","progression":0.1,"locations":{"position":93},"text":{"highlight":17}}'::jsonb)$$,
  null, null, 'search chunk rejects a non-string text highlight anchor'
);

insert into public.ebook_search_chunks (publication_id, href, chapter_title, ordinal, plain_text, locator_json)
select 'd2000000-0000-0000-0000-000000000050', 'OEBPS/text/' || lpad(i::text, 3, '0') || '.xhtml', 'Chapter ' || i, i,
  case when i = 1 then 'Đắc Nhân Tâm begins here.' when i = 2 then 'dac nhan tam without accents.' else 'needle shared text ' || i end,
  jsonb_build_object('href', 'OEBPS/text/' || lpad(i::text, 3, '0') || '.xhtml', 'progression', 0.1, 'totalProgression', null, 'locations', jsonb_build_object('position', i), 'text', jsonb_build_object('highlight', 'needle'))
from generate_series(1, 57) as i;
insert into public.ebook_search_chunks (publication_id, href, chapter_title, ordinal, plain_text, locator_json)
values (
  'd2000000-0000-0000-0000-000000000050', 'OEBPS/text/late-match.xhtml', 'Late match', 58,
  'ß ' || repeat('Mở đầu yên lặng. ', 50) || 'Mùa hè rực rỡ xanh mát nắng vàng và không gian yên tĩnh.',
  '{"href":"OEBPS/text/late-match.xhtml","progression":0.8,"totalProgression":null,"locations":{"position":58,"cssSelector":"#late","textOffset":1024},"text":{"highlight":"ß Mở đầu yên lặng."}}'::jsonb
);
insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class)
select 'd2000000-0000-0000-0000-000000000050', 'OEBPS/text/' || lpad(i::text, 3, '0') || '.xhtml',
  'application/xhtml+xml', 'search/' || lpad(i::text, 3, '0') || '.xhtml', 10, 'sha-search-' || i, 'paid'
from generate_series(1, 57) as i;
insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class)
values
  ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/late-match.xhtml', 'application/xhtml+xml', 'search/late-match.xhtml', 10, 'sha-search-late', 'paid'),
  ('d2000000-0000-0000-0000-000000000050', 'OEBPS/styles/indexed.css', 'text/css', 'search/indexed.css', 10, 'sha-search-css', 'paid');
update public.ebook_publications
set positions_json = (
  select jsonb_agg(jsonb_build_object(
    'href', candidate.href,
    'progression', 0,
    'totalProgression', null,
    'locations', jsonb_build_object('position', candidate.ordinal)
  ) order by candidate.ordinal)
  from (
    select 'OEBPS/text/' || lpad(i::text, 3, '0') || '.xhtml' as href, i as ordinal
    from generate_series(1, 57) as i
    union all select 'OEBPS/text/late-match.xhtml', 58
    union all select 'OEBPS/text/missing-resource.xhtml', 60
  ) candidate
)
where id = 'd2000000-0000-0000-0000-000000000050';
insert into public.ebook_search_chunks (publication_id, href, chapter_title, ordinal, plain_text, locator_json)
values
  ('d2000000-0000-0000-0000-000000000050', 'OEBPS/styles/indexed.css', 'Indexed CSS', 59, 'stylesonly secret', '{"href":"OEBPS/styles/indexed.css","progression":0,"totalProgression":null,"locations":{"position":59},"text":{"highlight":"stylesonly"}}'::jsonb),
  ('d2000000-0000-0000-0000-000000000050', 'OEBPS/text/missing-resource.xhtml', 'Missing resource', 60, 'missingchapter secret', '{"href":"OEBPS/text/missing-resource.xhtml","progression":0,"totalProgression":null,"locations":{"position":60},"text":{"highlight":"missingchapter"}}'::jsonb);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-000000000001', true);
create temporary table t_session as select * from public.create_reader_session('d2000000-0000-0000-0000-000000000050', 900);
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle'))::int, 50, 'search caps 57 matching chunks at 50');
select is((select locator_json->'locations'->>'position' from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle') limit 1), '3', 'ranking ties break by ordinal');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'Đắc Nhân Tâm'))::int, 2, 'accented Vietnamese token query finds both normalized forms');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'dac nhan tam'))::int, 2, 'unaccented Vietnamese token query finds accented text');
select ok((select excerpt like '%Mùa hè rực rỡ xanh%' from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'mua he xanh nang') where chapter_title = 'Late match'), 'normalized multi-token search centers its excerpt on late original accented text');
select is((select (locator_json #>> '{locations,textOffset}')::int from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'mua he xanh nang') where chapter_title = 'Late match'), 1876, 'search advances the selector-relative offset to the match and accounts for unaccent expansion');
select is((select locator_json #>> '{locations,cssSelector}' from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'mua he xanh nang') where chapter_title = 'Late match'), '#late', 'match anchor keeps its verified selector');
select ok((select locator_json #>> '{text,highlight}' like 'Mùa hè%' from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'mua he xanh nang') where chapter_title = 'Late match'), 'search anchor starts at the late match rather than chunk start');
select ok((select excerpt like '%không gian%' from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'khoong') where chapter_title = 'Late match'), 'trigram fallback centers its excerpt on the matched late token');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', '  '))::int, 0, 'empty query returns no chunks');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', '!!'))::int, 0, 'punctuation-only query returns no chunks');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'n'))::int, 0, 'one-character query is rejected by the SQL boundary');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', repeat('needle', 17)))::int, 0, 'overlong query is rejected by the SQL boundary');
select ok((select max(char_length(excerpt)) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle')) <= 240, 'search excerpts are bounded');
select ok((select max(char_length(locator_json #>> '{text,highlight}')) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle')) <= 160, 'returned locator quote anchors are bounded');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'stylesonly'))::int, 0, 'search excludes an indexed CSS resource outside the reading order');
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'missingchapter'))::int, 0, 'search excludes an indexed href without a publication resource');
reset role;

update public.entitlements set status = 'revoked', revoked_at = now() where profile_id = (select id from t_reader);
set local role authenticated; select set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle'))::int, 0, 'revoked reader cannot search');
reset role;

update public.entitlements set status = 'active', revoked_at = null where profile_id = (select id from t_reader);
update public.ebook_publications set status = 'superseded' where id = 'd2000000-0000-0000-0000-000000000050';
set local role authenticated; select set_config('request.jwt.claim.sub', 'd2000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.search_reader_publication((select id from t_session), 'd2000000-0000-0000-0000-000000000050', 'needle'))::int, 0, 'superseded publication cannot be searched');
reset role;

select * from finish();
rollback;
