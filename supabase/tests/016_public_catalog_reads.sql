begin;
select plan(41);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'd1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's2-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'd1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status) values
  ('d2000000-0000-0000-0000-000000000001', 's2-author', 'S2 Author', 'published'),
  ('d2000000-0000-0000-0000-000000000002', 's2-draft-author', 'S2 Draft Author', 'draft');
insert into public.author_localizations (author_id, locale, slug, name, description) values
  ('d2000000-0000-0000-0000-000000000001', 'vi', 's2-tac-gia', 'Tác giả S2', 'Mô tả tác giả'),
  ('d2000000-0000-0000-0000-000000000001', 'en', 's2-author-en', 'S2 Author', 'Author bio'),
  ('d2000000-0000-0000-0000-000000000002', 'vi', 's2-tac-gia-nhap', 'Tác giả nháp', null);

insert into public.books (id, canonical_key, original_language, primary_author_id, status, created_at, default_content_language) values
  ('d3000000-0000-0000-0000-000000000001', 's2-free', 'vi', 'd2000000-0000-0000-0000-000000000001', 'published', '2026-09-01', 'vi'),
  ('d3000000-0000-0000-0000-000000000002', 's2-paid', 'vi', 'd2000000-0000-0000-0000-000000000001', 'published', '2026-09-02', 'vi'),
  ('d3000000-0000-0000-0000-000000000003', 's2-draft', 'vi', 'd2000000-0000-0000-0000-000000000002', 'draft', '2026-09-03', 'vi'),
  -- Published, but nothing readable yet: it is not listed in any language (Press catalog rule 3).
  ('d3000000-0000-0000-0000-000000000004', 's2-unready', 'vi', 'd2000000-0000-0000-0000-000000000001', 'published', '2026-09-04', 'vi');
insert into public.book_localizations (book_id, locale, slug, title, short_description, description, audience, key_ideas) values
  ('d3000000-0000-0000-0000-000000000001', 'vi', 's2-sach-mien-phi', 'Sách miễn phí S2', 'Ngắn', 'Dài', 'Người mới', '[{"title":"Ý chính","summary":"Tóm tắt"}]'),
  ('d3000000-0000-0000-0000-000000000001', 'en', 's2-free-book', 'S2 Free Book', 'Short', 'Long', null, '[]'),
  ('d3000000-0000-0000-0000-000000000002', 'vi', 's2-sach-tra-phi', 'Sách trả phí S2', null, 'Dài', null, '[]'),
  ('d3000000-0000-0000-0000-000000000003', 'vi', 's2-sach-nhap', 'Sách nháp S2', null, 'Dài', null, '[]'),
  ('d3000000-0000-0000-0000-000000000004', 'vi', 's2-sach-chua-san-sang', 'Sách chưa sẵn sàng S2', null, 'Dài', null, '[]');

