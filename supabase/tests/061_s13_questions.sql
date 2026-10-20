begin;
select plan(27);

-- S13 reader questions: private to the asker and admins, 5 open questions per reader (EB035),
-- no direct writes, answer link only when the answer idea is published and localized in the
-- question's locale.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000021', 'authenticated', 'authenticated', 's13-q-reader1@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000022', 'authenticated', 'authenticated', 's13-q-reader2@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000023', 'authenticated', 'authenticated', 's13-q-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1300000-0000-0000-0000-000000000023';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000021', 's13-q-author', 'S13 Q Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status) values
  ('e1320000-0000-0000-0000-000000000021', 's13-q-book', 'vi', 'e1330000-0000-0000-0000-000000000021', 'published'),
  ('e1320000-0000-0000-0000-000000000022', 's13-q-book-draft', 'vi', 'e1330000-0000-0000-0000-000000000021', 'draft');
insert into public.book_localizations (book_id, locale, slug, title) values
  ('e1320000-0000-0000-0000-000000000021', 'vi', 's13-q-book', 'Sách S13'),
  ('e1320000-0000-0000-0000-000000000022', 'vi', 's13-q-book-draft', 'Nháp S13');

-- 21 published idea (target), 22 draft idea, 23 answer idea (draft at first), 24 published but en-only.
insert into public.ideas (id, status) values
  ('e1360000-0000-0000-0000-000000000021', 'published'),
  ('e1360000-0000-0000-0000-000000000022', 'draft'),
  ('e1360000-0000-0000-0000-000000000023', 'draft'),
  ('e1360000-0000-0000-0000-000000000024', 'published');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer) values
  ('e1360000-0000-0000-0000-000000000021', 'vi', 's13-q-idea', 'Ý tưởng S13?', 'Trả lời ngắn'),
  ('e1360000-0000-0000-0000-000000000022', 'vi', 's13-q-idea-draft', 'Ý tưởng nháp?', 'Trả lời ngắn'),
  ('e1360000-0000-0000-0000-000000000023', 'vi', 's13-q-answer', 'Câu trả lời?', 'Trả lời ngắn'),
  ('e1360000-0000-0000-0000-000000000024', 'en', 's13-q-answer-en', 'English answer?', 'Short answer');

-- Asking ------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000021', true);
select throws_ok($$select public.submit_reader_question(null, null, 'Hỏi gì?', 'vi')$$, '22023', null, 'a question needs a target');
select throws_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000022', null, 'Hỏi gì?', 'vi')$$, 'P0002', null, 'a draft book is not a target');
select throws_ok($$select public.submit_reader_question(null, 'e1360000-0000-0000-0000-000000000022', 'Hỏi gì?', 'vi')$$, 'P0002', null, 'a draft idea is not a target');
select throws_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, '<a>x</a>', 'vi')$$, '22023', null, 'html is refused');
select throws_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, repeat('a', 501), 'vi')$$, '22023', null, '501 characters is refused');
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, 'Câu 1', 'vi')$$, 'book question');
select lives_ok($$select public.submit_reader_question(null, 'e1360000-0000-0000-0000-000000000021', 'Câu 2', 'vi')$$, 'idea question');
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', 'e1360000-0000-0000-0000-000000000021', 'Câu 3', 'vi')$$, 'both targets');
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, 'Câu 4', 'vi')$$, 'fourth');
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, 'Câu 5', 'vi')$$, 'fifth');
select throws_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, 'Câu 6', 'vi')$$, 'EB035', null, 'the sixth open question is refused');

-- Reading -----------------------------------------------------------------------------------------
select is(jsonb_array_length(public.get_my_reader_questions()), 5, 'the asker lists five');
-- now() is frozen in this transaction, so created_at ties fall to the id tiebreak; backdate to make order observable.
reset role;
update public.reader_questions set created_at = now() + right(body, 1)::int * interval '1 minute'
where profile_id = (select id from public.profiles where auth_user_id = 'e1300000-0000-0000-0000-000000000021');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000021', true);
select is(public.get_my_reader_questions() -> 0 ->> 'body', 'Câu 5', 'newest first');
select is(public.get_my_reader_questions() -> 4 ->> 'body', 'Câu 1', 'oldest last');
select is(public.get_my_reader_questions() -> 0 -> 'target' ->> 'title', 'Sách S13', 'book target title');
select is(public.get_my_reader_questions() -> 0 -> 'answer', 'null'::jsonb, 'no answer yet');
select results_eq($$select count(*) from public.reader_questions$$, array[5::bigint], 'the asker reads own rows through RLS');
select throws_ok($$insert into public.reader_questions (profile_id, book_id, body, locale) select id, 'e1320000-0000-0000-0000-000000000021', 'x', 'vi' from public.profiles$$, '42501', null, 'no direct insert');

select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000022', true);
select results_eq($$select count(*) from public.reader_questions$$, array[0::bigint], 'another reader sees none');
select is(jsonb_array_length(public.get_my_reader_questions()), 0, 'another reader lists none');
reset role;

-- Archiving one frees the cap (status flipped directly as a fixture; the admin RPC is Task 9).
update public.reader_questions set status = 'archived' where body = 'Câu 1';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000021', true);
select lives_ok($$select public.submit_reader_question('e1320000-0000-0000-0000-000000000021', null, 'Câu 6', 'vi')$$, 'the cap counts only new questions');
reset role;

-- Answer link -------------------------------------------------------------------------------------
-- Câu 2 (idea target) is answered by a draft idea; Câu 3 by a published idea with no vi localization.
update public.reader_questions set status = 'answered', answer_idea_id = 'e1360000-0000-0000-0000-000000000023', answered_at = now() where body = 'Câu 2';
update public.reader_questions set status = 'answered', answer_idea_id = 'e1360000-0000-0000-0000-000000000024', answered_at = now() where body = 'Câu 3';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000021', true);
select is((select e -> 'answer' from jsonb_array_elements(public.get_my_reader_questions()) e where e ->> 'body' = 'Câu 2'), 'null'::jsonb, 'a draft answer idea gives no link');
select is((select e -> 'answer' from jsonb_array_elements(public.get_my_reader_questions()) e where e ->> 'body' = 'Câu 3'), 'null'::jsonb, 'an answer idea not localized in the question locale gives no link');
select is((select e -> 'target' ->> 'title' from jsonb_array_elements(public.get_my_reader_questions()) e where e ->> 'body' = 'Câu 2'), 'Ý tưởng S13?', 'idea target title is the idea question');
reset role;
update public.ideas set status = 'published' where id = 'e1360000-0000-0000-0000-000000000023';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000021', true);
select is((select e -> 'answer' ->> 'slug' from jsonb_array_elements(public.get_my_reader_questions()) e where e ->> 'body' = 'Câu 2'), 's13-q-answer', 'a published, localized answer idea gives its slug');

-- Admin --------------------------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000023', true);
select results_eq($$select count(*) from public.reader_questions$$, array[6::bigint], 'an admin reads every question through RLS');
reset role;

select is(has_function_privilege('anon', 'public.submit_reader_question(uuid, uuid, text, text)', 'EXECUTE'), false, 'anon cannot ask');

select * from finish();
rollback;
