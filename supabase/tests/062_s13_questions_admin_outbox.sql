begin;
select plan(54);

-- S13 question answering (spec section 6) and the answer notification (spec section 9):
-- is_admin() gate, new/answered/archived transitions, the answering idea's relations, ids-only
-- audit rows, one outbox row per question when the answering idea is published, the three-way
-- outbox target check, and claim_notification_outbox returning question_id.

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000031', 'authenticated', 'authenticated', 's13-qa-reader@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'e1300000-0000-0000-0000-000000000033', 'authenticated', 'authenticated', 's13-qa-admin@example.test', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());
update public.profiles set display_name = 'Bạn đọc S13' where auth_user_id = 'e1300000-0000-0000-0000-000000000031';
insert into public.user_roles (profile_id, role)
select id, 'admin' from public.profiles where auth_user_id = 'e1300000-0000-0000-0000-000000000033';

insert into public.authors (id, canonical_slug, display_name, status)
values ('e1330000-0000-0000-0000-000000000031', 's13-qa-author', 'S13 QA Author', 'published');
insert into public.books (id, canonical_key, original_language, primary_author_id, status)
values ('e1320000-0000-0000-0000-000000000031', 's13-qa-book', 'vi', 'e1330000-0000-0000-0000-000000000031', 'published');
insert into public.book_localizations (book_id, locale, slug, title)
values ('e1320000-0000-0000-0000-000000000031', 'vi', 's13-qa-book', 'Sách S13 QA');

-- 31: the asked idea (published, related to the book). 32: an existing draft idea.
insert into public.ideas (id, status) values
  ('e1360000-0000-0000-0000-000000000031', 'published'),
  ('e1360000-0000-0000-0000-000000000032', 'draft');
insert into public.idea_localizations (idea_id, locale, slug, question, short_answer) values
  ('e1360000-0000-0000-0000-000000000031', 'vi', 's13-qa-asked', 'Ý tưởng được hỏi?', 'Trả lời ngắn'),
  ('e1360000-0000-0000-0000-000000000032', 'vi', 's13-qa-draft', 'Ý tưởng nháp?', 'Trả lời ngắn');
insert into public.idea_books (idea_id, book_id, position)
values ('e1360000-0000-0000-0000-000000000031', 'e1320000-0000-0000-0000-000000000031', 1);

-- The reader asks four questions, then each is pinned to a fixed id by its body.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000031', true);
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi về sách?', 'vi');
select public.submit_reader_question(null, 'e1360000-0000-0000-0000-000000000031', 'Hỏi về ý tưởng?', 'vi');
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi muộn?', 'vi');
select public.submit_reader_question('e1320000-0000-0000-0000-000000000031', null, 'Hỏi để lưu trữ?', 'vi');
reset role;
update public.reader_questions q set id = v.id::uuid
from (values
  ('Hỏi về sách?', 'e1370000-0000-0000-0000-000000000031'),     -- q_book
  ('Hỏi về ý tưởng?', 'e1370000-0000-0000-0000-000000000032'),  -- q_idea
  ('Hỏi muộn?', 'e1370000-0000-0000-0000-000000000033'),        -- q_late
  ('Hỏi để lưu trữ?', 'e1370000-0000-0000-0000-000000000034')   -- q_arch
) as v(body, id)
where q.body = v.body;