insert into public.editions (id, book_id, language_code) values
  ('d6000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 'vi'),
  ('d6000000-0000-0000-0000-000000000002', 'd3000000-0000-0000-0000-000000000002', 'vi'),
  ('d6000000-0000-0000-0000-000000000004', 'd3000000-0000-0000-0000-000000000004', 'vi');
insert into public.skus (id, edition_id, sku_code) values
  ('d7000000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 's2-free-ebook'),
  ('d7000000-0000-0000-0000-000000000002', 'd6000000-0000-0000-0000-000000000002', 's2-paid-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor) values
  ('d7000000-0000-0000-0000-000000000001', 'VN', 'VND', 0),
  ('d7000000-0000-0000-0000-000000000002', 'VN', 'VND', 129000);

insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('d8000000-0000-0000-0000-000000000001', 'd6000000-0000-0000-0000-000000000001', 's2/source.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('d9000000-0000-0000-0000-000000000001', 'd8000000-0000-0000-0000-000000000001', 1, 's2/manifest.json', 'published');
update public.books set active_publication_id = 'd9000000-0000-0000-0000-000000000001'
where id = 'd3000000-0000-0000-0000-000000000001';
insert into public.book_samples (publication_id, allowed_hrefs)
values ('d9000000-0000-0000-0000-000000000001', '["OEBPS/text/chapter1.xhtml"]');
-- The paid book has a published publication with a sample, but it is not the active publication.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('d8000000-0000-0000-0000-000000000002', 'd6000000-0000-0000-0000-000000000002', 's2/paid-source.epub', 1, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('d9000000-0000-0000-0000-000000000002', 'd8000000-0000-0000-0000-000000000002', 1, 's2/paid-manifest.json', 'published');
insert into public.book_samples (publication_id, allowed_hrefs)
values ('d9000000-0000-0000-0000-000000000002', '["OEBPS/text/chapter1.xhtml"]');
-- The edition's live publication is a later one with no sample of its own.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('d8000000-0000-0000-0000-000000000003', 'd6000000-0000-0000-0000-000000000002', 's2/paid-source-2.epub', 2, 'published');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status)
values ('d9000000-0000-0000-0000-000000000003', 'd8000000-0000-0000-0000-000000000003', 2, 's2/paid-manifest-2.json', 'published');
update public.books set active_publication_id = 'd9000000-0000-0000-0000-000000000003'
where id = 'd3000000-0000-0000-0000-000000000002';
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('book', 'd3000000-0000-0000-0000-000000000001', 'cover',
        'books/d3000000-0000-0000-0000-000000000001/dddddddd-dddd-dddd-dddd-dddddddddddd.png', 'Bìa sách S2');

insert into public.series (id, canonical_slug, display_name, status)
values ('d4000000-0000-0000-0000-000000000001', 's2-series', 'S2 Series', 'published');
insert into public.series_localizations (series_id, locale, slug, name)
values ('d4000000-0000-0000-0000-000000000001', 'vi', 's2-bo-sach', 'Bộ sách S2');
insert into public.series (id, canonical_slug, display_name, status)
values ('d4000000-0000-0000-0000-000000000002', 's2-draft-series', 'S2 Draft Series', 'draft');
insert into public.series_localizations (series_id, locale, slug, name)
values ('d4000000-0000-0000-0000-000000000002', 'vi', 's2-bo-sach-nhap', 'Bộ sách nháp S2');
insert into public.book_series (book_id, series_id, position) values
  ('d3000000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 1),
  ('d3000000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000002', 1);

-- d5..03 is localized in both locales, but its only book (the paid book) is vi-only.
insert into public.topics (id, canonical_slug, name, status) values
  ('d5000000-0000-0000-0000-000000000001', 's2-topic', 'S2 Topic', 'published'),
  ('d5000000-0000-0000-0000-000000000002', 's2-draft-topic', 'S2 Draft Topic', 'draft'),
  ('d5000000-0000-0000-0000-000000000003', 's2-vi-only-topic', 'S2 Vi-only Topic', 'published'),
  ('d5000000-0000-0000-0000-000000000004', 's2-unready-topic', 'S2 Unready Topic', 'published');
insert into public.topic_localizations (topic_id, locale, slug, name) values
  ('d5000000-0000-0000-0000-000000000001', 'vi', 's2-chu-de', 'Chủ đề S2'),
  ('d5000000-0000-0000-0000-000000000002', 'vi', 's2-chu-de-nhap', 'Chủ đề nháp'),
  ('d5000000-0000-0000-0000-000000000003', 'vi', 's2-chu-de-tieng-viet', 'Chủ đề tiếng Việt S2'),
  ('d5000000-0000-0000-0000-000000000003', 'en', 's2-vi-only-topic-en', 'S2 Vi-only Topic'),
  ('d5000000-0000-0000-0000-000000000004', 'vi', 's2-chu-de-chua-san-sang', 'Chủ đề chưa sẵn sàng');
insert into public.book_topics (book_id, topic_id) values
  ('d3000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000001'),
  ('d3000000-0000-0000-0000-000000000001', 'd5000000-0000-0000-0000-000000000002'),
  ('d3000000-0000-0000-0000-000000000002', 'd5000000-0000-0000-0000-000000000003'),
  ('d3000000-0000-0000-0000-000000000004', 'd5000000-0000-0000-0000-000000000004');

delete from public.merchandising_slots;
insert into public.merchandising_slots (slot_key, book_id, position) values
  ('home_featured', 'd3000000-0000-0000-0000-000000000001', 1),
  ('home_shelf', 'd3000000-0000-0000-0000-000000000002', 1);

-- (1)-(5) Grants.
select is(has_function_privilege('anon', 'public.catalog_book_cards(text)', 'EXECUTE'), true, 'anon can read book cards');
select is(has_function_privilege('anon', 'public.catalog_book_page(text, text)', 'EXECUTE'), true, 'anon can read a book page');
select is(has_function_privilege('anon', 'public.catalog_entity_page(text, text, text)', 'EXECUTE'), true, 'anon can read an entity page');
select is(has_function_privilege('authenticated', 'public.catalog_has_visible_book(text, uuid, text)', 'EXECUTE'), false, 'the visibility helper is internal');
select is(has_table_privilege('anon', 'public.author_localizations', 'SELECT'), false, 'anon still cannot select author localizations');

set local role anon;

-- (6)-(8) Only published, localized books.
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id in ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002')), 2::bigint, 'vi lists both published books');
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000003'), 0::bigint, 'a draft book is not listed');
select is((select count(*)::bigint from public.catalog_book_cards('en') where book_id in ('d3000000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000002')), 2::bigint, 'en lists both works: their effective default edition is Vietnamese');
select is((select language_code || ':' || is_language_fallback || ':' || metadata_locale from public.catalog_book_cards('en') where book_id = 'd3000000-0000-0000-0000-000000000001'), 'vi:true:en', 'the translated work shows its English copy and says the EPUB is Vietnamese');
select is((select language_code || ':' || is_language_fallback || ':' || metadata_locale from public.catalog_book_cards('en') where book_id = 'd3000000-0000-0000-0000-000000000002'), 'vi:true:vi', 'the untranslated one falls back to its original copy as a whole');
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000004'), 0::bigint, 'a published work with nothing readable is not listed');

-- (9)-(17) Card fields.
select is((select has_sample from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), true, 'the free book has a sample');
select is((select has_active_publication from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), true, 'every listed book has a readable edition');
select is((select cover_path from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 'books/d3000000-0000-0000-0000-000000000001/dddddddd-dddd-dddd-dddd-dddddddddddd.png', 'the cover path is returned');
select is((select topics from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), '[{"slug": "s2-chu-de", "name": "Chủ đề S2"}]'::jsonb, 'draft topics are hidden');
select is((select series_slug from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 's2-bo-sach', 'the series slug is returned');
select is((select featured from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), true, 'the featured flag is returned');
select is((select shelf_position from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), 1, 'the shelf position is returned');
select is((select price_minor from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), 129000::bigint, 'the active offer price is returned');
select is((select author_slug from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000001'), 's2-tac-gia', 'the localized author slug is returned');

-- (18)-(19) A sample or series that is not publicly visible stays off the card.
select is((select has_sample from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), false, 'a sample on a non-active publication does not count');
select is((select series_slug from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000002'), null, 'a draft series is not on the card');

-- (20)-(23) Book page.
select is(public.catalog_book_page('vi', 's2-sach-mien-phi') -> 'alternateSlugs' ->> 'en', 's2-free-book', 'the book page names the other locale slug');
select is(public.catalog_book_page('vi', 's2-sach-tra-phi') -> 'alternateSlugs', '{}'::jsonb, 'no alternate slug without a translation');
select is(public.catalog_book_page('vi', 's2-sach-nhap'), null::jsonb, 'a draft book page is null');
select is(public.catalog_book_page('vi', 's2-free-book'), null::jsonb, 'an en slug does not resolve under vi');

-- (24)-(34) Entity pages.
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia') ->> 'name', 'Tác giả S2', 'a published author page resolves');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia') -> 'alternateSlugs' ->> 'en', 's2-author-en', 'the author page names the en slug');
select is(public.catalog_entity_page('series', 'en', 's2-bo-sach'), null::jsonb, 'a series without en copy has no en page');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia-nhap'), null::jsonb, 'a draft author page is null');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-nhap'), null::jsonb, 'a draft topic page is null');
select is(public.catalog_entity_page('series', 'vi', 's2-bo-sach-nhap'), null::jsonb, 'a draft series page is null');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-tieng-viet') ->> 'name', 'Chủ đề tiếng Việt S2', 'a topic with a vi book resolves in vi');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-tieng-viet') -> 'alternateSlugs', '{"en": "s2-vi-only-topic-en"}'::jsonb, 'the English page exists too, because the topic''s work is shown there in its Vietnamese edition');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-chua-san-sang'), null::jsonb, 'a published topic whose only work has nothing readable is null');
select is(public.catalog_entity_page('publisher', 'vi', 's2-tac-gia'), null::jsonb, 'an unknown kind is null');
select is((select count(*)::bigint from public.catalog_book_cards('fr')), 0::bigint, 'an unsupported locale returns nothing');

reset role;

-- (35)-(38) An admin caller still gets the public view.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-0000-0000-000000000001', true);
select is((select count(*)::bigint from public.catalog_book_cards('vi') where book_id = 'd3000000-0000-0000-0000-000000000003'), 0::bigint, 'an admin does not see draft cards');
select is(public.catalog_entity_page('author', 'vi', 's2-tac-gia-nhap'), null::jsonb, 'an admin does not see a draft author page');
select is(public.catalog_entity_page('series', 'vi', 's2-bo-sach-nhap'), null::jsonb, 'an admin does not see a draft series page');
select is(public.catalog_entity_page('topic', 'vi', 's2-chu-de-nhap'), null::jsonb, 'an admin does not see a draft topic page');
reset role;

select * from finish();
rollback;
