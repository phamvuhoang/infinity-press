begin;
select plan(49);

-- These fixtures intentionally exercise the real reader-session authorization path.  Changing
-- the RPC to trust a body/profile value, to omit any one of the three publication-state checks,
-- or to allow a cross-owner row would make one of the assertions below fail.
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'annotation-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'annotation-foreign@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

create temporary table t_readers as
select
  (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001') as owner_id,
  (select id from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000002') as foreign_id;
grant select on t_readers to public;

insert into public.authors (id, canonical_slug, display_name, status)
values ('d1000000-0000-0000-0000-000000000010', 'annotation-author', 'Annotation Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('d1000000-0000-0000-0000-000000000020', 'annotation-live', 'en', 'd1000000-0000-0000-0000-000000000010', 'published'),
  ('d1000000-0000-0000-0000-000000000021', 'annotation-draft', 'en', 'd1000000-0000-0000-0000-000000000010', 'draft');
insert into public.editions (id, book_id, language_code)
values
  ('d1000000-0000-0000-0000-000000000030', 'd1000000-0000-0000-0000-000000000020', 'en'),
  ('d1000000-0000-0000-0000-000000000031', 'd1000000-0000-0000-0000-000000000021', 'en');
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values
  ('d1000000-0000-0000-0000-000000000040', 'd1000000-0000-0000-0000-000000000030', 'annotation/live-1.epub', 1, 'published'),
  ('d1000000-0000-0000-0000-000000000041', 'd1000000-0000-0000-0000-000000000030', 'annotation/live-2.epub', 2, 'superseded'),
  ('d1000000-0000-0000-0000-000000000042', 'd1000000-0000-0000-0000-000000000031', 'annotation/draft.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values
  ('d1000000-0000-0000-0000-000000000050', 'd1000000-0000-0000-0000-000000000040', 1, 'annotation/live-1.json', 'published'),
  ('d1000000-0000-0000-0000-000000000051', 'd1000000-0000-0000-0000-000000000041', 2, 'annotation/live-2.json', 'superseded'),
  ('d1000000-0000-0000-0000-000000000052', 'd1000000-0000-0000-0000-000000000042', 1, 'annotation/draft.json', 'published');
update public.ebook_publications
set positions_json = '[{"href":"OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":1}},{"href":"OEBPS/text/chương.xhtml","progression":0.4,"totalProgression":null,"locations":{"position":2}}]'::jsonb
where id = 'd1000000-0000-0000-0000-000000000050';
insert into public.ebook_resources (publication_id, href, media_type, storage_key, byte_size, sha256, access_class) values
  ('d1000000-0000-0000-0000-000000000050', 'OEBPS/text/ch1.xhtml', 'application/xhtml+xml', 'annotation/ch1.xhtml', 10, 'sha-ch1', 'paid'),
  ('d1000000-0000-0000-0000-000000000050', 'OEBPS/text/chương.xhtml', 'application/xhtml+xml', 'annotation/chapter-vi.xhtml', 10, 'sha-vi', 'paid');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'd1000000-0000-0000-0000-000000000050' and (b.id = 'd1000000-0000-0000-0000-000000000020');
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'd1000000-0000-0000-0000-000000000052' and (b.id = 'd1000000-0000-0000-0000-000000000021');
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select owner_id, 'd1000000-0000-0000-0000-000000000020', 'admin_grant', owner_id, 'fixture', 'active' from t_readers;
insert into public.entitlements (profile_id, book_id, source_type, actor_profile_id, reason, status)
select foreign_id, 'd1000000-0000-0000-0000-000000000020', 'admin_grant', foreign_id, 'fixture', 'active' from t_readers;

select has_table('public', 'reader_annotations', 'annotation storage exists');
select has_column('public', 'ebook_publications', 'positions_json', 'rollout positions are nullable');
select has_index('public', 'reader_annotations', 'reader_annotations_profile_publication_updated_at_idx', 'annotation recency index exists');
select has_index('public', 'reader_annotations', 'reader_annotations_profile_publication_kind_idx', 'annotation kind index exists');
select is(has_function_privilege('anon', 'public.reader_annotation_request(uuid, uuid, text, uuid, jsonb)', 'EXECUTE'), false, 'anon cannot call annotation RPC');
select is(has_function_privilege('authenticated', 'public.reader_annotation_request(uuid, uuid, text, uuid, jsonb)', 'EXECUTE'), true, 'authenticated can call annotation RPC');
select is(has_function_privilege('anon', 'public.reader_publication_href_membership(uuid, uuid, text)', 'EXECUTE'), false, 'anon cannot call reader href membership');
select is(has_function_privilege('authenticated', 'public.reader_publication_href_membership(uuid, uuid, text)', 'EXECUTE'), true, 'authenticated can call reader href membership');
select is(
  public.reader_publication_path_from_href('d1000000-0000-0000-0000-000000000050', '/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch%C6%B0%C6%A1ng.xhtml'),
  'OEBPS/text/chương.xhtml',
  'protected href decoding preserves UTF-8 publication paths'
);
select is(
  public.reader_publication_path_from_href('d1000000-0000-0000-0000-000000000050', '/api/reader/publications/d1000000-0000-0000-0000-000000000051/resources/OEBPS/text/ch1.xhtml'),
  null,
  'protected href decoding rejects another publication prefix'
);
select is(
  public.reader_publication_path_from_href('d1000000-0000-0000-0000-000000000050', '/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/%2e%2e/secret.xhtml'),
  null,
  'protected href decoding rejects encoded traversal'
);
select is(
  public.reader_publication_path_from_href('d1000000-0000-0000-0000-000000000050', '/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/%252e%252e/secret.xhtml'),
  null,
  'protected href decoding rejects double-encoded traversal'
);

-- Constraint tests run as the migration owner so they isolate the constraints rather than RLS.
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'highlight', '{}'::jsonb, null, 'yellow')$$,
  null, null, 'highlight requires selected text'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, label) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'bookmark', '{}'::jsonb, '   ')$$,
  null, null, 'bookmark label remains nonempty after trimming'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'highlight', '{"href":"x","progression":"bad","locations":{}}'::jsonb, 'quote', 'yellow')$$,
  null, null, 'database rejects malformed locator json'
);
select is(public.reader_locator_is_valid('{}'::jsonb), false, 'locator helper rejects omitted required fields rather than returning NULL');
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'highlight', '{"href":"x","progression":0.2,"locations":{}}'::jsonb, 'quote', 'yellow')$$,
  null, null, 'highlight requires a quote anchor rather than accepting a NULL check result'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'highlight', '{"href":"x","progression":0.2,"locations":{},"text":{"highlight":"quote"}}'::jsonb, 'quote', null)$$,
  null, null, 'highlight requires a non-null color'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, selected_text, color) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'highlight', jsonb_build_object('href','x','progression',0.2,'locations','{}'::jsonb,'text',jsonb_build_object('highlight','quote','before',repeat('x',65))), 'quote', 'yellow')$$,
  null, null, 'annotation quote context is capped at 64 code points'
);
select throws_ok(
  $$insert into public.reader_annotations (profile_id, publication_id, kind, locator_json, label) values ((select owner_id from t_readers), 'd1000000-0000-0000-0000-000000000050', 'bookmark', jsonb_build_object('href','x','progression',0.2,'locations','{}'::jsonb,'text',jsonb_build_object('after',17)), 'Bookmark')$$,
  null, null, 'bookmark text context must have the documented string shape'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
create temporary table t_session as select * from public.create_reader_session('d1000000-0000-0000-0000-000000000050', 900);
select is(
  (select is_member from public.reader_publication_href_membership((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'OEBPS/text/ch1.xhtml')),
  true,
  'membership accepts an indexed position backed by the publication resource'
);
select is(
  (select is_member from public.reader_publication_href_membership((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'OEBPS/text/not-spine.xhtml')),
  false,
  'membership rejects a path outside the indexed reading order'
);
select throws_ok(
  $$select * from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'create', null, '{"kind":"bookmark","locator":{"href":"/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/not-spine.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":2}},"label":"Outside"}'::jsonb)$$,
  'EB010', null, 'annotation create rejects a protected locator outside the indexed spine'
);
reset role;
update public.ebook_publications set positions_json = null where id = 'd1000000-0000-0000-0000-000000000050';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select * from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'create', null, '{"kind":"bookmark","locator":{"href":"/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":2}},"label":"Needs index"}'::jsonb)$$,
  'EB014', null, 'annotation create reports an unavailable positions index instead of guessing membership'
);
reset role;
update public.ebook_publications
set positions_json = '[{"href":"OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":1}},{"href":"OEBPS/text/chương.xhtml","progression":0.4,"totalProgression":null,"locations":{"position":2}}]'::jsonb
where id = 'd1000000-0000-0000-0000-000000000050';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
create temporary table t_annotation as
select * from public.reader_annotation_request(
  (select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'create', null,
  '{"kind":"highlight","locator":{"href":"/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":2},"text":{"highlight":"A quote"}},"selectedText":"A quote","color":"yellow","noteText":null}'::jsonb
);
select is((select selected_text from t_annotation), 'A quote', 'owner creates a highlight through the authorized RPC');
select is((select locator_json ->> 'href' from t_annotation), '/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch1.xhtml', 'annotation storage retains the protected locator href');
select is((select profile_id from t_annotation), (select owner_id from t_readers), 'create derives owner from the session rather than payload');
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 1, 'owner lists own annotation');
select is((select color from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'update', (select id from t_annotation), '{"kind":"highlight","color":"green","noteText":"private"}'::jsonb)), 'green', 'owner updates only highlight fields');
select throws_ok(
  $$select * from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'create', null, '{"kind":"highlight","locator":{"href":"/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":2},"text":{"highlight":"A quote"}},"selectedText":"A quote","color":null,"noteText":null}'::jsonb)$$,
  null, null, 'authenticated RPC rejects a null highlight color'
);
create temporary table t_bookmark as
select * from public.reader_annotation_request(
  (select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'create', null,
  '{"kind":"bookmark","locator":{"href":"/api/reader/publications/d1000000-0000-0000-0000-000000000050/resources/OEBPS/text/ch1.xhtml","progression":0.2,"totalProgression":null,"locations":{"position":2}},"label":"Chapter one"}'::jsonb
);
select is((select label from t_bookmark), 'Chapter one', 'owner creates a bookmark');
select is((select label from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'update', (select id from t_bookmark), '{"kind":"bookmark","label":"Renamed chapter"}'::jsonb)), 'Renamed chapter', 'owner renames a bookmark');
select is((select label from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'delete', (select id from t_bookmark))), 'Renamed chapter', 'bookmark delete returns the deleted row');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000002', true);
create temporary table t_foreign_session as select * from public.create_reader_session('d1000000-0000-0000-0000-000000000050', 900);
select is((select count(*) from public.reader_annotation_request((select id from t_foreign_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'foreign reader cannot list owner annotations');
select is((select count(*) from public.reader_annotation_request((select id from t_foreign_session), 'd1000000-0000-0000-0000-000000000050', 'update', (select id from t_annotation), '{"kind":"highlight","color":"rose"}'::jsonb))::int, 0, 'foreign reader cannot update owner annotation');
select is((select count(*) from public.reader_annotation_request((select id from t_foreign_session), 'd1000000-0000-0000-0000-000000000050', 'delete', (select id from t_annotation)))::int, 0, 'foreign reader cannot delete owner annotation');
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'forged another reader session cannot be used');
reset role;

select throws_ok(
  $$update public.reader_annotations set publication_id = 'd1000000-0000-0000-0000-000000000051' where id = (select id from t_annotation)$$,
  null, null, 'annotation publication is immutable'
);
select throws_ok(
  $$update public.reader_annotations set profile_id = (select foreign_id from t_readers) where id = (select id from t_annotation)$$,
  null, null, 'annotation owner is immutable'
);
select throws_ok(
  $$update public.reader_annotations set kind = 'bookmark' where id = (select id from t_annotation)$$,
  null, null, 'annotation kind is immutable'
);
select throws_ok(
  $$update public.reader_annotations set locator_json = '{"href":"OEBPS/text/other.xhtml","progression":0.2,"totalProgression":null,"locations":{}}'::jsonb where id = (select id from t_annotation)$$,
  null, null, 'annotation anchor is immutable'
);

update public.entitlements set status = 'revoked', revoked_at = now() where profile_id = (select owner_id from t_readers);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'revoked access hides annotations');
reset role;
update public.entitlements set status = 'active', revoked_at = null where profile_id = (select owner_id from t_readers);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 1, 'restored access exposes annotations on the same version');
reset role;

