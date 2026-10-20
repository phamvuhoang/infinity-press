begin;
select plan(17);

-- Press Task 7: a review belongs to the edition the reviewer holds. A reader with English and Japanese
-- can review each; a reader with one need not say which; one with two must.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e9100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'er-both@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e9100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'er-english@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
create temporary table t_p as
select (select id from public.profiles where auth_user_id = 'e9100000-0000-0000-0000-000000000001') as both_id,
       (select id from public.profiles where auth_user_id = 'e9100000-0000-0000-0000-000000000002') as english_id;
grant select on t_p to public;

insert into public.authors (id, canonical_slug, display_name, status) values ('e9200000-0000-0000-0000-000000000001', 'er-author', 'ER Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e9300000-0000-0000-0000-000000000001', 'er-book', 'en', 'e9200000-0000-0000-0000-000000000001', 'published');
insert into public.book_localizations (book_id, locale, slug, title) values ('e9300000-0000-0000-0000-000000000001', 'en', 'er-book', 'ER Book');
insert into public.editions (id, book_id, language_code, status) values
  ('e9400000-0000-0000-0000-000000000001', 'e9300000-0000-0000-0000-000000000001', 'en', 'published'),
  ('e9400000-0000-0000-0000-000000000002', 'e9300000-0000-0000-0000-000000000001', 'ja', 'published');

insert into public.entitlements (profile_id, book_id, edition_id, source_type, actor_profile_id, reason, status) values
  ((select both_id from t_p), 'e9300000-0000-0000-0000-000000000001', 'e9400000-0000-0000-0000-000000000001', 'admin_grant', (select both_id from t_p), 'er fixture', 'active'),
  ((select both_id from t_p), 'e9300000-0000-0000-0000-000000000001', 'e9400000-0000-0000-0000-000000000002', 'admin_grant', (select both_id from t_p), 'er fixture', 'active'),
  ((select english_id from t_p), 'e9300000-0000-0000-0000-000000000001', 'e9400000-0000-0000-0000-000000000001', 'admin_grant', (select english_id from t_p), 'er fixture', 'active');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-000000000002', true);

-- (1)-(3) One edition held: nothing to say.
select lives_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 5, 'Lovely', 'en')$$, 'a reader with one edition just reviews the work');
select is((select edition_id from public.book_reviews where profile_id = (select english_id from t_p)), 'e9400000-0000-0000-0000-000000000001'::uuid, 'and the review is pinned to that edition');
select is(public.get_my_book_review('e9300000-0000-0000-0000-000000000001') ->> 'rating', '5', 'they read it back the same way');

-- (4)-(5) Naming an edition they do not hold is the same refusal as holding none.
select throws_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 4, 'Nope', 'en', 'e9400000-0000-0000-0000-000000000002')$$, 'EB034', null, 'reviewing an edition they do not hold is refused');
select throws_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 4, 'Nope', 'en', 'e9400000-0000-0000-0000-0000000000ff')$$, 'P0002', null, 'an edition of some other work is not an edition of this one');

-- (6)-(12) Two editions held: the reader must choose, and the two reviews are independent.
select set_config('request.jwt.claim.sub', 'e9100000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 5, 'Which?', 'en')$$, 'EB042', null, 'with two editions held, an unnamed review is refused');
select lives_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 5, 'The English is crisp', 'en', 'e9400000-0000-0000-0000-000000000001')$$, 'they review English');
select lives_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 2, 'The Japanese drops a chapter', 'en', 'e9400000-0000-0000-0000-000000000002')$$, 'and Japanese');
select is((select count(*) from public.book_reviews where profile_id = (select both_id from t_p)), 2::bigint, 'two reviews, one per edition');
select is(public.get_my_book_review('e9300000-0000-0000-0000-000000000001', 'e9400000-0000-0000-0000-000000000002') ->> 'rating', '2', 'each reads back on its own');
select lives_ok($$select public.submit_book_review('e9300000-0000-0000-0000-000000000001', 3, 'Revised', 'en', 'e9400000-0000-0000-0000-000000000002')$$, 'revising one edition''s review updates it in place');
select is((select count(*) from public.book_reviews where profile_id = (select both_id from t_p)), 2::bigint, 'still two reviews');

-- (13)-(14) Deleting one leaves the other.
select lives_ok($$select public.delete_book_review('e9300000-0000-0000-0000-000000000001', 'e9400000-0000-0000-0000-000000000002')$$, 'one edition''s review is deleted');
select is((select edition_id from public.book_reviews where profile_id = (select both_id from t_p)), 'e9400000-0000-0000-0000-000000000001'::uuid, 'the other survives');

-- (15)-(17) The public read names the language.
reset role;
update public.book_reviews set status = 'published', published_at = now() where profile_id = (select both_id from t_p);
set local role anon;
select is(public.catalog_book_reviews('e9300000-0000-0000-0000-000000000001', 5) -> 0 ->> 'languageCode', 'en', 'a published review says which edition it is about');
reset role;
select ok(not has_function_privilege('anon', 'public.submit_book_review(uuid, integer, text, text, uuid)', 'execute'), 'anon cannot submit');
select ok(not has_function_privilege('authenticated', 'public.press_review_edition(uuid, uuid, uuid)', 'execute'), 'the resolver is internal');

select * from finish();
rollback;