-- Privileges --------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000031', true);
select throws_ok($$select public.admin_archive_question('e1370000-0000-0000-0000-000000000034')$$, '42501', null, 'a reader cannot archive');
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000031')$$, '42501', null, 'a reader cannot link an answer');
select throws_ok($$select public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000031', 'vi', 's13-qa-x', 'X?', 'X.')$$, '42501', null, 'a reader cannot answer with a new idea');
select is(public.admin_list_questions('new'), null, 'a reader gets null from the admin list');
reset role;
select is(
  (select bool_or(has_function_privilege('anon', f, 'execute')) from unnest(array[
    'public.admin_list_questions(text)', 'public.admin_archive_question(uuid)',
    'public.admin_answer_question(uuid, uuid)', 'public.admin_answer_question_with_idea(uuid, text, text, text, text)']) f),
  false, 'anon cannot execute any question admin RPC');
select is(
  (select array_agg(has_function_privilege(r, 'public.claim_notification_outbox(integer, uuid)', 'execute') order by r)
   from unnest(array['anon', 'authenticated', 'service_role']) r),
  array[false, false, true], 'only service_role can claim the outbox');

-- Listing -----------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000033', true);
select is(jsonb_array_length(public.admin_list_questions('new')), 4, 'admin lists new questions');
select is(
  (select e - 'createdAt' from jsonb_array_elements(public.admin_list_questions('new')) e where e ->> 'id' = 'e1370000-0000-0000-0000-000000000031'),
  jsonb_build_object('id', 'e1370000-0000-0000-0000-000000000031', 'body', 'Hỏi về sách?', 'locale', 'vi', 'status', 'new',
    'askerName', 'Bạn đọc S13', 'bookId', 'e1320000-0000-0000-0000-000000000031', 'bookTitle', 'Sách S13 QA',
    'ideaId', null, 'ideaQuestion', null, 'answerIdeaId', null),
  'a book question row carries the asker name and the book title');
select is(
  (select e ->> 'ideaQuestion' from jsonb_array_elements(public.admin_list_questions('new')) e where e ->> 'id' = 'e1370000-0000-0000-0000-000000000032'),
  'Ý tưởng được hỏi?', 'an idea question row carries the asked idea''s question');
select is(jsonb_array_length(public.admin_list_questions('answered')), 0, 'no answered questions yet');

-- Archiving ---------------------------------------------------------------------------------------
select lives_ok($$select public.admin_archive_question('e1370000-0000-0000-0000-000000000034')$$, 'admin archives a new question');
select results_eq($$select status from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000034'$$, array['archived'], 'the question is archived');
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000034', 'e1360000-0000-0000-0000-000000000031')$$, 'P0002', null, 'an archived question cannot be linked to an answer');
select throws_ok($$select public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000034', 'vi', 's13-qa-arch', 'A?', 'A.')$$, 'P0002', null, 'an archived question cannot be answered with a new idea');
select throws_ok($$select public.admin_archive_question('e1370000-0000-0000-0000-000000000034')$$, '22023', null, 'an archived question cannot be archived again');
select throws_ok($$select public.admin_archive_question('e1370000-0000-0000-0000-0000000000ff')$$, 'P0002', null, 'a missing question cannot be archived');
select results_eq(
  $$select action, metadata from public.audit_logs where entity_id = 'e1370000-0000-0000-0000-000000000034'$$,
  $$values ('reader_question.archive', '{}'::jsonb)$$, 'one archive audit row, no body');

-- Answering a book question with a new idea -------------------------------------------------------
select isnt(public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000031', 'vi', 's13-qa-tra-loi', 'Câu hỏi?', 'Trả lời ngắn.'), null, 'answering creates an idea');
select results_eq($$select status from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031'$$, array['answered'], 'question is answered');
select isnt((select answered_at from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031'), null, 'answered_at is set');
select results_eq(
  $$select i.status::text, il.slug from public.ideas i join public.idea_localizations il on il.idea_id = i.id
    where i.id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031')$$,
  $$values ('draft', 's13-qa-tra-loi')$$, 'the new idea is a localized draft');
select results_eq(
  $$select ib.book_id, ib.position from public.idea_books ib join public.reader_questions q on q.answer_idea_id = ib.idea_id where q.id = 'e1370000-0000-0000-0000-000000000031'$$,
  $$values ('e1320000-0000-0000-0000-000000000031'::uuid, 1)$$, 'the new idea relates to the question''s book');
select results_eq(
  $$select count(*) from public.idea_links il join public.reader_questions q on q.answer_idea_id = il.idea_id where q.id = 'e1370000-0000-0000-0000-000000000031'$$,
  array[0::bigint], 'a book question links no idea');
select results_eq(
  $$select action, metadata from public.audit_logs where entity_id = 'e1370000-0000-0000-0000-000000000031'$$,
  $$select 'reader_question.answer', jsonb_build_object('ideaId', answer_idea_id) from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031'$$,
  'one answer audit row carrying only the idea id');
select results_eq(
  $$select action from public.audit_logs where entity_id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031')$$,
  array['create_idea'], 'admin_create_idea writes its own audit row');
select throws_ok($$select public.admin_archive_question('e1370000-0000-0000-0000-000000000031')$$, '22023', null, 'an answered question cannot be archived');
select throws_ok($$select public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000031', 'vi', 's13-qa-again', 'B?', 'B.')$$, 'P0002', null, 'an answered question is not answered with another new idea');
select throws_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-0000000000ff')$$, 'P0002', null, 'linking a missing idea is refused');

-- Answering an idea question: inherits the asked idea's books and links to it ---------------------
select isnt(public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000032', 'vi', 's13-qa-tra-loi-2', 'Hỏi 2?', 'Đáp 2.'), null, 'second answer');
select results_eq(
  $$select il.related_idea_id, il.position from public.idea_links il join public.reader_questions q on q.answer_idea_id = il.idea_id where q.id = 'e1370000-0000-0000-0000-000000000032'$$,
  $$values ('e1360000-0000-0000-0000-000000000031'::uuid, 1)$$, 'the new idea links to the asked idea');
select results_eq(
  $$select ib.book_id from public.idea_books ib join public.reader_questions q on q.answer_idea_id = ib.idea_id where q.id = 'e1370000-0000-0000-0000-000000000032'$$,
  array['e1320000-0000-0000-0000-000000000031'::uuid], 'the new idea inherits the asked idea''s book');
select is(jsonb_array_length(public.admin_list_questions('answered')), 2, 'admin lists answered questions');
select results_eq($$select count(*) from public.notification_outbox where template_key = 'question_answered'$$, array[0::bigint], 'no mail before publish');
reset role;

-- Publishing emails once --------------------------------------------------------------------------
update public.ideas set status = 'published' where id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031');
select results_eq($$select count(*) from public.notification_outbox where template_key = 'question_answered'$$, array[1::bigint], 'publish inserts exactly one outbox row');
select results_eq(
  $$select o.profile_id, o.payload from public.notification_outbox o where o.question_id = 'e1370000-0000-0000-0000-000000000031'$$,
  $$select q.profile_id, jsonb_build_object('ideaId', q.answer_idea_id) from public.reader_questions q where q.id = 'e1370000-0000-0000-0000-000000000031'$$,
  'the row is addressed to the asker and its payload carries only the idea id');
select isnt((select notified_at from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031'), null, 'notified_at is set');
update public.ideas set status = 'draft' where id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031');
update public.ideas set status = 'published' where id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000031');
select results_eq($$select count(*) from public.notification_outbox where question_id = 'e1370000-0000-0000-0000-000000000031'$$, array[1::bigint], 'republishing does not insert again');

-- Relinking a notified question to a draft idea, then publishing it, never mails twice.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000033', true);
select lives_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000031', 'e1360000-0000-0000-0000-000000000032')$$, 'a notified question can be relinked to a draft idea');
reset role;
select lives_ok($$update public.ideas set status = 'published' where id = 'e1360000-0000-0000-0000-000000000032'$$, 'publishing the relinked idea does not collide with the existing outbox row');
select results_eq($$select count(*) from public.notification_outbox where question_id = 'e1370000-0000-0000-0000-000000000031'$$, array[1::bigint], 'one email per question, even across a relink');
select results_eq(
  $$select action from public.audit_logs where entity_id = 'e1370000-0000-0000-0000-000000000031' order by created_at, id$$,
  array['reader_question.answer', 'reader_question.answer'], 'the relink writes its own answer audit row');

-- Unpublishing the target book changes nothing about answering ------------------------------------
update public.books set status = 'draft' where id = 'e1320000-0000-0000-0000-000000000031';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'e1300000-0000-0000-0000-000000000033', true);
select lives_ok($$select public.admin_answer_question('e1370000-0000-0000-0000-000000000032', 'e1360000-0000-0000-0000-000000000031')$$, 'relinking an answered question to a published idea is allowed');
select isnt(public.admin_answer_question_with_idea('e1370000-0000-0000-0000-000000000033', 'vi', 's13-qa-tra-loi-3', 'Hỏi 3?', 'Đáp 3.'), null, 'a question about an unpublished book can still be answered');
reset role;
select results_eq(
  $$select payload from public.notification_outbox where question_id = 'e1370000-0000-0000-0000-000000000032'$$,
  $$values (jsonb_build_object('ideaId', 'e1360000-0000-0000-0000-000000000031'))$$,
  'linking to an already published idea mails at once');
select isnt((select notified_at from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000032'), null, 'the immediate mail sets notified_at');
select results_eq(
  $$select ib.book_id from public.idea_books ib join public.reader_questions q on q.answer_idea_id = ib.idea_id where q.id = 'e1370000-0000-0000-0000-000000000033'$$,
  array['e1320000-0000-0000-0000-000000000031'::uuid], 'the answer still relates to the unpublished book');
update public.ideas set status = 'published' where id = (select answer_idea_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000033');
select results_eq($$select count(*) from public.notification_outbox where question_id = 'e1370000-0000-0000-0000-000000000033'$$, array[1::bigint], 'and is still mailed when its idea is published');

-- Claim returns question rows ---------------------------------------------------------------------
set local role service_role;
create temporary table t_claim as
select * from public.claim_notification_outbox(25, '00000000-0000-0000-0000-00000000aaaa');
reset role;
select results_eq(
  $$select question_id from t_claim where question_id = 'e1370000-0000-0000-0000-000000000031'$$,
  array['e1370000-0000-0000-0000-000000000031'::uuid], 'the claim returns the book question row');
select results_eq(
  $$select question_id from t_claim where question_id = 'e1370000-0000-0000-0000-000000000032'$$,
  array['e1370000-0000-0000-0000-000000000032'::uuid], 'the claim returns the relinked idea question row');
select results_eq(
  $$select template_key, entitlement_id, gift_id, payload ->> 'ideaId' from t_claim where question_id = 'e1370000-0000-0000-0000-000000000033'$$,
  $$select 'question_answered', null::uuid, null::uuid, answer_idea_id::text from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000033'$$,
  'a claimed question row has no other target and carries the idea id');

-- Target check ------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id, question_id, entitlement_id)
    select 'question_answered', profile_id, id, 'e1340000-0000-0000-0000-000000000031' from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000034'$$,
  '23514', null, 'a row cannot point at two targets');
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id)
    select 'question_answered', profile_id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000034'$$,
  '23514', null, 'a row needs a target');
select throws_ok(
  $$insert into public.notification_outbox (template_key, profile_id, question_id)
    select 'question_unknown', profile_id, id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000034'$$,
  '23514', null, 'an unknown template is refused');
select lives_ok(
  $$insert into public.notification_outbox (template_key, profile_id, question_id)
    select 'question_answered', profile_id, id from public.reader_questions where id = 'e1370000-0000-0000-0000-000000000034'$$,
  'a question row with one target is accepted');

select * from finish();
rollback;
