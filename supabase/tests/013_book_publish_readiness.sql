begin;
select plan(29);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-pub-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-pub-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-pub-author', 'S1 Pub Author');
insert into public.books (id, canonical_key, original_language, primary_author_id)
values ('c3000000-0000-0000-0000-000000000001', 's1-pub-book', 'vi', 'c2000000-0000-0000-0000-000000000001');
insert into public.book_localizations (book_id, locale, slug, title)
values ('c3000000-0000-0000-0000-000000000001', 'vi', 's1-pub-book', 'S1 Pub Book');
insert into public.editions (id, book_id, language_code)
values ('c6000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000001', 'vi');
insert into public.skus (id, edition_id, sku_code)
values ('c7000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 's1-pub-book-ebook');
insert into public.offers (sku_id, market_code, currency, price_minor)
values ('c7000000-0000-0000-0000-000000000001', 'VN', 'VND', 0);
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('c8000000-0000-0000-0000-000000000001', 'c6000000-0000-0000-0000-000000000001', 's1-pub/source.epub', 1, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
values ('c9000000-0000-0000-0000-000000000001', 'c8000000-0000-0000-0000-000000000001', 1, 's1-pub/manifest.json', 'ready_for_preview', 'vi');

select is(
  has_function_privilege('authenticated', 'public.book_readiness_issues(uuid)', 'EXECUTE'),
  false,
  'authenticated cannot call book_readiness_issues directly'
);
select is(has_function_privilege('anon', 'public.publish_book(uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on publish_book');
select is(has_function_privilege('authenticated', 'public.publish_book(uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on publish_book');
select is(has_function_privilege('anon', 'public.unpublish_book(uuid)', 'EXECUTE'), false, 'anon holds no EXECUTE on unpublish_book');
select is(has_function_privilege('authenticated', 'public.unpublish_book(uuid)', 'EXECUTE'), true, 'authenticated holds EXECUTE on unpublish_book');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok($$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$, '42501', null, 'non-admin cannot publish a book');
select throws_ok($$select public.unpublish_book('c3000000-0000-0000-0000-000000000001')$$, '42501', null, 'non-admin cannot unpublish a book');
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$,
  'EB010',
  'publish_book: book is not ready: missing_localization,missing_author,missing_cover,missing_publication',
  'an incomplete book reports every missing piece'
);

select lives_ok($$select public.publish_publication('c9000000-0000-0000-0000-000000000001')$$, 'admin publishes the EPUB version');
reset role;
select is((select status from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'draft'::public.content_status, 'publish_publication leaves the book draft');
select is((select active_publication_id from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'c9000000-0000-0000-0000-000000000001'::uuid, 'publish_publication still moves the active pointer');
select is((select status from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'draft'::public.content_status, 'publish_publication leaves the author draft');

update public.book_localizations set description = 'A complete description.' where book_id = 'c3000000-0000-0000-0000-000000000001';
insert into public.media_assets (owner_type, owner_id, kind, storage_key, alt_text)
values ('book', 'c3000000-0000-0000-0000-000000000001', 'cover', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$,
  'EB010',
  'publish_book: book is not ready: missing_author',
  'an author without localized copy blocks publication'
);
reset role;
insert into public.author_localizations (author_id, locale, slug, name)
values ('c2000000-0000-0000-0000-000000000001', 'vi', 's1-pub-author', 'S1 Pub Author');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.publish_book('c3000000-0000-0000-0000-000000000001')$$, 'admin publishes a complete book');
set local role anon;
select ok(exists(select 1 from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'anon sees the published book');
select ok(exists(select 1 from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'anon sees the published book''s author');
reset role;

-- A catalog-published book remains public while later EPUB versions are published or rolled back.
insert into public.ebook_assets (id, edition_id, source_storage_key, version, status)
values ('c8000000-0000-0000-0000-000000000002', 'c6000000-0000-0000-0000-000000000001', 's1-pub/source-v2.epub', 2, 'ready_for_preview');
insert into public.ebook_publications (id, ebook_asset_id, version, manifest_key, status, epub_language)
values ('c9000000-0000-0000-0000-000000000002', 'c8000000-0000-0000-0000-000000000002', 2, 's1-pub/manifest-v2.json', 'ready_for_preview', 'vi');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.publish_publication('c9000000-0000-0000-0000-000000000002')$$, 'admin publishes a later EPUB version');
reset role;
select is((select status from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'published'::public.content_status, 'publishing a later EPUB version leaves the catalog-published book published');
select is((select status from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'published'::public.content_status, 'publishing a later EPUB version leaves the primary author published');
set local role anon;
select ok(exists(select 1 from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'anon still sees the primary author after publishing a later EPUB version');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.rollback_publication('c3000000-0000-0000-0000-000000000001', 'c9000000-0000-0000-0000-000000000001')$$, 'admin rolls back to the earlier EPUB version');
reset role;
select is((select status from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'published'::public.content_status, 'rolling back an EPUB version leaves the catalog-published book published');
select is((select status from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'published'::public.content_status, 'rolling back an EPUB version leaves the primary author published');
set local role anon;
select ok(exists(select 1 from public.authors where id = 'c2000000-0000-0000-0000-000000000001'), 'anon still sees the primary author after rolling back an EPUB version');
reset role;

select is((select count(*)::bigint from public.audit_logs where action = 'publish_book' and entity_id = 'c3000000-0000-0000-0000-000000000001'), 1::bigint, 'publish_book is audited once');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok($$select public.unpublish_book('c3000000-0000-0000-0000-000000000001')$$, 'admin unpublishes the book');
set local role anon;
select ok(not exists(select 1 from public.books where id = 'c3000000-0000-0000-0000-000000000001'), 'anon no longer sees the unpublished book');
reset role;
select is((select count(*) from public.audit_logs where action = 'unpublish_book' and entity_id = 'c3000000-0000-0000-0000-000000000001'), 1::bigint, 'unpublish_book is audited once');
select is((select actor_profile_id from public.audit_logs where action = 'unpublish_book' and entity_id = 'c3000000-0000-0000-0000-000000000001'), (select id from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001'), 'unpublish audit identifies the operator');

select * from finish();
rollback;
