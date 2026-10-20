begin;
select plan(33);

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's1-rpc-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'c1000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's1-rpc-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'c1000000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name)
values ('c2000000-0000-0000-0000-000000000001', 's1-author', 'S1 Author');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values
  ('c3000000-0000-0000-0000-000000000001', 's1-book-a', 'vi', 'c2000000-0000-0000-0000-000000000001', 'draft'),
  ('c3000000-0000-0000-0000-000000000002', 's1-book-b', 'vi', 'c2000000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values
  ('c3000000-0000-0000-0000-000000000001', 'vi', 'book-a-vi', 'Book A'),
  ('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-old', 'Book B');
insert into public.redirects (source_path, destination_path)
values ('/vi/books/book-b-older', '/vi/books/book-b-old');
insert into public.topics (id, canonical_slug, name)
values ('c5000000-0000-0000-0000-000000000001', 's1-topic-one', 'Topic One'),
       ('c5000000-0000-0000-0000-000000000002', 's1-topic-two', 'Topic Two');
insert into public.series (id, canonical_slug, display_name, status)
values ('c4000000-0000-0000-0000-000000000001', 's1-series', 'S1 Series', 'published');

-- (1)-(2) Grants.
select is(
  has_function_privilege('anon', 'public.admin_create_book(text, text, text, text, text, text, text, text, bigint, uuid)', 'EXECUTE'),
  false,
  'anon holds no EXECUTE on admin_create_book'
);
select is(
  has_function_privilege('authenticated', 'public.record_slug_redirect(text, text)', 'EXECUTE'),
  false,
  'authenticated cannot call record_slug_redirect directly'
);

-- (3) Non-admins are rejected by the function itself.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.admin_create_book('reader-book', 'Reader', 'vi', 'vi', 'Reader Book', 'reader-book', 'VN', 'VND', 0)$$,
  '42501',
  null,
  'non-admin cannot create a book'
);

-- (4)-(6) admin_create_book reuses an existing author by derived slug, and unaccents new names.
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select public.admin_create_book('s1-new-book', 'S1 Author', 'vi', 'vi', 'New Book', 's1-new-book', 'VN', 'VND', 0);
select is(
  (select primary_author_id from public.books where canonical_key = 's1-new-book'),
  'c2000000-0000-0000-0000-000000000001'::uuid,
  'admin_create_book reuses the existing author'
);
select lives_ok(
  $$select public.admin_create_book('s1-viet-book', 'Phương Bùi', 'vi', 'vi', 'Sách Việt', 's1-viet-book', 'VN', 'VND', 0)$$,
  'admin_create_book accepts a Vietnamese author name'
);
reset role;
select ok(exists(select 1 from public.authors where canonical_slug = 'phuong-bui'), 'Vietnamese author slug is unaccented');

insert into public.authors (id, canonical_slug, display_name) values
  ('c2000000-0000-0000-0000-000000000002', 'shared-name-one', 'Shared Name'),
  ('c2000000-0000-0000-0000-000000000003', 'shared-name-two', 'Shared Name');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select public.admin_create_book('s1-selected-author', '', 'vi', 'vi', 'Selected Author', 's1-selected-author', 'VN', 'VND', 0, 'c2000000-0000-0000-0000-000000000003');
reset role;
select is(
  (select primary_author_id from public.books where canonical_key = 's1-selected-author'),
  'c2000000-0000-0000-0000-000000000003'::uuid,
  'admin_create_book uses the selected author ID even when display names are duplicated'
);

-- (7)-(8) Renaming a draft book's slug records no redirect.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000001', 'vi', 'book-a-renamed', 'Book A', null, null, 'About A', null, '[]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames a draft book slug'
);
reset role;
select is((select count(*)::bigint from public.redirects where source_path = '/vi/books/book-a-vi'), 0::bigint, 'draft rename records no redirect');

-- (9)-(11) Renaming a published book's slug records a redirect and rewrites the older one.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-new', 'Book B', null, null, 'About B', 'Readers', '[{"title":"T","summary":"S"}]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames a published book slug'
);
reset role;
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-old'), '/vi/books/book-b-new', 'old slug redirects to new slug');
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-older'), '/vi/books/book-b-new', 'older redirect is rewritten, so nothing chains');

