begin;
select plan(9);

-- Ask-the-author off per author: the public read answers false and submit_reader_question
-- refuses the book with the same P0002 an unpublished book gets. Ideas are unaffected.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000071', 'authenticated', 'authenticated', 's13-aq-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.authors (id, canonical_slug, display_name, status, accepts_questions) values
  ('e1330000-0000-0000-0000-000000000071', 's13-aq-open', 'Open Author', 'published', true),
  ('e1330000-0000-0000-0000-000000000072', 's13-aq-closed', 'Closed Author', 'published', false);
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e1320000-0000-0000-0000-000000000071', 's13-aq-open-book', 'vi', 'e1330000-0000-0000-0000-000000000071', 'published'),
  ('e1320000-0000-0000-0000-000000000072', 's13-aq-closed-book', 'vi', 'e1330000-0000-0000-0000-000000000072', 'published'),
  ('e1320000-0000-0000-0000-000000000073', 's13-aq-draft-book', 'vi', 'e1330000-0000-0000-0000-000000000071', 'draft');

select is((select accepts_questions from public.authors where id = 'e1330000-0000-0000-0000-000000000071'), true, 'authors accept questions by default');
select is(has_function_privilege('anon', 'public.catalog_book_accepts_questions(uuid)', 'EXECUTE'), true, 'anon can read the flag');
select is(has_column_privilege('authenticated', 'public.authors', 'accepts_questions', 'UPDATE'), true, 'the admin editor can write the flag (column grant)');
select is(has_table_privilege('authenticated', 'public.authors', 'UPDATE'), false, 'still no table-level update on authors');

set local role anon;
select is(public.catalog_book_accepts_questions('e1320000-0000-0000-0000-000000000071'), true, 'an open author''s published book takes questions');
select is(public.catalog_book_accepts_questions('e1320000-0000-0000-0000-000000000072'), false, 'a closed author''s book does not');
select is(public.catalog_book_accepts_questions('e1320000-0000-0000-0000-000000000073'), false, 'a draft book does not, whatever the author says');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000071', true);
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000071', null, 'Hỏi?', 'vi')$$, 'open author: question accepted');
select throws_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000072', null, 'Hỏi?', 'vi')$$, 'P0002', null, 'closed author: question refused');

select * from finish();
rollback;