update public.reader_sessions set expires_at = now() - interval '1 minute' where id = (select id from t_session);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'expired session cannot read annotations');
reset role;

-- Isolate the three publication-state predicates with otherwise valid access/session rows.
update public.reader_sessions set expires_at = now() + interval '15 minutes' where id = (select id from t_session);
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'd1000000-0000-0000-0000-000000000051' and (b.id = 'd1000000-0000-0000-0000-000000000020');
set local role authenticated; select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'superseded publication cannot be annotated');
reset role;
update public.editions e set active_publication_id = pub.id, status = 'published'
from public.books b, public.ebook_publications pub join public.ebook_assets pa on pa.id = pub.ebook_asset_id
where b.id = e.book_id and pa.edition_id = e.id and pub.id = 'd1000000-0000-0000-0000-000000000050' and (b.id = 'd1000000-0000-0000-0000-000000000020');
update public.ebook_publications set status = 'ready_for_preview' where id = 'd1000000-0000-0000-0000-000000000050';
set local role authenticated; select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'non-published publication cannot be annotated');
reset role;
update public.ebook_publications set status = 'published' where id = 'd1000000-0000-0000-0000-000000000050';
update public.books set status = 'draft' where id = 'd1000000-0000-0000-0000-000000000020';
set local role authenticated; select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'unpublished book cannot be annotated');
reset role;

update public.books set status = 'published' where id = 'd1000000-0000-0000-0000-000000000020';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select id from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'delete', (select id from t_annotation))), (select id from t_annotation), 'owner deletion returns the deleted row');
select is((select count(*) from public.reader_annotation_request((select id from t_session), 'd1000000-0000-0000-0000-000000000050', 'list'))::int, 0, 'owner deletion leaves no annotation to list');
reset role;

select * from finish();
rollback;