-- (12)-(14) Renaming back removes the redirect that would loop.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_book_localization('c3000000-0000-0000-0000-000000000002', 'vi', 'book-b-old', 'Book B', null, null, 'About B', 'Readers', '[{"title":"T","summary":"S"}]'::jsonb, '[]'::jsonb, null, null)$$,
  'admin renames the slug back'
);
reset role;
select is((select count(*)::bigint from public.redirects where source_path = '/vi/books/book-b-old'), 0::bigint, 'the current slug is never a redirect source');
select is((select destination_path from public.redirects where source_path = '/vi/books/book-b-new'), '/vi/books/book-b-old', 'the abandoned slug redirects to the restored one');

-- (15) Book-page content is stored.
select is(
  (select key_ideas from public.book_localizations where book_id = 'c3000000-0000-0000-0000-000000000002' and locale = 'vi'),
  '[{"title":"T","summary":"S"}]'::jsonb,
  'key ideas are stored as given'
);

-- (16)-(17) Entity localizations.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_save_entity_localization('author', 'c2000000-0000-0000-0000-000000000001', 'en', 'author-en', 'S1 Author', 'Bio')$$,
  'admin saves an author localization'
);
select throws_ok(
  $$select public.admin_save_entity_localization('publisher', 'c2000000-0000-0000-0000-000000000001', 'en', 'x', 'X', null)$$,
  '22023',
  null,
  'unknown entity type is rejected'
);

-- (18)-(22) Relations are replaced as a set.
select lives_ok(
  $$select public.admin_set_book_relations('c3000000-0000-0000-0000-000000000001', array['c5000000-0000-0000-0000-000000000001', 'c5000000-0000-0000-0000-000000000002']::uuid[], 'c4000000-0000-0000-0000-000000000001', 1)$$,
  'admin sets topics and series'
);
select is((select count(*)::bigint from public.book_topics where book_id = 'c3000000-0000-0000-0000-000000000001'), 2::bigint, 'two topics attached');
select lives_ok(
  $$select public.admin_set_book_relations('c3000000-0000-0000-0000-000000000001', array['c5000000-0000-0000-0000-000000000002']::uuid[], null, null)$$,
  'admin replaces relations'
);
select is((select count(*)::bigint from public.book_topics where book_id = 'c3000000-0000-0000-0000-000000000001'), 1::bigint, 'topics replaced');
select is((select count(*)::bigint from public.book_series where book_id = 'c3000000-0000-0000-0000-000000000001'), 0::bigint, 'series membership removed');

-- (23)-(28) Cover: key must exist, belong to the book, and replacing keeps one row.
select throws_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000002/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover', 600, 900)$$,
  '22023',
  null,
  'a cover key under another book is rejected'
);
select throws_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover', 600, 900)$$,
  'P0002',
  null,
  'a cover key without an uploaded storage object is rejected'
);
reset role;
insert into storage.objects (id, bucket_id, name) values
  ('ca000000-0000-0000-0000-000000000001', 'covers', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png'),
  ('ca000000-0000-0000-0000-000000000002', 'covers', 'books/c3000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webp');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000001/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png', 'Cover', 600, 900)$$,
  'admin sets an uploaded cover'
);
select lives_ok(
  $$select public.admin_set_book_cover('c3000000-0000-0000-0000-000000000001', 'books/c3000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webp', 'New cover', 600, 900)$$,
  'admin replaces the cover'
);
reset role;
select is((select count(*)::bigint from public.media_assets where owner_id = 'c3000000-0000-0000-0000-000000000001' and kind = 'cover'), 1::bigint, 'one cover row per book');
select is(
  (select storage_key from public.media_assets where owner_id = 'c3000000-0000-0000-0000-000000000001' and kind = 'cover'),
  'books/c3000000-0000-0000-0000-000000000001/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.webp',
  'the replacement key is stored'
);

-- (29)-(32) Merchandising.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.admin_set_merchandising('home_featured', array['c3000000-0000-0000-0000-000000000001', 'c3000000-0000-0000-0000-000000000002']::uuid[])$$,
  '22023',
  null,
  'home_featured accepts at most one book'
);
select lives_ok(
  $$select public.admin_set_merchandising('home_shelf', array['c3000000-0000-0000-0000-000000000002', 'c3000000-0000-0000-0000-000000000001']::uuid[])$$,
  'admin sets the home shelf'
);
reset role;
select results_eq(
  $$select book_id from public.merchandising_slots where slot_key = 'home_shelf' order by position$$,
  $$values ('c3000000-0000-0000-0000-000000000002'::uuid), ('c3000000-0000-0000-0000-000000000001'::uuid)$$,
  'shelf order follows the submitted order'
);
select is((select count(*)::bigint from public.audit_logs where action = 'set_merchandising'), 1::bigint, 'merchandising change is audited once');

select * from finish();
rollback;
