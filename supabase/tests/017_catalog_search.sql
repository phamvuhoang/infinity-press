begin;
select plan(18);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's2-search-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e2000000-0000-0000-0000-000000000001', 's2s-author', 'Nguyễn Nhật Ánh S2S', 'published');
insert into public.author_localizations (author_id, locale, slug, name)
values ('e2000000-0000-0000-0000-000000000001', 'vi', 's2s-nguyen-nhat-anh', 'Nguyễn Nhật Ánh S2S');

-- A published book whose author went back to draft after publishing.
insert into public.authors (id, canonical_slug, display_name, status)
values ('e2000000-0000-0000-0000-000000000002', 's2s-draft-author', 'Trần Nháp S2S', 'draft');
insert into public.author_localizations (author_id, locale, slug, name)
values ('e2000000-0000-0000-0000-000000000002', 'vi', 's2s-tran-nhap', 'Trần Nháp S2S');

insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e3000000-0000-0000-0000-000000000001', 's2s-exact', 'vi', 'e2000000-0000-0000-0000-000000000001', 'published'),
  ('e3000000-0000-0000-0000-000000000002', 's2s-partial', 'vi', 'e2000000-0000-0000-0000-000000000001', 'published'),
  ('e3000000-0000-0000-0000-000000000003', 's2s-draft', 'vi', 'e2000000-0000-0000-0000-000000000001', 'draft'),
  ('e3000000-0000-0000-0000-000000000004', 's2s-draft-author-book', 'vi', 'e2000000-0000-0000-0000-000000000002', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e3000000-0000-0000-0000-000000000001', 'vi', 's2s-nhan-tam', 'Nhân Tâm S2S'),
  ('e3000000-0000-0000-0000-000000000002', 'vi', 's2s-dac-nhan-tam', 'Đắc Nhân Tâm S2S'),
  ('e3000000-0000-0000-0000-000000000003', 'vi', 's2s-sach-nhap', 'Nhân Tâm S2S Nháp'),
  ('e3000000-0000-0000-0000-000000000004', 'vi', 's2s-sach-khac', 'Hoa Vàng S2S');

insert into public.topics (id, canonical_slug, name, status) values
  ('e5000000-0000-0000-0000-000000000001', 's2s-topic', 'Tâm Lý S2S', 'published'),
  ('e5000000-0000-0000-0000-000000000002', 's2s-draft-topic', 'Tâm Lý Nháp S2S', 'draft');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('e5000000-0000-0000-0000-000000000001', 'vi', 's2s-tam-ly', 'Tâm Lý S2S'),
  ('e5000000-0000-0000-0000-000000000002', 'vi', 's2s-tam-ly-nhap', 'Tâm Lý Nháp S2S');
insert into public.book_topics (book_id, topic_id) values
  ('e3000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001'),
  ('e3000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000002');


-- Press: a work is listed only when it has a readable edition, so each published work gets one in its
-- original language with a live publication.
insert into public.editions (book_id, language_code)
select b.id, b.original_language from public.books b
where b.status = 'published' and not exists (select 1 from public.editions e where e.book_id = b.id);
insert into public.ebook_assets (edition_id, source_storage_key, version, status)
select e.id, 'fx/' || e.id || '.epub', 1, 'published'
from public.editions e join public.books b on b.id = e.book_id
where b.status = 'published' and e.active_publication_id is null;
insert into public.ebook_publications (ebook_asset_id, version, manifest_key, status, epub_language)
select a.id, 1, 'fx/' || a.id || '.json', 'published', e.language_code
from public.ebook_assets a join public.editions e on e.id = a.edition_id where a.source_storage_key like 'fx/%';
update public.editions e set status = 'published', active_publication_id = p.id
from public.ebook_publications p join public.ebook_assets a on a.id = p.ebook_asset_id
where a.edition_id = e.id and a.source_storage_key like 'fx/%';

-- (1)-(2) Grants.
select is(has_function_privilege('anon', 'public.search_catalog(text, text)', 'EXECUTE'), true, 'anon can search');
select is(has_function_privilege('authenticated', 'public.catalog_match_score(text, text)', 'EXECUTE'), false, 'the score helper is internal');

set local role anon;

-- (3)-(6) Diacritics and case do not matter.
select is((select score from public.search_catalog('vi', 'dac nhan tam s2s') where slug = 's2s-dac-nhan-tam'), 3, 'a query without diacritics matches exactly');
select is((select score from public.search_catalog('vi', 'Đắc Nhân Tâm S2S') where slug = 's2s-dac-nhan-tam'), 3, 'a query with diacritics matches exactly');
select is((select score from public.search_catalog('vi', 'ĐẮC NHÂN TÂM S2S') where slug = 's2s-dac-nhan-tam'), 3, 'an upper-case query matches exactly');
select is((select score from public.search_catalog('vi', 'dac nhan') where slug = 's2s-dac-nhan-tam'), 2, 'a prefix scores 2');

-- (7)-(8) An exact title outranks a partial one.
select is((select score from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-nhan-tam'), 3, 'the exact title scores 3');
select is((select score from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-dac-nhan-tam'), 1, 'the containing title scores 1');

-- (9) Drafts never match.
select is((select count(*)::bigint from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-sach-nhap'), 0::bigint, 'a draft book never matches');

-- (10)-(11) An exact author name lifts their books and returns the author.
select is((select score from public.search_catalog('vi', 'nguyen nhat anh s2s') where kind = 'book' and slug = 's2s-dac-nhan-tam'), 3, 'an exact author name scores their book 3');
select is((select count(*)::bigint from public.search_catalog('vi', 'nguyen nhat anh s2s') where kind = 'author'), 1::bigint, 'the author is returned');

-- (12) A draft author's exact name does not lift their published book.
select is(coalesce((select score from public.search_catalog('vi', 'tran nhap s2s') where kind = 'book' and slug = 's2s-sach-khac'), 0) < 3, true, 'a draft author name does not score their book 3');

-- (13)-(14) Topics follow visibility.
select is((select count(*)::bigint from public.search_catalog('vi', 'tam ly s2s') where kind = 'topic' and slug = 's2s-tam-ly'), 1::bigint, 'a published topic matches');
select is((select count(*)::bigint from public.search_catalog('vi', 'tam ly nhap s2s') where kind = 'topic' and slug = 's2s-tam-ly-nhap'), 0::bigint, 'a draft topic never matches');

-- (15) A small typo still matches through trigram word similarity.
select cmp_ok((select count(*)::bigint from public.search_catalog('vi', 'nhan tamm s2s') where kind = 'book'), '>=', 1::bigint, 'a small typo still matches');

-- (16)-(17) Guard rails.
select is((select count(*)::bigint from public.search_catalog('vi', ' a ')), 0::bigint, 'a one-character query returns nothing');
select is((select count(*)::bigint from public.search_catalog('en', 'nhan tam s2s')), 0::bigint, 'vi-only books do not match in en');

reset role;

-- (18) An admin caller still gets the public view.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1000000-0000-0000-0000-000000000001', true);
select is((select count(*)::bigint from public.search_catalog('vi', 'nhan tam s2s') where slug = 's2s-sach-nhap'), 0::bigint, 'an admin search does not return drafts');
reset role;

select * from finish();
rollback;
