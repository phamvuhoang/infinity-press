begin;
select plan(31);

-- S13 reviews: entitlement-gated writes, one row per reader per book, edits return to pending and
-- keep the author's reply, public reads see only published rows of published books.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 's13-owner@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 's13-stranger@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Minh Anh' where auth_user_id = 'e1300000-0000-0000-0000-000000000001';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000001', 's13-author', 'S13 Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e1320000-0000-0000-0000-000000000001', 's13-book', 'vi', 'e1330000-0000-0000-0000-000000000001', 'published'),
  ('e1320000-0000-0000-0000-000000000002', 's13-book-draft', 'vi', 'e1330000-0000-0000-0000-000000000001', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e1320000-0000-0000-0000-000000000001', 'vi', 's13-book', 'Sách S13'),
  ('e1320000-0000-0000-0000-000000000002', 'vi', 's13-book-draft', 'Nháp S13');

-- Press: every work has an edition, and access (hence a review) is per edition.
insert into public.editions (book_id, language_code)
select b.id, 'vi' from public.books b where not exists (select 1 from public.editions e where e.book_id = b.id);

insert into public.entitlements (id, profile_id, book_id, source_type, actor_profile_id, reason, status)
select 'e1340000-0000-0000-0000-000000000001', p.id, 'e1320000-0000-0000-0000-000000000001', 'admin_grant', p.id, 'fixture', 'active'
from public.profiles p where p.auth_user_id = 'e1300000-0000-0000-0000-000000000001';

-- Writes ----------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, 'Hay', 'vi')$$,
  'EB034', null, 'a reader without an entitlement cannot review');
select is(public.get_my_book_review('e1320000-0000-0000-0000-000000000001'), null, 'no review reads as null');

select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 6, 'Hay', 'vi')$$,
  '22023', null, 'rating above 5 is refused');
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, '<b>Hay</b>', 'vi')$$,
  '22023', null, 'html in the body is refused');
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, repeat('a', 1001), 'vi')$$,
  '22023', null, 'a 1001-character body is refused');
select is(
  (public.submit_book_review('e1320000-0000-0000-0000-000000000001', 5, '  Cuốn sách rất hay.  ', 'vi')) ->> 'status',
  'pending', 'a new review is pending');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'body',
  'Cuốn sách rất hay.', 'the body is trimmed');
select throws_ok(
  $$insert into public.book_reviews (book_id, profile_id, rating, body, locale) select 'e1320000-0000-0000-0000-000000000001', id, 5, 'x', 'vi' from public.profiles$$,
  '42501', null, 'no role inserts directly');
reset role;

-- Publish via direct update as a fixture (the admin RPC is Task 2) and add a reply.
update public.book_reviews set status = 'published', published_at = now(), author_reply = 'Cảm ơn bạn', author_reply_at = now()
where book_id = 'e1320000-0000-0000-0000-000000000001';

-- Public read ------------------------------------------------------------------------------------
set local role anon;
select is(jsonb_array_length(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5)), 1, 'anon sees the published review');
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 ->> 'reviewerName', 'Minh Anh', 'reviewer display name is shown');
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 ->> 'authorReply', 'Cảm ơn bạn', 'author reply is shown');
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary' ->> 'count', '1', 'reviewSummary counts published reviews');
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary' ->> 'average', '5.0', 'reviewSummary averages to one decimal');
select throws_ok($$select profile_id, locale from public.book_reviews$$, '42501', null, 'anon cannot read reviewer identifiers directly');
reset role;

-- The public name is the snapshot taken at submit: a later profile rename does not reach it.
update public.profiles set display_name = 'Tên Mới' where auth_user_id = 'e1300000-0000-0000-0000-000000000001';
set local role anon;
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 ->> 'reviewerName', 'Minh Anh', 'a rename after publishing does not change the public reviewer name');
reset role;

-- Edit returns to pending, keeps the reply ----------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select is(
  (public.submit_book_review('e1320000-0000-0000-0000-000000000001', 4, 'Đọc lại thấy khác.', 'vi')) ->> 'status',
  'pending', 'an edit returns the review to pending');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'authorReply',
  'Cảm ơn bạn', 'an edit keeps the author reply');
select is(
  (public.get_my_book_review('e1320000-0000-0000-0000-000000000001')) ->> 'publishedAt',
  null, 'an edit clears published_at');
reset role;
set local role anon;
select is(public.catalog_book_page('vi', 's13-book') -> 'reviewSummary', 'null'::jsonb, 'no published reviews means a null summary');
select is(jsonb_array_length(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5)), 0, 'a pending review is off the public read');
reset role;
select results_eq(
  $$select reviewer_name, status from public.book_reviews where book_id = 'e1320000-0000-0000-0000-000000000001'$$,
  $$values ('Tên Mới'::text, 'pending'::text)$$, 'an edit re-snapshots the current name and is pending');

-- Snapshot limits: at most 80 characters; tag syntax shows as the anonymous label.
update public.profiles set display_name = repeat('n', 100) where auth_user_id = 'e1300000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 4, 'Đọc lại thấy khác.', 'vi');
reset role;
select is((select reviewer_name from public.book_reviews where book_id = 'e1320000-0000-0000-0000-000000000001'), repeat('n', 80), 'a long display name is truncated to 80 characters');

update public.profiles set display_name = '<b>x</b>' where auth_user_id = 'e1300000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 4, 'Đọc lại thấy khác.', 'vi');
reset role;
update public.book_reviews set status = 'published', published_at = now() where book_id = 'e1320000-0000-0000-0000-000000000001';
set local role anon;
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000001', 5) -> 0 -> 'reviewerName', 'null'::jsonb, 'a display name with tag syntax is shown as anonymous');
reset role;
update public.book_reviews set status = 'pending', published_at = null where book_id = 'e1320000-0000-0000-0000-000000000001';

-- Revoked entitlement -------------------------------------------------------------------------
update public.entitlements set status = 'revoked', revoked_at = now() where id = 'e1340000-0000-0000-0000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.submit_book_review('e1320000-0000-0000-0000-000000000001', 3, 'Sửa', 'vi')$$,
  'EB034', null, 'a revoked reader cannot edit');
select isnt(public.get_my_book_review('e1320000-0000-0000-0000-000000000001'), null, 'a revoked reader still reads their own row');
select results_eq($$select count(*) from public.book_reviews$$, array[1::bigint], 'a reader reads own pending row through RLS');
select lives_ok($$select public.delete_book_review('e1320000-0000-0000-0000-000000000001')$$, 'a reader deletes their own review');
select throws_ok($$select public.delete_book_review('e1320000-0000-0000-0000-000000000001')$$, 'P0002', null, 'deleting twice is P0002');
reset role;

-- Draft book: a reader reads nothing public even with an entitlement row ---------------------
select is(public.catalog_book_reviews('e1320000-0000-0000-0000-000000000002', 5), '[]'::jsonb, 'a draft book has no public reviews');
select is(has_function_privilege('anon', 'public.submit_book_review(uuid, integer, text, text, uuid)', 'EXECUTE'), false, 'anon cannot submit');
select is(has_function_privilege('anon', 'public.catalog_book_reviews(uuid, integer)', 'EXECUTE'), true, 'anon can read public reviews');

select * from finish();
rollback;
